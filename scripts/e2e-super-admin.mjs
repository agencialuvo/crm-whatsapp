/**
 * Self-test E2E de comportamiento — Panel de Super Admin (spec 045).
 *
 * Con la app viva y los mocks, recorre lo que vería el operador de la plataforma:
 *   - AISLAMIENTO: un dueño de negocio y un visitante sin sesión no ven el panel (404 / 401); un Super Admin sin
 *     segundo factor recibe 403 `two_factor_required` y su página lo explica; el Super Admin con 2FA entra aunque
 *     NO pertenezca a ninguna organización;
 *   - el dashboard coincide con la base (totales por estado, MRR, conversión) sobre organizaciones sembradas en los
 *     4 planes y los 5 estados, y una organización que se acaba de registrar aparece como Demo con 14 días;
 *   - el directorio filtra por plan y estado y busca por el correo del dueño;
 *   - las acciones con la UI real: extender la prueba, cambiar de plan, activar (la conversión y el MRR suben),
 *     suspender y cancelar, cada una con su motivo, y todo queda en la historia del cajón y en la auditoría;
 *   - con `SAAS_ENFORCE=true`: la organización suspendida ve `/suscripcion-inactiva` y su API responde 403, el
 *     webhook de WhatsApp SIGUE guardando mensajes, y al reactivarla vuelve a entrar.
 *
 * Uso: node --env-file=.env scripts/e2e-super-admin.mjs     (pnpm test:e2e:super-admin)
 * Requiere: `pnpm e2e:cuentas crear`, la app viva con los mocks (WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL →
 * wa-mock) y `SAAS_ENFORCE=true`, y la BD migrada (0080). Capturas en CAPTURAS_DIR (scratch/super-admin).
 */
import { chromium } from "playwright";
import postgres from "postgres";
import { existsSync, mkdirSync } from "node:fs";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const PN = "PN-SUPERADMIN-E2E";
const SALIDA = process.env.CAPTURAS_DIR ?? "scratch/super-admin";
const RUN = String(Date.now()).slice(-6);
const PASSWORD = "password-e2e-123";
const DUENO = "automations-e2e@vocero.test";
const SA = "automations-sa@vocero.test";
const SA2 = "automations-sa2@vocero.test";
const LETRAS = [...RUN].map((d) => "abcdefghij"[Number(d)]).join("");

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
async function espera(cond, ms = 15000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    const v = await cond();
    if (v) return v;
    await sleep(250);
  }
  return null;
}

/** Un cliente HTTP con su propia cookie (cada persona tiene su sesión). */
function cliente() {
  const jar = new Map();
  let cookie = "";
  const fn = async (path, opts = {}) => {
    const res = await fetch(`${BASE}${path}`, {
      ...opts,
      redirect: "manual",
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
    return { status: res.status, ok: res.ok, json, location: res.headers.get("location") };
  };
  /** Las cookies de esta sesión, para dárselas al navegador sin volver a iniciar sesión (el login tiene límite de intentos). */
  fn.cookies = () => [...jar].map(([name, value]) => ({ name, value, url: BASE }));
  return fn;
}
const apiDueno = cliente();
const apiSA = cliente();
const apiSA2 = cliente();
const apiAnon = cliente();

const sql = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 2, onnotice: () => {} }) : null;
if (!sql) {
  console.log("Falta DATABASE_URL: este guion siembra por SQL.");
  process.exit(1);
}
if (!existsSync(SALIDA)) mkdirSync(SALIDA, { recursive: true });

const sembradas = [];
let orgDueno = "";
let browser = null;

