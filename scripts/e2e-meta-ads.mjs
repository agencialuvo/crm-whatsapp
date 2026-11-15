/**
 * Self-test E2E de comportamiento — conector de la Marketing API de Meta (spec 038, tests/e2e/us-meta-ads.md).
 *
 * Recorre lo que vería el dueño, por los caminos REALES: llegan mensajes de anuncios por el webhook (wa-mock), se
 * conecta la cuenta publicitaria (que prueba el token contra la Graph API del mock), la sincronización corre en
 * segundo plano y Resultados / la tarjeta del contacto muestran Campaña › Conjunto › Anuncio con gasto y costos.
 * También el camino infeliz: token sin `ads_read`, token inválido, caída 5xx, uso de la API al 95 %, enfriamiento del
 * botón «Sincronizar ahora» y desconectar (conserva lo traído).
 *
 * La instancia puede traer datos de otros guiones: las filas por anuncio se comparan por `source_id` de ESTA corrida;
 * los grupos por campaña (los ids de campaña del mock se repiten) solo con comparaciones de inclusión.
 *
 * Uso: node --env-file=.env scripts/e2e-meta-ads.mjs     (pnpm test:e2e:meta-ads)
 * Requiere: `pnpm e2e:cuentas crear` (la cuenta del dueño), app viva con ATRIBUCION=on y los mocks (WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL → wa-mock) y la BD
 * migrada. Capturas en CAPTURAS_DIR (por defecto scratch/meta-ads).
 */
import { chromium } from "playwright";
import postgres from "postgres";
import { existsSync, mkdirSync } from "node:fs";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const PN = "PN-METAADS-1";
const SALIDA = process.env.CAPTURAS_DIR ?? "scratch/meta-ads";
const RUN = String(Date.now()).slice(-6);
const AD = (n) => `ad-e2e${RUN}-${n}`; // termina en dígito: el mock saca de ahí la jerarquía
const GONE = `gone-e2e${RUN}-9`;
const CUENTA = "1234567890";
const CORREO = "automations-e2e@vocero.test";

let failures = 0;
let checks = 0;
const ok = (name, cond, extra = "") => {
  checks++;
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = "";
const jar = new Map(); // las cookies se fusionan: una respuesta con otra Set-Cookie no puede pisar la sesión
async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
  });
  const set = res.headers.getSetCookie?.() ?? [];
  for (const c of set) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
  if (set.length) cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* sin cuerpo */
  }
  return { status: res.status, ok: res.ok, json };
}

const sql = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1 }) : null;
async function limpiar(org) {
  if (!sql || !org) return;
  await sql`delete from meta_ad_spend where organization_id = ${org} and ad_id like 'ad-e2e%'`;
  await sql`delete from meta_ad where organization_id = ${org} and ad_id like 'ad-e2e%'`;
  await sql`delete from meta_ads_settings where organization_id = ${org}`;
}

/** Espera a que `cond` sea verdad (la sincronización corre en segundo plano). */
async function espera(cond, ms = 45000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    const v = await cond();
    if (v) return v;
    await sleep(500);
  }
  return null;
}

