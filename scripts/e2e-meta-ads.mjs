/**
 * Self-test E2E de comportamiento — conector de la Marketing API de Meta (spec 038, tests/e2e/us-meta-ads.md) y su
 * ampliación 039: la cuenta publicitaria ENTERA (campañas pausadas, anuncios sin conversaciones, cuadre con la cuenta,
 * relleno por rango), la navegación Campaña › Conjunto › Anuncio por clic con migas de pan y Ajustes → Anuncios en limpio;
 * y la 040: casillas de selección que filtran al cambiar de pestaña, Total de lo marcado y vista previa de los creativos
 * (miniatura real, modal con titular, texto, campaña, conjunto y enlace).
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
  await sql`delete from meta_ad_spend where organization_id = ${org} and (ad_id like 'ad-e2e%' or ad_id like '%acct-%')`;
  await sql`delete from meta_ad where organization_id = ${org} and (ad_id like 'ad-e2e%' or ad_id like '%acct-%')`;
  await sql`delete from meta_account_spend where organization_id = ${org}`;
  await sql`delete from media_asset where organization_id = ${org} and payload->>'origen' = 'catalogo'`;
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
  // Sin un dataset de CAPI de otra corrida: así la pantalla de Ajustes parte de cero y ofrece la lista de la cuenta.
  await api("/api/settings/capi", { method: "DELETE" });

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
    // La sincronización trae el gasto por ventanas de 7 días: se espera a tener los ~30 días del periodo.
    return a1?.campaignName && a1?.spend >= 11.5 * 27 ? f : null;
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

  console.log("== 039: toda la cuenta, también lo que no trajo a nadie ==");
  b = await espera(async () => {
    const x = await bloque("group=campaign");
    return x.groups?.some((g) => g.name === "Campaña Beta (pausada)" && g.spend > 0) ? x : null;
  });
  const beta = b?.groups?.find((g) => g.name === "Campaña Beta (pausada)");
  ok("una campaña PAUSADA con gasto y sin una sola conversación aparece en Resultados", !!beta && beta.conversations === 0 && beta.spend > 0, JSON.stringify(beta));
  ok("lleva su estado en Meta (pausada) y su costo por conversación es «—», no 0", beta?.status === "paused" && beta?.costPerConversation === null);
  ok("la campaña activa sin leads propios también está (Alfa)", !!b?.groups?.find((g) => g.name === "Campaña Alfa" && g.status === "active" && g.spend > 0));
  ok("el total de la cuenta en Meta cuadra con lo desglosado por anuncio", !!b?.hierarchy?.account && b.hierarchy.account.unattributed === null, JSON.stringify(b?.hierarchy?.account));
  ok("el total del pie cuenta todas las filas", (b?.total?.ads ?? 0) >= 4 && b.total.spend > 0, JSON.stringify(b?.total));
  ok("el catálogo trae el anuncio SIN gasto ni conversaciones, pero no lo lista (sin actividad no ocupa fila)", !(await filas()).some((a) => a.key === "acct-ad-5"));
  const sumaGrupos = b?.groups?.reduce((t, g) => t + (g.spend ?? 0), 0) ?? 0;
  ok("la suma de los grupos es el gasto de la cuenta, al centavo", Math.abs(sumaGrupos - (b?.hierarchy?.account?.spend ?? -1)) < 0.011, `${sumaGrupos} vs ${b?.hierarchy?.account?.spend}`);

  const hoyISO = new Date().toISOString().slice(0, 10);
  const hace = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  const listoElRango = await espera(async () => !(await bloque()).hierarchy?.syncing, 170000);
  ok("el gasto de los 30 días se completa solo, pasada tras pasada (no bloquea la pantalla)", !!listoElRango);
  r = await api(`/api/analytics/ads?from=${hace(200)}&to=${hoyISO}&group=campaign`);
  ok("un rango más viejo que lo traído ENCARGA el relleno y la pantalla lo dice (syncing)", r.ok && r.json.hierarchy?.syncing === true, JSON.stringify(r.json?.hierarchy));
  if (sql) {
    const [cfg] = await sql`select spend_backfill_from::text as f from meta_ads_settings where organization_id = ${org}`;
    ok("lo encargado queda anotado en la base (la lectura jamás llamó a Meta)", cfg?.f === hace(200), JSON.stringify(cfg));
  }

  console.log("== 040: varios valores, llaves marcadas y creativos (API) ==");
  const uni = await bloque("group=ad&campaignIds=camp-0,camp-1");
  ok("campaignIds filtra por la UNIÓN de campañas", uni.ads.some((a) => a.key === AD(1)) && uni.ads.some((a) => a.key === AD(2)) && !uni.ads.some((a) => a.key === GONE));
  const sel = await bloque("group=campaign&selected=camp-1,camp-0");
  const todoC = await bloque("group=campaign");
  const suma = (x) => x.groups.filter((g) => ["camp-1", "camp-0"].includes(g.key)).reduce((t, g) => ({ c: t.c + g.conversations, g: t.g + (g.spend ?? 0) }), { c: 0, g: 0 });
  ok("`selected` hace que el Total sea el de las filas marcadas", sel.selectedCount === 2 && sel.total.conversations === suma(sel).c && Math.abs(sel.total.spend - suma(sel).g) < 0.011, JSON.stringify(sel.total));
  ok("sin `selected` el Total es el de toda la vista", todoC.selectedCount === 0 && todoC.total.conversations > sel.total.conversations, `${todoC.total.conversations} vs ${sel.total.conversations}`);
  const fantasma = await bloque("group=campaign&selected=no-existe");
  ok("una selección que ya no existe no deja el Total en ceros", fantasma.selectedCount === 0 && fantasma.total.conversations === todoC.total.conversations);
  r = await api("/api/analytics/ads?group=ad&campaignIds=" + "x,".repeat(101));
  ok("más de 100 ids se rechaza (422)", r.status === 422, `status ${r.status}`);
  const alfa = await bloque("group=ad&campaignIds=acct-camp-a");
  const anuncioAlfa1 = alfa.ads.find((a) => a.key === "acct-ad-1");
  ok("el anuncio sin conversaciones trae su creativo: titular, texto y enlace de Meta", anuncioAlfa1?.conversations === 0 && anuncioAlfa1?.creative?.title === "Corte + barba 2x1" && /paga uno/.test(anuncioAlfa1.creative.body ?? "") && anuncioAlfa1.creative.previewLink === "https://fb.me/mock-acct-ad-1", JSON.stringify(anuncioAlfa1?.creative));
  ok("la imagen se copió al volumen (id de adjunto propio, no una URL de Meta)", /^ma_/.test(anuncioAlfa1?.creative?.assetId ?? "") && !JSON.stringify(anuncioAlfa1.creative).includes("http://") , JSON.stringify(anuncioAlfa1?.creative));
  const img = await fetch(`${BASE}/api/media/${anuncioAlfa1?.creative?.assetId}`, { headers: { cookie } });
  ok("la copia se sirve con sesión (200, image/png)", img.status === 200 && (img.headers.get("content-type") ?? "").startsWith("image/png"), `status ${img.status}`);
  const sinSesion = await fetch(`${BASE}/api/media/${anuncioAlfa1?.creative?.assetId}`);
  ok("y NO sin sesión", sinSesion.status === 401 || sinSesion.status === 403 || sinSesion.status === 404, `status ${sinSesion.status}`);
  ok("un creativo dinámico (sin titular ni texto) conserva su imagen", !!alfa.ads.find((a) => a.key === "acct-ad-3")?.creative?.assetId && alfa.ads.find((a) => a.key === "acct-ad-3").creative.title === null);
  if (sql) {
    const [c2] = await sql`select creative_source_url as u, creative_asset_id as a from meta_ad where organization_id = ${org} and ad_id = 'acct-ad-2'`;
    ok("una imagen que pasa del tope de descarga cae a la miniatura", !!c2?.a && /thumb-acct-ad-2/.test(c2?.u ?? ""), JSON.stringify(c2));
    const [c5] = await sql`select creative_asset_id as a from meta_ad where organization_id = ${org} and ad_id = 'acct-ad-5'`;
    ok("un anuncio sin creativo no genera copia", c5?.a === null);
  }

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
  // Abre un desplegable y comprueba su contenido MIENTRAS está abierto. La página hidrata y repinta (en desarrollo
  // compila bajo demanda), así que un clic puede perderse o la lista cerrarse: se reintenta todo el gesto.
  const conLista = async (p, selector, opcion, comprobar) => {
    for (let i = 0; i < 6; i++) {
      await p.locator(selector).click({ timeout: 8000 }).catch(() => {});
      const abierta = await p.getByRole("option", { name: opcion }).first().waitFor({ timeout: 3000 }).then(() => true).catch(() => false);
      if (abierta) {
        const veredicto = comprobar ? await comprobar() : true;
        if (veredicto) return true;
        // Solo se cierra la lista si estaba abierta: un Escape de más cerraría también el diálogo que la contiene.
        await p.keyboard.press("Escape");
      }
      await sleep(600);
    }
    return false;
  };
  const quitaDev = (p) => p.addStyleTag({ content: "nextjs-portal { display: none !important; }" }).catch(() => {});

  let page = await ctx.newPage();
  await page.goto(`${BASE}/resultados`, { waitUntil: "domcontentloaded" });
  await cierraBienvenida(page);
  await page.locator("[data-controles-anuncios]").waitFor();
  ok("Resultados muestra los controles de Campaña / Conjunto / Anuncio", true);
  // Con la cuenta conectada la vista arranca por campaña, como el Administrador de Anuncios.
  await page.locator('[data-abrir="camp-1"]:visible').waitFor();
  ok("con la cuenta conectada arranca por campaña y los nombres son clicables", (await page.getByRole("columnheader", { name: "Campaña", exact: true }).count()) === 1);
  await page.locator('[data-abrir="acct-camp-b"]:visible').waitFor();
  ok("la campaña pausada y sin conversaciones sale con su insignia «Pausada»", (await page.locator('[data-abrir="acct-camp-b"]:visible').locator("..").locator('[data-estado="paused"]').count()) === 1 || (await page.locator('[data-abrir="acct-camp-b"]:visible [data-estado="paused"]').count()) === 1);
  ok("hay fila de total al pie", (await page.locator("tfoot[data-total]").count()) === 1);
  ok("y el gasto de la cuenta en Meta, sin diferencia que explicar", (await page.locator("[data-gasto-cuenta]").count()) === 1 && (await page.locator("[data-sin-desglosar]").count()) === 0);
  await quitaDev(page);
  await page.locator("#origen").screenshot({ path: `${SALIDA}/resultados-por-campana.png` });

  // Drill-down: campaña → conjuntos → anuncios, con migas de pan.
  await page.locator('[data-abrir="camp-1"]:visible').click();
  await page.locator("[data-migas]").waitFor();
  await page.getByText("Por conjunto de anuncios").waitFor();
  await page.locator('[data-abrir="adset-11"]:visible').waitFor();
  ok("clic en una campaña baja a sus Conjuntos", (await page.getByRole("columnheader", { name: "Conjunto", exact: true }).count()) === 1);
  ok("las migas dicen «Todas las campañas › Campaña 1»", (await page.locator("[data-migas]").innerText()).replace(/\s+/g, " ").includes("Todas las campañas › Campaña 1"));
  await page.locator('[data-abrir="adset-11"]:visible').waitFor();
  ok("solo salen los conjuntos de esa campaña", (await page.locator('[data-abrir="acct-set-3"]:visible').count()) === 0);
  await quitaDev(page);
  await page.locator("#origen").screenshot({ path: `${SALIDA}/resultados-conjuntos-de-campana.png` });

  await page.locator('[data-abrir="adset-11"]:visible').click();
  await page.locator(`tr[data-anuncio="${AD(1)}"]`).waitFor();
  ok("clic en un conjunto baja a sus Anuncios", (await page.getByRole("columnheader", { name: "Anuncio", exact: true }).count()) === 1);
  ok("las migas ahora tienen tres tramos", (await page.locator("[data-migas] li").count()) === 3);
  ok("y la tabla trae solo los anuncios de ese conjunto", (await page.locator(`tr[data-anuncio="${AD(2)}"]`).count()) === 0);
  const campanaFiltrada = await page.getByRole("combobox", { name: "Filtrar por campaña" }).innerText();
  ok("los selectores siguen la navegación (campaña y conjunto elegidos)", /Campaña 1/.test(campanaFiltrada));
  await quitaDev(page);
  await page.locator("#origen").screenshot({ path: `${SALIDA}/resultados-anuncios-de-conjunto.png` });

  // Una miga vuelve atrás.
  await page.locator("[data-migas]").getByRole("button", { name: "Campaña 1" }).click();
  await page.locator('[data-abrir="adset-11"]:visible').waitFor();
  ok("la miga de la campaña vuelve a sus conjuntos", (await page.locator("[data-migas] li").count()) === 2);
  await page.locator("[data-migas]").getByRole("button", { name: "Todas las campañas" }).click();
  await page.locator('[data-abrir="acct-camp-b"]:visible').waitFor();
  ok("«Todas las campañas» quita los filtros y las migas desaparecen", (await page.locator("[data-migas]").count()) === 0);

  // Las pestañas a mano: subir limpia lo de abajo.
  await page.getByRole("button", { name: "Anuncio", exact: true }).click();
  await page.locator(`tr[data-anuncio="${AD(1)}"]`).waitFor();
  ok("la pestaña «Anuncio» lista los anuncios con su ruta «Campaña 1 › Conjunto 11»", (await page.locator(`tr[data-anuncio="${AD(1)}"] [data-jerarquia]`).innerText()).includes("Campaña 1 › Conjunto 11"));
  ok("y las columnas de gasto y costo", (await page.getByRole("columnheader", { name: "Gasto" }).count()) === 1 && (await page.getByRole("columnheader", { name: /Costo \/ conv/ }).count()) === 1);
  ok("el gasto sale con moneda", /\$/.test(await page.locator(`tr[data-anuncio="${AD(1)}"]`).innerText()));
  await quitaDev(page);
  await page.locator("#origen").screenshot({ path: `${SALIDA}/resultados-por-anuncio.png` });

  await page.getByRole("button", { name: "Conjunto", exact: true }).click();
  await page.getByText("Por conjunto de anuncios").waitFor();
  ok("al agrupar por conjunto dice a qué campaña pertenece", (await page.getByText("Campaña 1 ·", { exact: false }).count()) >= 1);

  // El selector de campaña equivale al clic.
  await page.getByRole("button", { name: "Anuncio", exact: true }).click();
  await page.getByRole("combobox", { name: "Filtrar por campaña" }).click();
  await page.getByRole("option", { name: "Campaña 0" }).click();
  await page.locator(`tr[data-anuncio="${AD(1)}"]`).waitFor({ state: "detached" }).catch(() => {});
  await page.locator(`tr[data-anuncio="${AD(2)}"]`).waitFor();
  ok("el filtro por campaña deja solo los anuncios de esa campaña", (await page.locator(`tr[data-anuncio="${AD(1)}"]`).count()) === 0 && (await page.locator(`tr[data-anuncio="${AD(2)}"]`).count()) === 1);
  ok("y aparecen las migas con esa campaña", (await page.locator("[data-migas]").innerText()).includes("Campaña 0"));

  // ── 040: casillas ──
  console.log("== 040: casillas que filtran al cambiar de pestaña ==");
  await page.goto(`${BASE}/resultados`, { waitUntil: "domcontentloaded" });
  await cierraBienvenida(page);
  await page.locator('[data-casilla="camp-1"]:visible').waitFor();
  ok("cada fila de campaña lleva su casilla y la cabecera una maestra", (await page.locator('[data-casilla="todas"]:visible').count()) === 1);
  ok("el Total dice «Total» mientras no haya nada marcado", ((await page.locator("[data-total-rotulo]").innerText()).trim()) === "Total" && (await page.locator("[data-pildora-seleccion]").count()) === 0);
  const totalAntes = await page.locator("tfoot[data-total] td").nth(2).innerText();
  await page.locator('[data-casilla="camp-1"]:visible').check();
  await page.locator('[data-casilla="camp-0"]:visible').check();
  await page.locator("[data-pildora-seleccion]").waitFor();
  ok("la píldora dice «2 campañas seleccionadas»", (await page.locator("[data-pildora-seleccion]").innerText()).includes("2 campañas seleccionadas"));
  await page.locator("[data-total-rotulo]", { hasText: "2 seleccionadas" }).waitFor();
  const totalDespues = await page.locator("tfoot[data-total] td").nth(2).innerText();
  ok("el Total se recalcula con lo marcado y su rótulo lo dice", totalAntes !== totalDespues && Number(totalDespues) === sel.total.conversations, `${totalAntes} → ${totalDespues} (API ${sel.total.conversations})`);
  await quitaDev(page);
  await page.locator("#origen").screenshot({ path: `${SALIDA}/seleccion-campanas.png` });

  await page.getByRole("button", { name: "Conjunto", exact: true }).click();
  await page.locator("[data-pildora-filtro]").waitFor();
  await page.locator('[data-abrir="adset-11"]:visible').waitFor();
  ok("al pasar a Conjunto la tabla muestra SOLO los conjuntos de las campañas marcadas", (await page.locator('[data-abrir="acct-set-3"]:visible').count()) === 0 && (await page.locator('[data-abrir="adset-11"]:visible').count()) === 1);
  ok("y una píldora dice de dónde viene el filtro", (await page.locator("[data-pildora-filtro]").innerText()).includes("Conjuntos de 2 campañas"));
  await page.getByRole("button", { name: "Campaña", exact: true }).click();
  await page.locator('[data-casilla="camp-1"]:visible').waitFor();
  ok("volver a Campaña CONSERVA las casillas marcadas", (await page.locator('[data-casilla="camp-1"]:visible').isChecked()) && (await page.locator('[data-casilla="camp-0"]:visible').isChecked()));
  await page.getByRole("button", { name: "Conjunto", exact: true }).click();
  await page.locator('[data-abrir="adset-11"]:visible').waitFor();

  // La casilla maestra marca todas las filas visibles y las desmarca.
  await page.locator('[data-casilla="todas"]:visible').check();
  const nFilas = await page.locator("tbody [data-casilla]:visible").count();
  await page.locator("[data-pildora-seleccion]", { hasText: `${nFilas} conjuntos seleccionados` }).waitFor();
  ok("la casilla maestra marca todos los conjuntos visibles", nFilas >= 2 && (await page.locator("tbody [data-casilla]:visible:checked").count()) === nFilas);
  await page.locator('[data-casilla="todas"]:visible').uncheck();
  await page.locator("[data-pildora-seleccion]").waitFor({ state: "detached" });
  ok("y los desmarca", (await page.locator("tbody [data-casilla]:visible:checked").count()) === 0);

  await page.locator('[data-casilla="adset-11"]:visible').check();
  await page.getByRole("button", { name: "Anuncio", exact: true }).click();
  await page.locator(`tr[data-anuncio="${AD(1)}"]`).waitFor();
  ok("marcar un conjunto y pasar a Anuncio deja solo sus anuncios", (await page.locator(`tr[data-anuncio="${AD(1)}"]`).count()) === 1 && (await page.locator(`tr[data-anuncio="${AD(2)}"]`).count()) === 0);
  ok("la píldora dice «Anuncios de 1 conjunto»", (await page.locator("[data-pildora-filtro]").innerText()).includes("Anuncios de 1 conjunto"));
  await page.locator("[data-pildora-filtro]").getByRole("button", { name: "Quitar" }).click();
  await page.locator(`tr[data-anuncio="${AD(2)}"]`).waitFor();
  ok("«Quitar» deja los anuncios de las campañas marcadas (vuelve a salir el de la otra campaña)", (await page.locator(`tr[data-anuncio="${AD(1)}"]`).count()) === 1 && (await page.locator(`tr[data-anuncio="${AD(2)}"]`).count()) === 1);

  // Marcar anuncios cambia solo el Total.
  await page.locator(`tr[data-anuncio="${AD(1)}"] [data-casilla]`).check();
  await page.locator("[data-total-rotulo]", { hasText: "1 seleccionado" }).waitFor();
  const filasAntes = await page.locator("tbody tr[data-anuncio]:visible").count();
  ok("marcar un anuncio cambia el Total pero no las filas", filasAntes >= 2 && Number(await page.locator("tfoot[data-total] td").nth(2).innerText()) === 2);
  await page.locator("[data-pildora-seleccion]").getByRole("button", { name: "Limpiar" }).click();
  await page.locator("[data-total-rotulo]", { hasText: /^Total$/ }).waitFor();
  ok("«Limpiar» quita las casillas y el Total vuelve al de toda la vista", (await page.locator("[data-pildora-seleccion]").count()) === 0);

  // ── 040: creativos ──
  console.log("== 040: creativos de los anuncios ==");
  await page.goto(`${BASE}/resultados`, { waitUntil: "domcontentloaded" });
  await cierraBienvenida(page);
  await page.locator('[data-casilla="acct-camp-a"]:visible').check();
  await page.getByRole("button", { name: "Anuncio", exact: true }).click();
  await page.locator('tr[data-anuncio="acct-ad-1"]').waitFor();
  ok("el anuncio sin conversaciones muestra la MINIATURA real, no el megáfono", (await page.locator('tr[data-anuncio="acct-ad-1"] img[src^="/api/media/"]').count()) === 1);
  const cargada = await page.locator('tr[data-anuncio="acct-ad-1"] img[src^="/api/media/"]').evaluate((el) => new Promise((res) => (el.complete ? res(el.naturalWidth > 0) : (el.onload = () => res(true), el.onerror = () => res(false)))));
  ok("y la imagen carga de verdad (la copia local se sirve)", cargada === true);
  ok("un anuncio borrado en Meta (sin creativo) conserva el megáfono", (await page.locator('tr[data-anuncio="gone-acct-9"] img').count()) === 0 && (await page.locator('tr[data-anuncio="gone-acct-9"]').count()) === 1);
  await quitaDev(page);
  await page.locator("#origen").screenshot({ path: `${SALIDA}/creativos-en-la-tabla.png` });

  await page.locator('[data-preview="acct-ad-1"]:visible').click();
  await page.locator("[data-preview-anuncio]").waitFor();
  ok("clic en la miniatura abre el modal con el TITULAR del creativo", (await page.locator("[data-preview-titular]").innerText()) === "Corte + barba 2x1");
  ok("el TEXTO principal", (await page.locator("[data-preview-texto]").innerText()).includes("llega con un amigo y paga uno"));
  ok("la CAMPAÑA y el CONJUNTO", (await page.locator("[data-preview-campana]").innerText()) === "Campaña Alfa" && (await page.locator("[data-preview-conjunto]").innerText()) === "Conjunto Alfa 1");
  ok("la imagen en grande se carga", await page.locator("[data-preview-imagen]").evaluate((el) => new Promise((res) => (el.complete ? res(el.naturalWidth > 0) : (el.onload = () => res(true), el.onerror = () => res(false))))));
  const enlace = page.locator("[data-preview-enlace]");
  ok("el enlace a la vista previa de Meta abre fuera, sin darle control a la página", (await enlace.getAttribute("href")) === "https://fb.me/mock-acct-ad-1" && (await enlace.getAttribute("target")) === "_blank" && /noopener/.test((await enlace.getAttribute("rel")) ?? ""));
  await quitaDev(page);
  await page.screenshot({ path: `${SALIDA}/creativo-modal.png` });
  await page.keyboard.press("Escape");
  await page.locator("[data-preview-anuncio]").waitFor({ state: "detached" });
  ok("Escape cierra el modal", true);
  await page.locator('[data-preview-boton="acct-ad-1"]:visible').click();
  await page.locator("[data-preview-anuncio]").waitFor();
  await page.getByRole("dialog").getByRole("button", { name: /cerrar/i }).first().click();
  await page.locator("[data-preview-anuncio]").waitFor({ state: "detached" });
  ok("el icono de ojo también abre la vista previa, y la X la cierra", true);

  await page.locator('[data-preview-boton="acct-ad-3"]:visible').click();
  await page.locator("[data-preview-anuncio]").waitFor();
  ok("un creativo dinámico (sin titular ni texto) enseña la imagen y no inventa textos", (await page.locator("[data-preview-imagen]").count()) === 1 && (await page.locator("[data-preview-titular]").count()) === 0 && (await page.locator("[data-preview-texto]").count()) === 0);
  await page.keyboard.press("Escape");

  await page.locator('[data-preview-boton="gone-acct-9"]:visible').click();
  await page.locator("[data-preview-anuncio]").waitFor();
  ok("sin imagen ni textos el modal lo explica en vez de abrir vacío", (await page.locator("[data-preview-vacio]").count()) === 1 && (await page.locator("[data-preview-sin-imagen]").count()) === 1 && (await page.locator("[data-preview-enlace]").count()) === 0);
  await page.keyboard.press("Escape");

  // Modo oscuro y teléfono.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator('[data-preview="acct-ad-1"]:visible').click();
  await page.locator("[data-preview-anuncio]").waitFor();
  await quitaDev(page);
  await page.screenshot({ path: `${SALIDA}/creativo-modal-oscuro.png` });
  await page.keyboard.press("Escape");
  await page.emulateMedia({ colorScheme: "light" });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/resultados`, { waitUntil: "domcontentloaded" });
  await cierraBienvenida(page);
  await page.locator('[data-casilla="camp-1"]:visible').waitFor();
  ok("en el teléfono cada tarjeta lleva su casilla y hay «Marcar todo»", (await page.getByRole("button", { name: "Marcar todo" }).count()) === 1);
  await page.getByRole("button", { name: "Marcar todo" }).click();
  await page.locator("[data-pildora-seleccion]").waitFor();
  ok("«Marcar todo» marca las tarjetas visibles", (await page.locator("li [data-casilla]:visible:checked").count()) >= 2);
  ok("sin desborde horizontal con casillas y píldoras", !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await page.locator('[data-casilla="acct-camp-a"]:visible').check();
  await page.getByRole("button", { name: "Anuncio", exact: true }).click();
  await page.locator('[data-preview="acct-ad-1"]:visible').waitFor();
  await page.locator('[data-preview="acct-ad-1"]:visible').click();
  await page.locator("[data-preview-anuncio]").waitFor();
  ok("el modal cabe en el teléfono", await page.locator("[data-preview-anuncio]").evaluate((el) => el.getBoundingClientRect().right <= window.innerWidth + 1));
  await quitaDev(page);
  await page.screenshot({ path: `${SALIDA}/creativo-modal-movil.png` });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });

  // Móvil: tarjetas con gasto a la vista y sin desborde.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/resultados`, { waitUntil: "domcontentloaded" });
  await cierraBienvenida(page);
  await page.locator("[data-controles-anuncios]").waitFor();
  await page.locator('[data-abrir="camp-1"]:visible').first().waitFor();
  ok("en el teléfono las campañas son tarjetas con el total a la vista", (await page.locator("li[data-total]").count()) === 1);
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
  // Los bloques de la tarjeta cargan por su cuenta: se espera a que digan algo antes de mirarlos.
  await card.getByText("Cuenta publicitaria de prueba").first().waitFor();
  await card.locator("details[data-capi-log] summary").getByText("Cargando…").waitFor({ state: "detached" }).catch(() => {});
  ok("la tarjeta de Ajustes dice «Conectado» y la cuenta", (await card.getByText("Conectado", { exact: true }).count()) === 1 && (await card.innerText()).includes("Cuenta publicitaria de prueba"));
  ok("no muestra el token, solo ····9876", !(await card.innerText()).includes("tok-ads-ok") && (await card.innerText()).includes("····9876"));
  ok("UNA sola tarjeta «Meta Ads» con los dos bloques: Campañas y gasto, y Conversiones", (await page.locator("[data-meta-ads]").count()) === 1 && (await card.getByRole("heading", { name: "Campañas y gasto" }).count()) === 1 && (await card.getByRole("heading", { name: "Conversiones" }).count()) === 1);
  ok("ya no hay una tarjeta aparte llamada «Actividad reciente»", (await page.getByText("Actividad reciente", { exact: true }).count()) === 0);
  const registro = page.locator("details[data-capi-log]");
  ok("el registro de eventos de conversión está en un acordeón CERRADO", (await registro.count()) === 1 && !(await registro.evaluate((el) => el.open)));
  ok("y su resumen dice cómo va sin abrirlo", /conversiones todavía|enviadas/.test(await registro.locator("summary").innerText()));
  await registro.locator("summary").click();
  ok("se abre al hacer clic", await registro.evaluate((el) => el.open));
  // El dataset se elige de la lista de la cuenta.
  const datasetsOk = await conLista(
    page,
    "#capi-dataset",
    /Dataset de prueba/,
    async () => (await page.getByRole("option", { name: /Píxel de la tienda/ }).count()) === 1 && (await page.getByRole("option", { name: /Escribir el ID a mano/ }).count()) === 1
  );
  ok("el dataset se elige de la lista de la cuenta publicitaria (con salida «Escribir el ID a mano»)", datasetsOk);
  await page.keyboard.press("Escape");
  // Enrutamiento por anuncio con los nombres reales.
  const ruta = page.locator(`tr[data-anuncio="${AD(1)}"]`);
  await ruta.waitFor();
  ok("el enrutamiento muestra «Campaña › Conjunto» del anuncio, no solo el titular del creativo", (await ruta.locator("[data-jerarquia]").innerText()).includes("Campaña 1 › Conjunto 11"));
  ok("y el nombre real del anuncio como título", (await ruta.innerText()).includes(`Anuncio ${AD(1)}`));
  await quitaDev(page);
  await page.screenshot({ path: `${SALIDA}/ajustes-meta-ads.png`, fullPage: true });

  // El diálogo de vincular ofrece los anuncios de la cuenta.
  for (let i = 0; i < 6 && (await page.locator("#adflow-source").count()) === 0; i++) {
    await page.getByRole("button", { name: "Vincular anuncio" }).click({ timeout: 8000 }).catch(() => {});
    await page.locator("#adflow-source").waitFor({ timeout: 4000 }).catch(() => {});
  }
  // Hasta que llega el catálogo el campo es un cuadro de texto; después, una lista.
  await page.locator("button#adflow-source").waitFor({ timeout: 15000 }).catch(() => {});
  const vincularOk = await conLista(
    page,
    "#adflow-source",
    /Campaña Alfa › Conjunto Alfa 1 › Anuncio Alfa 1/,
    async () => (await page.getByRole("option", { name: /Anuncio borrado/ }).count()) === 0
  );
  if (!vincularOk) {
    await page.screenshot({ path: `${SALIDA}/fallo-vincular.png` });
    console.log("    opciones visibles:", JSON.stringify((await page.getByRole("option").allInnerTexts()).slice(0, 30)));
  }
  ok("«Vincular anuncio» ofrece los anuncios de la cuenta con su campaña y conjunto (no los borrados)", vincularOk);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Teléfono: el enrutamiento son tarjetas, sin scroll lateral.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/ajustes/anuncios`, { waitUntil: "domcontentloaded" });
  await cierraBienvenida(page);
  await page.locator(`li[data-anuncio="${AD(1)}"]`).waitFor();
  ok("en el teléfono Ajustes → Anuncios no se desborda a lo ancho", !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  ok("y cada anuncio del enrutamiento es una tarjeta", (await page.locator(`li[data-anuncio="${AD(1)}"]`).count()) === 1);
  await quitaDev(page);
  await page.screenshot({ path: `${SALIDA}/ajustes-meta-ads-movil.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await ctx.close();

  console.log("== 040: Meta rechaza el listado con creativos ==");
  r = await api("/api/settings/meta-ads", { method: "PUT", body: JSON.stringify({ adAccountId: CUENTA, token: "tok-ads-ok-sincreativo" }) });
  ok("se reconecta con una cuenta cuyo listado con creativos falla", r.ok);
  const aviso = await espera(async () => {
    const v = (await api("/api/settings/meta-ads")).json.metaAds;
    return /creativos/.test(v?.lastError ?? "") ? v : null;
  }, 60000);
  ok("Ajustes lo explica (los creativos se reintentan) y el conector sigue conectado", !!aviso && aviso.status === "connected", JSON.stringify(aviso?.lastError));
  b = await bloque("group=campaign");
  ok("el catálogo y el gasto SIGUEN al día sin los creativos", !!b.groups?.find((g) => g.name === "Campaña Alfa" && g.spend > 0));

  console.log("== Cuando la cuenta gastó más de lo que se puede desglosar ==");
  r = await api("/api/settings/meta-ads", { method: "PUT", body: JSON.stringify({ adAccountId: CUENTA, token: "tok-ads-ok-descuadre" }) });
  ok("se reconecta con una cuenta que descuadra", r.ok);
  const cuadre = await espera(async () => {
    const x = await bloque("group=campaign");
    return x.hierarchy?.account?.unattributed ? x : null;
  }, 60000);
  ok("lo que ningún anuncio explica sale como «sin desglosar», nunca se oculta", !!cuadre && cuadre.hierarchy.account.unattributed > 0, JSON.stringify(cuadre?.hierarchy?.account));

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