try {
  console.log("== Setup ==");
  for (const [api, email, nombre] of [
    [apiDueno, DUENO, "dueño"],
    [apiSA, SA, "Super Admin"],
    [apiSA2, SA2, "Super Admin sin 2FA"],
  ]) {
    const r = await api("/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email, password: PASSWORD }) });
    ok(`login ${nombre}`, r.ok, `status ${r.status}`);
  }
  await apiDueno("/api/organization/sector", { method: "PUT", body: JSON.stringify({ action: "skip" }) });
  const m = await sql`select organization_id from member where user_id = (select id from "user" where email = ${DUENO}) limit 1`;
  orgDueno = m[0]?.organization_id ?? "";
  ok("el dueño de prueba tiene su organización", Boolean(orgDueno));
  // Las sesiones del navegador se abren AHORA, antes de encender el 2FA (con el 2FA activo el inicio de sesión pide un
  // código del correo, que un guion no puede leer): el 2FA se enciende por SQL después, con las sesiones ya abiertas.
  browser = await chromium.launch({ channel: process.env.E2E_CHANNEL || undefined, headless: true });
  const abrir = async (api, email, ancho, alto) => {
    const c = await browser.newContext({ viewport: { width: ancho, height: alto } });
    await c.addCookies(api.cookies());
    ok(`sesión del navegador de ${email}`, api.cookies().length > 0);
    return c;
  };
  const ctxDueno = await abrir(apiDueno, DUENO, 1500, 1000);
  const ctxSA2 = await abrir(apiSA2, SA2, 1200, 800);
  const ctxSA = await abrir(apiSA, SA, 1600, 1100);
  await sql`update "user" set two_factor_enabled = true where email = ${SA}`;
  const planes = Object.fromEntries((await sql`select slug, id from plan`).map((p) => [p.slug, p.id]));
  ok("el catálogo tiene los 4 planes", ["demo", "emprendedor", "pro", "enterprise"].every((s) => planes[s]));
  const sa = (await sql`select id, is_super_admin from "user" where email = ${SA}`)[0];
  ok("el Super Admin de prueba no pertenece a ninguna organización", (await sql`select count(*)::int as n from member where user_id = ${sa.id}`)[0].n === 0);
  ok("el dueño de prueba NO tiene la bandera", (await sql`select is_super_admin from "user" where email = ${DUENO}`)[0].is_super_admin === false);

  // Organizaciones sembradas: los 4 planes y los estados; el estado real de cada una se calcula en SQL más abajo.
  const dia = 86_400_000;
  const sembrar = async (tag, slug, status, finDias, extra = {}) => {
    const id = `org_e2esa${RUN}${tag}`;
    await sql`insert into organization (id, name) values (${id}, ${`Negocio ${LETRAS} ${tag}`})`;
    const u = `usr_e2esa${RUN}${tag}`;
    await sql`insert into "user" (id, name, email, email_verified) values (${u}, ${`Dueño ${tag}`}, ${`dueno-${tag}-${RUN}@vocero.test`}, true)`;
    await sql`insert into member (id, organization_id, user_id, role) values (${`mem_e2esa${RUN}${tag}`}, ${id}, ${u}, 'owner')`;
    if (slug) {
      await sql`insert into subscription (id, organization_id, plan_id, status, current_period_start, current_period_end, status_reason, converted_at, trial_started_at)
                values (${`sub_e2esa${RUN}${tag}`}, ${id}, ${planes[slug]}, ${status}, now(), now() + (${finDias} * interval '1 day'), ${extra.reason ?? null}, ${extra.converted ? new Date(Date.now() - 5 * dia) : null}, ${extra.trialStart ? new Date(Date.now() - 20 * dia) : null})`;
      if (extra.trialStart) {
        await sql`insert into subscription_event (id, organization_id, type, source, to_status, to_plan_name, occurred_at)
                  values (${`sev_e2esa${RUN}${tag}1`}, ${id}, 'trial_started', 'signup', 'trialing', 'Demo', now() - interval '20 days')`;
      }
      if (extra.converted) {
        await sql`insert into subscription_event (id, organization_id, type, source, to_status, occurred_at)
                  values (${`sev_e2esa${RUN}${tag}2`}, ${id}, 'converted', 'admin', 'active', now() - interval '5 days')`;
      }
    }
    sembradas.push(id);
    return id;
  };
  await sembrar("a1", "emprendedor", "active", 20, { converted: true, trialStart: true });
  await sembrar("a2", "pro", "active", 20, { converted: true, trialStart: true });
  await sembrar("a3", "enterprise", "active", 20, { converted: true, trialStart: true });
  await sembrar("t1", "demo", "trialing", 6, { trialStart: true });
  await sembrar("t2", "demo", "trialing", 10, { trialStart: true });
  await sembrar("v1", "demo", "past_due", -4, { reason: "trial_ended", trialStart: true });
  await sembrar("c1", "pro", "canceled", -1, { trialStart: true });
  await sembrar("p1", "pro", "paused", 5, { trialStart: true });
  await sembrar("n1", null, null, 0);

  console.log("\n== Aislamiento ==");
  let r = await apiDueno("/api/super-admin/metrics");
  ok("un DUEÑO de negocio no ve el dashboard (404, no 403: el panel no revela que existe)", r.status === 404, `status ${r.status}`);
  r = await apiDueno("/api/super-admin/organizations");
  ok("…ni el directorio", r.status === 404, `status ${r.status}`);
  r = await apiDueno(`/api/super-admin/organizations/${orgDueno}/subscription`, { method: "POST", body: JSON.stringify({ action: "suspend", reason: "intento" }) });
  ok("…ni puede suspenderse a sí mismo ni a nadie (404)", r.status === 404, `status ${r.status}`);
  ok("…y su suscripción quedó intacta", (await sql`select status from subscription where organization_id = ${orgDueno}`)[0]?.status === "trialing");
  r = await apiAnon("/api/super-admin/metrics");
  ok("un visitante sin sesión recibe 401", r.status === 401, `status ${r.status}`);
  r = await apiSA2("/api/super-admin/metrics");
  ok("un Super Admin SIN segundo factor recibe 403 two_factor_required", r.status === 403 && r.json?.error?.code === "two_factor_required", `status ${r.status} ${JSON.stringify(r.json)}`);
  r = await apiSA("/api/super-admin/metrics");
  ok("el Super Admin CON 2FA entra aunque no pertenezca a ninguna organización", r.status === 200 && Boolean(r.json?.totals), `status ${r.status}`);
  r = await apiSA("/api/super-admin/organizations", { method: "GET", headers: { origin: "https://evil.example" } });
  ok("una lectura con otro Origin sigue siendo lectura (200)", r.status === 200);
  r = await apiSA(`/api/super-admin/organizations/${orgDueno}/subscription`, { method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify({ action: "suspend", reason: "csrf" }) });
  ok("una MUTACIÓN desde otro Origin se rechaza (403 bad_origin)", r.status === 403 && r.json?.error?.code === "bad_origin", `status ${r.status}`);
  r = await apiSA(`/api/super-admin/organizations/${orgDueno}/subscription`, { method: "POST", body: JSON.stringify({ action: "suspend" }) });
  ok("toda acción exige un motivo (422)", r.status === 422, `status ${r.status}`);

  const pDueno = await ctxDueno.newPage();
  const respDueno = await pDueno.goto(`${BASE}/super-admin`, { waitUntil: "domcontentloaded" });
  ok("la PÁGINA /super-admin responde 404 a un dueño de negocio", respDueno?.status() === 404, `status ${respDueno?.status()}`);

  const pSA2 = await ctxSA2.newPage();
  await pSA2.goto(`${BASE}/super-admin`, { waitUntil: "domcontentloaded" });
  const dosFactores = await espera(async () => (await pSA2.getByTestId("two-factor-required").count()) > 0, 20000);
  ok("un Super Admin sin 2FA ve la página que explica cómo activarlo", Boolean(dosFactores) && pSA2.url().includes("/super-admin/segundo-factor"), pSA2.url());
  await pSA2.screenshot({ path: `${SALIDA}/01-sin-2fa.png` });
  await ctxSA2.close();

  console.log("\n== El dashboard coincide con la base ==");
  const esperado = async () => {
    const o = (await sql`select count(*)::int as n from organization`)[0].n;
    const c = async (cond) => (await sql`select count(*)::int as n from subscription s join plan p on p.id = s.plan_id where ${sql.unsafe(cond)}`)[0].n;
    const venc = "(s.status = 'past_due' or (s.status = 'trialing' and p.trial_days is not null and s.current_period_end < now()))";
    const triVig = "(s.status = 'trialing' and not (p.trial_days is not null and s.current_period_end < now()))";
    const mrr = (await sql`select coalesce(sum(p.price_monthly_cents), 0)::int as n from subscription s join plan p on p.id = s.plan_id where s.status = 'active' and p.trial_days is null`)[0].n;
    return {
      organizations: o,
      active: await c("s.status = 'active'"),
      trialing: await c(triVig),
      pastDue: await c(venc),
      canceled: await c("s.status = 'canceled'"),
      paused: await c("s.status = 'paused'"),
      mrr,
    };
  };
  let e = await esperado();
  r = await apiSA("/api/super-admin/metrics");
  const t = r.json.totals;
  ok(`organizaciones: la API dice ${t.organizations} y la base ${e.organizations}`, t.organizations === e.organizations);
  ok(`activas ${t.active} · en prueba ${t.trialing} · vencidas ${t.pastDue} · canceladas ${t.canceled} · suspendidas ${t.paused} = la base`,
    t.active === e.active && t.trialing === e.trialing && t.pastDue === e.pastDue && t.canceled === e.canceled && t.paused === e.paused, JSON.stringify([e, t]));
  ok("la suma de los estados da el total (con «sin suscripción»)", t.active + t.trialing + t.pastDue + t.canceled + t.paused + t.withoutSubscription === t.organizations);
  ok(`el MRR (${r.json.mrr.mrrCents}) es la suma de los precios de las activas (${e.mrr})`, r.json.mrr.mrrCents === e.mrr);
  const convBase = (await sql`select count(distinct organization_id) filter (where type = 'trial_started' and not approximate)::int as started, count(distinct organization_id) filter (where type = 'converted' and not approximate)::int as converted from subscription_event where organization_id like ${"org_e2esa" + RUN + "%"}`)[0];
  ok("la conversión cuenta las pruebas iniciadas y convertidas de las organizaciones sembradas", r.json.conversion.started >= convBase.started && r.json.conversion.converted >= convBase.converted, JSON.stringify(r.json.conversion));
  const demoFila = r.json.byPlan.find((p) => p.name === "Demo");
  ok("el desglose por plan trae los planes con su precio", r.json.byPlan.some((p) => p.name === "Pro" && p.priceMonthlyCents === 14900) && Boolean(demoFila));

  console.log("\n== El panel en pantalla ==");
  const page = await ctxSA.newPage();
  await page.goto(`${BASE}/super-admin`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="super-admin-panel"][data-loaded="true"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="org-row"]', { timeout: 30000 });
  const valor = async (key) => Number(((await page.locator(`[data-testid="metric-${key}"] [data-testid="metric-value"]`).textContent()) ?? "").trim());
  ok(`las tarjetas dicen lo mismo que la base: ${await valor("organizations")} organizaciones · ${await valor("active")} activas · ${await valor("trialing")} en prueba · ${await valor("pastDue")} vencidas`,
    (await valor("organizations")) === e.organizations && (await valor("active")) === e.active && (await valor("trialing")) === e.trialing && (await valor("pastDue")) === e.pastDue && (await valor("canceled")) === e.canceled);
  ok("el panel NO muestra el marco de la app del negocio (sin menú de Bandeja/Pipeline)", (await page.getByRole("link", { name: "Bandeja" }).count()) === 0);
  ok("el panel muestra la conversión y el desglose por plan", (await page.getByTestId("conversion-card").count()) === 1 && (await page.getByTestId("plan-breakdown").count()) === 1);
  await page.screenshot({ path: `${SALIDA}/02-dashboard.png` });

  // Una organización que se acaba de REGISTRAR (el dueño de prueba) aparece como Demo con 14 días.
  const buscar = page.getByPlaceholder("Buscar organización, dueño o correo…");
  await buscar.fill(DUENO);
  const fila = await espera(async () => (await page.getByTestId("org-row").count()) === 1, 15000);
  ok("buscar por el correo del dueño deja una sola organización", Boolean(fila));
  ok("el input conserva el foco al filtrar", await buscar.evaluate((el) => el === document.activeElement));
  const filaDueno = page.getByTestId("org-row").first();
  ok("la organización recién registrada es Demo y está en prueba", /Demo/.test((await filaDueno.getByTestId("org-plan").textContent()) ?? "") && /En prueba/.test((await filaDueno.getByTestId("org-status").textContent()) ?? ""));
  const diasRestantes = Number(/(\d+)\s*d/.exec((await filaDueno.getByTestId("org-period").textContent()) ?? "")?.[1] ?? "0");
  ok(`le quedan 14 días de prueba (la pantalla dice ${diasRestantes})`, diasRestantes === 14 || diasRestantes === 13, String(diasRestantes));
  ok("el dueño y su correo salen en la fila", (await filaDueno.getByTestId("org-email").textContent()) === DUENO);
  await page.screenshot({ path: `${SALIDA}/03-registro-nuevo.png` });

  console.log("\n== Directorio: filtros ==");
  await buscar.fill(`Negocio ${LETRAS}`);
  await espera(async () => (await page.getByTestId("org-row").count()) === 9, 15000);
  ok("buscar por el nombre trae las 9 organizaciones sembradas", (await page.getByTestId("org-row").count()) === 9, String(await page.getByTestId("org-row").count()));
  await page.getByRole("combobox", { name: "Filtrar por plan" }).click();
  await page.getByRole("option", { name: /^Pro/ }).click();
  await espera(async () => (await page.getByTestId("org-row").count()) === 3, 10000);
  ok("filtrar por plan Pro deja las 3 (activa, cancelada y suspendida)", (await page.getByTestId("org-row").count()) === 3);
  await page.getByRole("combobox", { name: "Filtrar por estado" }).click();
  await page.getByRole("option", { name: "Cancelada" }).click();
  await espera(async () => (await page.getByTestId("org-row").count()) === 1, 10000);
  ok("…y por estado Cancelada, una sola", (await page.getByTestId("org-row").count()) === 1);
  await page.getByRole("combobox", { name: "Filtrar por plan" }).click();
  await page.getByRole("option", { name: "Todo plan" }).click();
  await page.getByRole("combobox", { name: "Filtrar por estado" }).click();
  await page.getByRole("option", { name: "Prueba vencida" }).click();
  await espera(async () => (await page.getByTestId("org-row").count()) === 1, 10000);
  ok("el estado «Prueba vencida» incluye la vencida persistida", (await page.getByTestId("org-row").count()) === 1);
  await page.getByRole("combobox", { name: "Filtrar por estado" }).click();
  await page.getByRole("option", { name: "Todo estado" }).click();
  await page.screenshot({ path: `${SALIDA}/04-directorio-filtrado.png` });

  console.log("\n== Acciones con la UI real ==");
  await buscar.fill(DUENO);
  await espera(async () => (await page.getByTestId("org-row").count()) === 1, 15000);
  const accionar = async (etiqueta) => {
    await page.getByTestId("org-row").first().getByRole("combobox", { name: /^Acciones de/ }).click();
    await page.getByRole("option", { name: etiqueta }).click();
    await page.getByTestId("subscription-dialog").waitFor({ timeout: 10000 });
  };
  const confirmar = async (motivo) => {
    await page.getByLabel("Motivo (obligatorio)").fill(motivo);
    await page.getByTestId("dialog-confirm").click();
    await page.getByTestId("subscription-dialog").waitFor({ state: "detached", timeout: 20000 });
  };
  const finAntes = (await sql`select current_period_end from subscription where organization_id = ${orgDueno}`)[0].current_period_end;

  // Extender la prueba
  await accionar("Extender la prueba");
  const sinMotivo = page.getByTestId("dialog-confirm");
  ok("sin motivo el botón de confirmar está deshabilitado", await sinMotivo.isDisabled());
  await page.getByLabel("Días a sumar").fill("7");
  await confirmar("Pidió más tiempo para probar");
  const finDespues = await espera(async () => {
    const f = (await sql`select current_period_end from subscription where organization_id = ${orgDueno}`)[0].current_period_end;
    return new Date(f).getTime() - new Date(finAntes).getTime() === 7 * dia ? f : null;
  }, 15000);
  ok("extender la prueba suma 7 días exactos al fin de la prueba", Boolean(finDespues));
  const dias2 = await espera(async () => {
    const x = Number(/(\d+)\s*d/.exec((await page.getByTestId("org-row").first().getByTestId("org-period").textContent()) ?? "")?.[1] ?? "0");
    return x >= 20 ? x : null;
  }, 15000);
  ok(`la fila se actualiza sola: ahora dice ${dias2} días`, Boolean(dias2));
  ok("la prueba extendida dejó su evento y su auditoría", (await sql`select count(*)::int as n from subscription_event where organization_id = ${orgDueno} and type = 'trial_extended' and source = 'admin'`)[0].n === 1 && (await sql`select count(*)::int as n from super_admin_audit where target_organization_id = ${orgDueno} and action = 'extend_trial'`)[0].n === 1);

  // Cambiar de plan (sigue en prueba)
  await accionar("Cambiar de plan");
  await page.getByRole("combobox", { name: "Plan", exact: true }).click();
  await page.getByRole("option", { name: /^Emprendedor/ }).click();
  await confirmar("Prueba con el plan que le interesa");
  ok("cambiar de plan en prueba conserva el estado y cambia el plan", Boolean(await espera(async () => (await sql`select s.status, p.slug from subscription s join plan p on p.id = s.plan_id where s.organization_id = ${orgDueno}`)[0]?.slug === "emprendedor", 15000)));
  ok("…sigue en prueba", (await sql`select status from subscription where organization_id = ${orgDueno}`)[0].status === "trialing");

  // Activar: la conversión
  const antesConv = (await apiSA("/api/super-admin/metrics")).json;
  await accionar("Activar plan de pago");
  await page.getByRole("combobox", { name: "Plan", exact: true }).click();
  await page.getByRole("option", { name: /^Pro/ }).click();
  await confirmar("Pagó por transferencia");
  ok("activar pasa la suscripción a activa con el plan Pro", Boolean(await espera(async () => {
    const s = (await sql`select s.status, p.slug, s.converted_at from subscription s join plan p on p.id = s.plan_id where s.organization_id = ${orgDueno}`)[0];
    return s?.status === "active" && s?.slug === "pro" && s?.converted_at;
  }, 15000)));
  const despuesConv = (await apiSA("/api/super-admin/metrics")).json;
  ok("la conversión sube en 1 y el MRR sube lo que cuesta Pro (149,00 o S/ 149)", despuesConv.conversion.converted === antesConv.conversion.converted + 1 && despuesConv.mrr.mrrCents === antesConv.mrr.mrrCents + 14900,
    `convertidas ${antesConv.conversion.converted}→${despuesConv.conversion.converted} · MRR ${antesConv.mrr.mrrCents}→${despuesConv.mrr.mrrCents}`);
  const ev = (await sql`select type, source, reason from subscription_event where organization_id = ${orgDueno} and type = 'converted'`)[0];
  ok("el evento de conversión queda marcado como del panel (manual) y con su motivo", ev?.source === "admin" && ev?.reason === "Pagó por transferencia", JSON.stringify(ev));
  const kpiActivas = await espera(async () => ((await valor("active")) === antesConv.totals.active + 1 ? true : null), 15000);
  ok("el KPI «Activas» del dashboard sube en pantalla", Boolean(kpiActivas));
  await page.screenshot({ path: `${SALIDA}/05-activada.png` });

  // Una acción inválida desde la API: 409 y nada cambia
  r = await apiSA(`/api/super-admin/organizations/${orgDueno}/subscription`, { method: "POST", body: JSON.stringify({ action: "extend_trial", days: 7, reason: "no aplica" }) });
  ok("una acción que no cabe en el estado responde 409 y no escribe nada", r.status === 409, `status ${r.status}`);

  console.log("\n== Cumplimiento: la suscripción suspendida (SAAS_ENFORCE) ==");
  // El dueño conecta su número ANTES de la suspensión (después, su API se cierra).
  r = await apiDueno("/api/settings/whatsapp", { method: "PUT", body: JSON.stringify({ wabaId: "WABA-SA", phoneNumberId: PN, token: "tok-sa" }) });
  ok("el dueño conectó su número de WhatsApp al mock", r.ok, `status ${r.status}`);
  const bandejaOk = await pDueno.goto(`${BASE}/bandeja`, { waitUntil: "domcontentloaded" });
  await pDueno.getByRole("button", { name: "Configurar más tarde" }).click({ timeout: 8000 }).catch(() => {});
  ok("con la suscripción activa el dueño entra a su Bandeja", bandejaOk?.status() === 200 && !pDueno.url().includes("suscripcion-inactiva"), pDueno.url());

  await accionar("Suspender");
  await confirmar("Falta de pago");
  ok("suspender deja la suscripción en pausa", Boolean(await espera(async () => (await sql`select status from subscription where organization_id = ${orgDueno}`)[0]?.status === "paused", 15000)));
  ok("la fila del panel dice «Suspendida»", Boolean(await espera(async () => /Suspendida/.test((await page.getByTestId("org-row").first().getByTestId("org-status").textContent()) ?? ""), 15000)));

  r = await apiDueno("/api/conversations");
  ok("la API del negocio suspendido responde 403 SUBSCRIPTION_INACTIVE", r.status === 403 && r.json?.error?.code === "SUBSCRIPTION_INACTIVE", `status ${r.status} ${JSON.stringify(r.json)}`);
  await pDueno.goto(`${BASE}/bandeja`, { waitUntil: "domcontentloaded" });
  const bloqueada = await espera(async () => pDueno.url().includes("/suscripcion-inactiva"), 20000);
  ok("el dueño es llevado a «Tu suscripción no está activa» en vez de a la app", Boolean(bloqueada), pDueno.url());
  ok("la página dice el motivo y que no se pierden mensajes", /no está activa/.test((await pDueno.getByTestId("subscription-inactive").textContent()) ?? "") && /no se pierde nada/.test((await pDueno.getByTestId("subscription-inactive").textContent()) ?? ""));
  await pDueno.screenshot({ path: `${SALIDA}/06-suscripcion-inactiva.png` });
  r = await apiDueno("/api/account/ui-preferences");
  ok("las rutas de su CUENTA siguen abiertas (puede cuidar su perfil)", r.status !== 403, `status ${r.status}`);
  r = await apiAnon("/api/health");
  ok("/api/health sigue respondiendo", r.status === 200);

  const msgsAntes = (await sql`select count(*)::int as n from message where organization_id = ${orgDueno}`)[0].n;
  r = await apiAnon("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({ phoneNumberId: PN, waMessageId: `wamid.sa.${RUN}`, from: `52155${RUN}01`, name: "Cliente durante la suspensión", text: "Hola, ¿siguen atendiendo?" }),
  });
  const llego = await espera(async () => (await sql`select count(*)::int as n from message where organization_id = ${orgDueno}`)[0].n > msgsAntes, 30000);
  ok("el webhook SIGUE guardando mensajes entrantes de un negocio suspendido (no se pierde nada del cliente)", Boolean(llego), `status ${r.status}`);

  // Reactivar desde el panel
  await accionar("Reactivar");
  await page.getByRole("combobox", { name: "Plan", exact: true }).click().catch(() => {});
  const planAbierto = await page.getByRole("option", { name: /^Pro/ }).count();
  if (planAbierto) await page.getByRole("option", { name: /^Pro/ }).first().click();
  await confirmar("Regularizó su pago");
  ok("reactivar la deja activa", Boolean(await espera(async () => (await sql`select status from subscription where organization_id = ${orgDueno}`)[0]?.status === "active", 15000)));
  const vuelve = await espera(async () => (await apiDueno("/api/conversations")).status === 200, 20000);
  ok("el dueño recupera su API al instante (el caché de acceso se invalida)", Boolean(vuelve));
  await pDueno.goto(`${BASE}/bandeja`, { waitUntil: "domcontentloaded" });
  ok("…y vuelve a entrar a la app", !pDueno.url().includes("suscripcion-inactiva"), pDueno.url());

  // Cancelar con motivo + la historia en el cajón
  await accionar("Cancelar");
  await confirmar("Se dio de baja");
  ok("cancelar deja la suscripción cancelada", Boolean(await espera(async () => (await sql`select status from subscription where organization_id = ${orgDueno}`)[0]?.status === "canceled", 15000)));
  await page.getByTestId("org-row").first().getByRole("button", { name: /Ver historia/ }).click();
  await page.getByTestId("organization-drawer").waitFor({ timeout: 10000 });
  const eventos = await espera(async () => ((await page.getByTestId("event-item").count()) >= 6 ? await page.getByTestId("event-item").count() : null), 15000);
  ok(`el cajón muestra la historia completa (${eventos} movimientos: alta, extensión, plan, conversión, suspensión, reactivación, cancelación)`, Boolean(eventos));
  const texto = (await page.getByTestId("organization-drawer").textContent()) ?? "";
  ok("la historia nombra la conversión y los motivos", /Convirtió a plan de pago/.test(texto) && /Pagó por transferencia/.test(texto) && /Falta de pago/.test(texto));
  ok("la auditoría lista lo que hizo el Super Admin", (await page.getByTestId("audit-item").count()) >= 6);
  await page.screenshot({ path: `${SALIDA}/07-historia.png` });
  await page.getByRole("button", { name: "Cerrar" }).first().click();
  ok("el cajón se cierra con la X", (await page.getByTestId("organization-drawer").count()) === 0);

  const audit = await sql`select action from super_admin_audit where target_organization_id = ${orgDueno} order by created_at`;
  ok("la base tiene una fila de auditoría por acción (extender, cambiar plan, activar, suspender, reactivar, cancelar)", audit.length === 6, JSON.stringify(audit.map((a) => a.action)));
  const sinActor = await sql`select count(*)::int as n from super_admin_audit where target_organization_id = ${orgDueno} and (actor_user_id is null or actor_email is null or reason is null)`;
  ok("cada fila de auditoría trae quién y el motivo", sinActor[0].n === 0);
} catch (err) {
  failures++;
  console.log(`  ✗ el guion se interrumpió — ${err instanceof Error ? err.stack : err}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (sql) {
    await sql`delete from super_admin_audit where target_organization_id = any(${[...sembradas, orgDueno].filter(Boolean)})`;
    if (sembradas.length) {
      await sql`delete from organization where id = any(${sembradas})`;
      await sql`delete from "user" where id like ${"usr_e2esa" + RUN + "%"}`;
    }
    await sql.end();
  }
}

console.log(`\n${checks - failures}/${checks} comprobaciones en verde`);
process.exit(failures ? 1 : 0);