let org = "";
let browser = null;
try {
  console.log("== Setup ==");
  // El alta pública exige verificar el correo: se usa la cuenta que crea `pnpm e2e:cuentas crear`.
  let r = await api("/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email: CORREO, password: "password-e2e-123" }) });
  ok("login", r.ok);
  await api("/api/settings/whatsapp", { method: "PUT", body: JSON.stringify({ wabaId: "WABA-METAADS", phoneNumberId: PN, token: "tok-metaads" }) });
  if (sql) {
    const rows = await sql`select organization_id from member where user_id = (select id from "user" where email = ${CORREO}) limit 1`;
    org = rows[0]?.organization_id ?? "";
  }
  await limpiar(org);
  await api("/api/settings/meta-ads", { method: "DELETE" });

  const DIG = String(Date.now()).slice(-5);
  let n = 0;
  const entra = async (nombre, adId, extra = {}) => {
    const res = await api("/api/dev/wa-mock/inbound", {
      method: "POST",
      body: JSON.stringify({
        phoneNumberId: PN,
        waMessageId: `wamid.metaads.${RUN}.${++n}`,
        from: `52155${DIG}${String(n).padStart(2, "0")}`,
        name: nombre,
        text: "Hola, vi su anuncio",
        referral: { source_id: adId, source_type: "ad", headline: `Titular ${adId}`, body: "Texto", media_type: "image", ...extra },
      }),
    });
    if (!res.ok) throw new Error(`inbound respondió ${res.status}`);
  };
  // ad1: 2 conversaciones; ad2, ad3 y uno borrado: 1 cada uno.
  await entra(`Ana ${RUN}`, AD(1));
  await entra(`Beto ${RUN}`, AD(1));
  await entra(`Carla ${RUN}`, AD(2));
  await entra(`Diego ${RUN}`, AD(3));
  await entra(`Elena ${RUN}`, GONE);

  const filas = async (q = "") => (await api(`/api/analytics/ads?${q}`)).json?.ads ?? [];
  const bloque = async (q = "") => (await api(`/api/analytics/ads?${q}`)).json;

  console.log("== Sin credenciales: el CRM sigue como hoy ==");
  r = await api("/api/settings/meta-ads");
  ok("la superficie existe (ATRIBUCION encendida) y no hay cuenta conectada", r.status === 200 && r.json.metaAds === null, `status ${r.status}`);
  let b = await bloque();
  ok("Resultados cuenta las conversaciones por anuncio", (b.ads.find((a) => a.key === AD(1))?.conversations ?? 0) === 2);
  ok("sin credenciales no hay jerarquía ni gasto", b.ads.find((a) => a.key === AD(1))?.campaignName == null && b.ads.find((a) => a.key === AD(1))?.spend == null);
  ok("hierarchy dice: no conectado", b.hierarchy && b.hierarchy.connected === false);

  console.log("== Conectar: el token se prueba antes de guardarse ==");
  r = await api("/api/settings/meta-ads", { method: "PUT", body: JSON.stringify({ adAccountId: "abc", token: "tok-ads" }) });
  ok("una cuenta que no es un número se rechaza", r.status === 422 && r.json?.error?.code === "cuenta_invalida", JSON.stringify(r.json));
  r = await api("/api/settings/meta-ads", { method: "PUT", body: JSON.stringify({ adAccountId: CUENTA }) });
  ok("sin token (y sin uno guardado) se pide", r.status === 422 && r.json?.error?.code === "token_requerido");
  r = await api("/api/settings/meta-ads", { method: "PUT", body: JSON.stringify({ adAccountId: CUENTA, token: "tok-ads-sinads" }) });
  ok("un token sin ads_read se rechaza y el mensaje lo explica", r.status === 422 && r.json?.error?.code === "meta_permission" && /ads_read/.test(r.json.error.message), JSON.stringify(r.json));
  r = await api("/api/settings/meta-ads", { method: "PUT", body: JSON.stringify({ adAccountId: CUENTA, token: "tok-ads-invalid" }) });
  ok("un token inválido se rechaza", r.status === 422 && r.json?.error?.code === "meta_auth", JSON.stringify(r.json));
  r = await api("/api/settings/meta-ads", { method: "PUT", body: JSON.stringify({ adAccountId: CUENTA, token: "tok-ads-fail500" }) });
  ok("una caída de Meta (5xx) se rechaza como transitoria, sin guardar nada", r.status === 422 && r.json?.error?.code === "meta_transient", JSON.stringify(r.json));
  r = await api("/api/settings/meta-ads", { method: "PUT", body: JSON.stringify({ adAccountId: CUENTA, token: "tok-ads-ratelimit" }) });
  ok("el límite de uso de Meta se explica", r.status === 422 && r.json?.error?.code === "meta_rate_limit", JSON.stringify(r.json));
  r = await api("/api/settings/meta-ads");
  ok("nada de lo rechazado quedó guardado", r.json.metaAds === null);

  console.log("== Uso de la API al 95 %: se conecta, pero la sincronización se frena sola ==");
  r = await api("/api/settings/meta-ads", { method: "PUT", body: JSON.stringify({ adAccountId: `act_${CUENTA}`, token: "tok-ads-uso-alto" }) });
  ok("conecta con un token que ve el uso alto", r.ok, JSON.stringify(r.json));
  const pausa = await espera(async () => {
    const v = (await api("/api/settings/meta-ads")).json.metaAds;
    return v?.pausedUntil ? v : null;
  });
  ok("la cabecera de uso real (x-business-use-case-usage) dejó el conector en pausa preventiva", !!pausa, "sin pausa");
  ok("y esa llamada sí trajo datos (el anuncio quedó identificado)", !!(await espera(async () => (await filas()).find((a) => a.key === AD(1))?.campaignName)));

  console.log("== Conectar bien: jerarquía y gasto en segundo plano ==");
  r = await api("/api/settings/meta-ads", { method: "PUT", body: JSON.stringify({ adAccountId: CUENTA, token: "tok-ads-ok-token-9876" }) });
  ok("conecta y devuelve el nombre y la moneda de la cuenta", r.ok && r.json.accountName === "Cuenta publicitaria de prueba" && r.json.currency === "MXN", JSON.stringify(r.json));
  r = await api("/api/settings/meta-ads");
  ok("la vista no revela el token: solo sus últimos 4", r.json.metaAds?.tokenLast4 === "9876" && !JSON.stringify(r.json).includes("tok-ads-ok-token"), JSON.stringify(r.json));
  ok("guardar de nuevo levantó la pausa", r.json.metaAds?.pausedUntil === null && r.json.metaAds?.status === "connected");

  const listo = await espera(async () => {
    const f = await filas();
    const a1 = f.find((a) => a.key === AD(1));
    return a1?.campaignName && a1?.spend ? f : null;
  });
  ok("la sincronización resolvió la jerarquía y el gasto sin que nadie lo pidiera", !!listo);
  b = await bloque();
  const por = Object.fromEntries(b.ads.map((a) => [a.key, a]));
  // Mock: campaña = k % 2, conjunto = `${c}${k % 3}`, gasto diario = 10 + k % 5 + .5
  ok("ad1 → Campaña 1 › Conjunto 11 › nombre del anuncio", por[AD(1)]?.campaignName === "Campaña 1" && por[AD(1)]?.adsetName === "Conjunto 11" && por[AD(1)]?.adName === `Anuncio ${AD(1)}`, JSON.stringify(por[AD(1)]));
  ok("ad2 pertenece a OTRA campaña (la 0)", por[AD(2)]?.campaignId === "camp-0");
  ok("ad3 comparte campaña con ad1 pero no conjunto", por[AD(3)]?.campaignId === "camp-1" && por[AD(3)]?.adsetId !== por[AD(1)]?.adsetId);
  ok("el anuncio borrado en Meta conserva sus conteos y queda sin jerarquía", por[GONE]?.conversations === 1 && por[GONE]?.campaignName == null && por[GONE]?.spend == null);
  const dia = 10 + (1 % 5) + 0.5;
  const dias = por[AD(1)]?.spend / dia;
  ok("el gasto del periodo son días enteros del gasto diario", Number.isInteger(Math.round(dias * 100) / 100) && dias >= 28 && dias <= 31, `gasto ${por[AD(1)]?.spend} = ${dias} días`);
  ok("costo por conversación = gasto ÷ 2", Math.abs(por[AD(1)]?.costPerConversation - por[AD(1)]?.spend / 2) < 0.011, JSON.stringify(por[AD(1)]));
  // Cada contacto nuevo crea su prospecto: el costo es gasto ÷ prospectos; sin prospectos sería «—» (null), nunca 0.
  const l1 = por[AD(1)];
  ok("costo por prospecto = gasto ÷ prospectos (y null si no hubiera)", l1?.leads > 0 ? Math.abs(l1.costPerLead - l1.spend / l1.leads) < 0.011 : l1?.costPerLead === null, JSON.stringify(l1));
  ok("hierarchy conectado, en MXN y con datos", b.hierarchy?.connected && b.hierarchy.currency === "MXN" && b.hierarchy.hasData && !b.hierarchy.problem && !b.hierarchy.mixedCurrency, JSON.stringify(b.hierarchy));

  console.log("== Agrupar y filtrar ==");
  b = await bloque("group=campaign");
  const g1 = b.groups?.find((g) => g.key === "camp-1");
  ok("por campaña: «Campaña 1» junta a ad1 y ad3", !!g1 && g1.ads >= 2 && g1.conversations >= 3 && g1.spend > 0 && g1.costPerConversation > 0, JSON.stringify(g1));
  ok("por campaña: lo no resuelto va a «Sin identificar»", !!b.groups?.find((g) => g.key === "sin-identificar" && g.conversations >= 1));
  b = await bloque("group=adset");
  ok("por conjunto: trae el nombre de su campaña", b.groups?.some((g) => g.key === "camp-1".replace("camp-", "") + "1" || g.campaignName === "Campaña 1"));
  const c1 = await filas("campaignId=camp-1");
  ok("el filtro por campaña deja ad1 y ad3 y saca ad2", c1.some((a) => a.key === AD(1)) && c1.some((a) => a.key === AD(3)) && !c1.some((a) => a.key === AD(2)));
  const sinId = await filas("campaignId=sin-identificar");
  ok("«Sin identificar» deja el anuncio borrado", sinId.some((a) => a.key === GONE) && !sinId.some((a) => a.key === AD(1)));
  r = await api("/api/analytics/ads?group=nivel-raro");
  ok("una agrupación inválida se rechaza (422)", r.status === 422);

  console.log("== La tarjeta del contacto ==");
  const lista = (await api("/api/conversations")).json.conversations;
  const conv = lista.find((c) => c.contact.name === `Ana ${RUN}`);
  const d = (await api(`/api/contacts/${conv.contact.id}`)).json;
  ok("la ficha trae Campaña, Conjunto y Anuncio", d.anuncio?.campaignName === "Campaña 1" && d.anuncio?.adsetName === "Conjunto 11" && d.anuncio?.adName === `Anuncio ${AD(1)}`, JSON.stringify(d.anuncio));
  const convG = lista.find((c) => c.contact.name === `Elena ${RUN}`);
  const dg = (await api(`/api/contacts/${convG.contact.id}`)).json;
  ok("un anuncio no identificado sigue mostrando lo del referral (sin jerarquía)", dg.anuncio?.sourceId === GONE && dg.anuncio?.campaignName == null);

  console.log("== Sincronizar ahora ==");
  r = await api("/api/settings/meta-ads/sync", { method: "POST" });
  const primera = r.status;
  r = await api("/api/settings/meta-ads/sync", { method: "POST" });
  ok("«Sincronizar ahora» tiene enfriamiento de 60 s", (primera === 200 || primera === 429) && r.status === 429, `${primera} / ${r.status}`);

  console.log("== En el navegador ==");
  const candidatos = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"];
  try {
    browser = await chromium.launch();
  } catch {
    const executablePath = candidatos.find((p) => existsSync(p));
    browser = await chromium.launch(executablePath ? { executablePath } : {});
  }
  mkdirSync(SALIDA, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route("**/api/events*", (route) => route.abort());
  await ctx.addInitScript(() => localStorage.setItem("vocero.panelOpen", "true")); // el panel del contacto abierto
  ctx.setDefaultNavigationTimeout(120000);
  ctx.setDefaultTimeout(30000);
  await ctx.addCookies(cookie.split("; ").map((kv) => ({ name: kv.slice(0, kv.indexOf("=")), value: kv.slice(kv.indexOf("=") + 1), url: BASE })));
  // Un negocio recién creado abre «Personaliza tu espacio»: se pospone para ver la pantalla.
  const cierraBienvenida = async (p) => {
    const later = p.getByRole("button", { name: "Configurar más tarde" });
    await later.waitFor({ timeout: 4000 }).catch(() => {});
    // El primer clic puede llegar antes de que la página hidrate y no hacer nada: se repite hasta que cierre.
    for (let i = 0; i < 6 && (await later.count()) > 0; i++) {
      await later.click({ timeout: 5000 }).catch(() => {});
      await sleep(700);
    }
  };
  const quitaDev = (p) => p.addStyleTag({ content: "nextjs-portal { display: none !important; }" }).catch(() => {});

  let page = await ctx.newPage();
  await page.goto(`${BASE}/resultados`, { waitUntil: "domcontentloaded" });
  await cierraBienvenida(page);
  await page.locator("[data-controles-anuncios]").waitFor();
  ok("Resultados muestra los controles de Campaña / Conjunto / Anuncio", true);
  const fila = page.locator(`tr[data-anuncio="${AD(1)}"]`);
  await fila.waitFor();
  ok("la tabla por anuncio muestra la ruta «Campaña 1 › Conjunto 11»", (await fila.locator("[data-jerarquia]").innerText()).includes("Campaña 1 › Conjunto 11"));
  ok("y las columnas de gasto y costo", (await page.getByRole("columnheader", { name: "Gasto" }).count()) === 1 && (await page.getByRole("columnheader", { name: /Costo \/ conv/ }).count()) === 1);
  ok("el gasto sale con moneda", /\$/.test(await fila.innerText()));
  await quitaDev(page);
  await page.locator("#origen").screenshot({ path: `${SALIDA}/resultados-por-anuncio.png` });

  await page.getByRole("button", { name: "Campaña", exact: true }).click();
  await page.getByText("Por campaña").waitFor();
  await page.getByRole("cell", { name: /Campaña 1/ }).first().waitFor();
  ok("al agrupar por campaña la tabla cambia a «Campaña»", (await page.getByRole("columnheader", { name: "Campaña", exact: true }).count()) === 1);
  await quitaDev(page);
  await page.locator("#origen").screenshot({ path: `${SALIDA}/resultados-por-campana.png` });

  await page.getByRole("button", { name: "Conjunto", exact: true }).click();
  await page.getByText("Por conjunto de anuncios").waitFor();
  ok("al agrupar por conjunto dice a qué campaña pertenece", (await page.getByText("Campaña 1 ·", { exact: false }).count()) >= 1);

  await page.getByRole("button", { name: "Anuncio", exact: true }).click();
  await page.getByRole("combobox", { name: "Filtrar por campaña" }).click();
  await page.getByRole("option", { name: "Campaña 0" }).click();
  // La tabla se recarga con el filtro: se espera a que el anuncio de OTRA campaña salga de la tabla.
  await page.locator(`tr[data-anuncio="${AD(1)}"]`).waitFor({ state: "detached" }).catch(() => {});
  await page.locator(`tr[data-anuncio="${AD(2)}"]`).waitFor();
  ok("el filtro por campaña deja solo los anuncios de esa campaña", (await page.locator(`tr[data-anuncio="${AD(1)}"]`).count()) === 0 && (await page.locator(`tr[data-anuncio="${AD(2)}"]`).count()) === 1);

  // Móvil: tarjetas con gasto a la vista y sin desborde.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/resultados`, { waitUntil: "domcontentloaded" });
  await cierraBienvenida(page);
  await page.locator("[data-controles-anuncios]").waitFor();
  ok("en el teléfono no hay desborde horizontal", !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await quitaDev(page);
  await page.locator("#origen").screenshot({ path: `${SALIDA}/resultados-movil.png` });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Tarjeta del contacto en la bandeja.
  await page.goto(`${BASE}/bandeja`, { waitUntil: "domcontentloaded" });
  await cierraBienvenida(page);
  const tarjeta = page.locator("[data-anuncio-origen]").first();
  // La lista se rehidrata y repinta: si el primer clic se pierde, se repite hasta que aparezca el panel.
  for (let i = 0; i < 4 && (await tarjeta.count()) === 0; i++) {
    await page.getByRole("button").filter({ hasText: `Ana ${RUN}` }).first().click({ timeout: 8000 }).catch(() => {});
    await tarjeta.waitFor({ timeout: 8000 }).catch(() => {});
  }
  await page.screenshot({ path: `${SALIDA}/bandeja-estado.png` });
  await tarjeta.waitFor();
  await tarjeta.locator("[data-jerarquia]").waitFor();
  ok("la tarjeta de la bandeja dice «Campaña 1 › Conjunto 11 › Anuncio…»", (await tarjeta.locator("[data-jerarquia]").innerText()).startsWith("Campaña 1 › Conjunto 11 › Anuncio"));
  await quitaDev(page);
  await page.screenshot({ path: `${SALIDA}/bandeja-tarjeta.png` });

  // Ajustes → Anuncios.
  await page.goto(`${BASE}/ajustes/anuncios`, { waitUntil: "domcontentloaded" });
  await cierraBienvenida(page);
  await page.locator("[data-meta-ads]").waitFor();
  const card = page.locator("[data-meta-ads]");
  ok("la tarjeta de Ajustes dice «Conectado» y la cuenta", (await card.getByText("Conectado", { exact: true }).count()) === 1 && (await card.innerText()).includes("Cuenta publicitaria de prueba"));
  ok("no muestra el token, solo ····9876", !(await card.innerText()).includes("tok-ads-ok") && (await card.innerText()).includes("····9876"));
  await quitaDev(page);
  await page.screenshot({ path: `${SALIDA}/ajustes-meta-ads.png` });
  await ctx.close();

  console.log("== Desconectar conserva lo traído ==");
  r = await api("/api/settings/meta-ads", { method: "DELETE" });
  ok("desconectar responde ok", r.ok);
  r = await api("/api/settings/meta-ads");
  ok("ya no hay cuenta conectada", r.json.metaAds === null);
  b = await bloque();
  const a1 = b.ads.find((a) => a.key === AD(1));
  ok("Resultados conserva la jerarquía y el gasto históricos", a1?.campaignName === "Campaña 1" && a1?.spend > 0, JSON.stringify(a1));
  ok("hierarchy: desconectado pero con datos", b.hierarchy?.connected === false && b.hierarchy?.hasData === true);
} catch (e) {
  failures++;
  console.log(`  ✗ la corrida se rompió: ${e?.stack ?? e}`);
} finally {
  await browser?.close().catch(() => {});
  await limpiar(org).catch(() => {});
  await sql?.end().catch(() => {});
}

console.log(`\n${checks - failures}/${checks} comprobaciones OK`);
process.exit(failures === 0 ? 0 : 1);
