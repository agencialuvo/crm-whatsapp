/**
 * Self-test E2E de comportamiento — Pipeline: tablero sólido (spec 044).
 *
 * Siembra por SQL 400 leads en las columnas del negocio y recorre lo que vería el operador:
 *   - cada columna abre con 25 tarjetas y dice su total REAL (los cuenta el servidor); «cargar más» trae
 *     las siguientes sin repetir ninguna;
 *   - arrastrar dentro de una columna y entre columnas: el orden sobrevive a recargar;
 *   - la búsqueda (nombre, y texto de un mensaje) y los filtros acotan conteos y sumas, sin perder el foco;
 *   - el tiempo real: un movimiento hecho por otra sesión aparece sin recargar, y una ráfaga de 10 movimientos
 *     NO vuelve a descargar el tablero entero;
 *   - las reglas automáticas con la app real: la primera respuesta del operador desde la Bandeja lleva el lead a
 *     «En conversación», agendar una cita a «Interesado» y cobrar en Caja a «Cliente» (también el salto directo
 *     desde «Nuevo»); un envío fallido, un lead perdido o una venta sin lead no mueven nada.
 *
 * Uso: node --env-file=.env scripts/e2e-pipeline-tablero.mjs     (pnpm test:e2e:pipeline-tablero)
 * Requiere: `pnpm e2e:cuentas crear`, la app viva con los mocks (WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL →
 * wa-mock), AGENDA y SALON encendidos y la BD migrada (0079). Capturas en CAPTURAS_DIR (scratch/pipeline-tablero).
 */
import { chromium } from "playwright";
import postgres from "postgres";
import { existsSync, mkdirSync } from "node:fs";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const PN = "PN-PIPELINE-TAB";
const SALIDA = process.env.CAPTURAS_DIR ?? "scratch/pipeline-tablero";
const RUN = String(Date.now()).slice(-6);
const CORREO = "automations-e2e@vocero.test";
const PASSWORD = "password-e2e-123";
/** Solo letras en el prefijo: la búsqueda por dígitos del teléfono no debe coincidir con los números sembrados. */
const LETRAS = [...RUN].map((d) => "abcdefghij"[Number(d)]).join("");
const PREFIJO = `Tablero ${LETRAS}`;

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
    await sleep(200);
  }
  return null;
}

let cookie = "";
const jar = new Map();
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

const sql = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 2, onnotice: () => {} }) : null;
if (!sql) {
  console.log("Falta DATABASE_URL: este guion siembra por SQL.");
  process.exit(1);
}
if (!existsSync(SALIDA)) mkdirSync(SALIDA, { recursive: true });

let org = "";
let browser = null;
const stage = {}; // por papel: new, conversation, interested, client
let perdida = "";
const contactos = [];
let nCliente = 0;
const DIG = RUN;

const modo = (m) => api("/api/dev/wa-mock/modo", { method: "POST", body: JSON.stringify({ modo: m }) });

/** Un cliente que escribe por WhatsApp: el CRM crea su contacto, su conversación (ventana abierta) y su lead en «Nuevo». */
async function cliente(nombre) {
  const idx = ++nCliente;
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({ phoneNumberId: PN, waMessageId: `wamid.pipe.${RUN}.${idx}`, from: `52155${DIG}${String(idx).padStart(2, "0")}`, name: nombre, text: "Hola" }),
  });
  const hallada = await espera(async () => {
    const lista = (await api(`/api/conversations?q=${encodeURIComponent(nombre)}`)).json?.conversations ?? [];
    return lista.find((c) => c.contact.name === nombre);
  });
  if (!hallada) throw new Error(`la conversación de ${nombre} no apareció`);
  contactos.push(hallada.contact.id);
  return hallada;
}

/** En qué etapa está el lead de un contacto, y qué regla lo movió por última vez. */
async function donde(contactId) {
  const r = await sql`
    select s.name as etapa, s.auto_role as rol, l.amount_cents,
           (select e.auto_rule from lead_stage_event e where e.lead_id = l.id order by e.occurred_at desc, e.id desc limit 1) as regla,
           (select count(*)::int from lead_stage_event e where e.lead_id = l.id and e.auto_rule is not null) as automaticos
    from lead l join pipeline_stage s on s.id = l.stage_id where l.contact_id = ${contactId}`;
  return r[0] ?? null;
}

try {
  console.log("== Setup ==");
  let r = await api("/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email: CORREO, password: PASSWORD }) });
  ok("login", r.ok);
  await api("/api/organization/sector", { method: "PUT", body: JSON.stringify({ action: "skip" }) });
  r = await api("/api/settings/whatsapp", { method: "PUT", body: JSON.stringify({ wabaId: "WABA-PIPE", phoneNumberId: PN, token: "tok-pipe" }) });
  ok("número de WhatsApp conectado al mock", r.ok, `status ${r.status}`);
  const rows = await sql`select organization_id from member where user_id = (select id from "user" where email = ${CORREO}) limit 1`;
  org = rows[0]?.organization_id ?? "";
  ok("hay organización", Boolean(org));
  const etapas = await sql`select id, name, kind, auto_role from pipeline_stage where organization_id = ${org} order by position`;
  for (const e of etapas) {
    if (e.auto_role) stage[e.auto_role] = e.id;
    if (e.kind === "lost") perdida = e.id;
  }
  ok("el negocio nuevo nace con las 5 etapas y sus 4 papeles automáticos", etapas.length === 5 && Object.keys(stage).length === 4 && Boolean(perdida), JSON.stringify(etapas.map((e) => `${e.name}:${e.auto_role}`)));
  ok("los nombres de las etapas sembradas son los nuevos", etapas.map((e) => e.name).join("|") === "Nuevo|En conversación|Interesado|Cliente|No interesado");

  // 400 leads: 220 en Nuevo, 90 en conversación, 50 interesados, 30 clientes, 10 perdidos. Cada décimo con prioridad alta y cada quinto con monto.
  const grupos = [
    ["new", 220],
    ["conversation", 90],
    ["interested", 50],
    ["client", 30],
  ];
  let base = 0;
  for (const [rol, n] of grupos) {
    await sql`
      insert into contact (id, organization_id, name, wa_identity, phone)
      select 'ct_tab' || ${RUN} || ${rol} || g, ${org}, ${PREFIJO} || ' ' || ${rol.slice(0, 3)} || ' ' || lpad(g::text, 3, '0'),
             '5255' || ${RUN.slice(0, 4)} || lpad((${base} + g)::text, 4, '0'), '5255' || ${RUN.slice(0, 4)} || lpad((${base} + g)::text, 4, '0')
      from generate_series(1, ${n}) g`;
    await sql`
      insert into lead (id, organization_id, contact_id, stage_id, position, priority, amount_cents)
      select 'lead_tab' || ${RUN} || ${rol} || lpad(g::text, 4, '0'), ${org}, 'ct_tab' || ${RUN} || ${rol} || g, ${stage[rol]}, g - 1,
             case when g % 10 = 0 then 'alta' else null end, case when g % 5 = 0 then 10000 else null end
      from generate_series(1, ${n}) g`;
    base += n;
  }
  // 10 perdidos (el motivo es obligatorio en la base: se siembra el evento con su motivo)
  await sql`
    insert into contact (id, organization_id, name, wa_identity, phone)
    select 'ct_tab' || ${RUN} || 'lost' || g, ${org}, ${PREFIJO} || ' per ' || lpad(g::text, 3, '0'), '5255' || ${RUN.slice(0, 4)} || lpad((${base} + g)::text, 4, '0'), '5255' || ${RUN.slice(0, 4)} || lpad((${base} + g)::text, 4, '0')
    from generate_series(1, 10) g`;
  await sql`
    insert into lead (id, organization_id, contact_id, stage_id, position)
    select 'lead_tab' || ${RUN} || 'lost' || lpad(g::text, 4, '0'), ${org}, 'ct_tab' || ${RUN} || 'lost' || g, ${perdida}, g - 1 from generate_series(1, 10) g`;
  // una palabra que solo vive en un mensaje del lead new #7
  const PALABRA = `zxqtab${LETRAS}`;
  await sql`insert into conversation (id, organization_id, contact_id) values (${"cv_tab" + RUN + "7"}, ${org}, ${"ct_tab" + RUN + "new7"})`;
  await sql`insert into message (id, organization_id, conversation_id, direction, type, text, status)
            values (${"msg_tab" + RUN + "7"}, ${org}, ${"cv_tab" + RUN + "7"}, 'in', 'text', ${"Quiero un " + PALABRA + " rubio"}, 'delivered')`;

  console.log("\n== API: primera página por columna, totales y cursores ==");
  r = await api(`/api/pipeline/board?q=${encodeURIComponent(PREFIJO)}`);
  const porNombre = (nombre) => r.json?.stages?.find((s) => s.name === nombre);
  ok("cada columna trae 25 tarjetas como máximo", (r.json?.stages ?? []).every((s) => s.leads.length <= 25), JSON.stringify(r.json?.stages?.map((s) => s.leads.length)));
  ok("el total de cada columna es el REAL (220 · 90 · 50 · 30 · 10), no el de las 25 cargadas",
    porNombre("Nuevo")?.totals.count === 220 && porNombre("En conversación")?.totals.count === 90 && porNombre("Interesado")?.totals.count === 50 && porNombre("Cliente")?.totals.count === 30 && porNombre("No interesado")?.totals.count === 10,
    JSON.stringify(r.json?.stages?.map((s) => [s.name, s.totals.count])));
  ok("la suma de la columna Nuevo es la de las 44 tarjetas con monto (44 × 100,00), no la de las 25 visibles", porNombre("Nuevo")?.totals.sumCents === 44 * 10000, String(porNombre("Nuevo")?.totals.sumCents));
  ok("trae serverTime y la moneda del negocio", Boolean(r.json?.serverTime) && Boolean(r.json?.currency));
  const nuevo = porNombre("Nuevo");
  r = await api(`/api/pipeline/stages/${nuevo.id}/leads?q=${encodeURIComponent(PREFIJO)}&cursor=${encodeURIComponent(nuevo.nextCursor)}`);
  ok("la segunda página sigue a la primera sin repetir", r.json?.leads?.length === 25 && !r.json.leads.some((l) => nuevo.leads.some((x) => x.id === l.id)));
  r = await api(`/api/pipeline/stages/${nuevo.id}/leads?cursor=basura`);
  ok("un cursor manipulado responde 422", r.status === 422, `status ${r.status}`);
  r = await api(`/api/pipeline/board?q=${PALABRA}`);
  ok("la API encuentra un lead por el TEXTO de un mensaje", r.json?.stages?.flatMap((s) => s.leads).length === 1, JSON.stringify(r.json?.stages?.map((s) => s.leads.length)));
  r = await api(`/api/pipeline/board?q=${encodeURIComponent(PREFIJO)}&priority=alta`);
  ok("el filtro de prioridad acota conteos y sumas (22 + 9 + 5 + 3 altas)", porNombre("Nuevo")?.totals.count === 22 && porNombre("En conversación")?.totals.count === 9 && porNombre("Interesado")?.totals.count === 5 && porNombre("Cliente")?.totals.count === 3,
    JSON.stringify(r.json?.stages?.map((s) => [s.name, s.totals.count])));

  browser = await chromium.launch({ channel: process.env.E2E_CHANNEL || undefined, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1800, height: 1000 } });
  const login = await ctx.request.post(`${BASE}/api/auth/sign-in/email`, { data: { email: CORREO, password: PASSWORD } });
  ok("sesión del navegador", login.ok());
  const page = await ctx.newPage();
  const peticiones = [];
  page.on("request", (rq) => {
    const u = new URL(rq.url());
    if (u.pathname.startsWith("/api/pipeline/")) peticiones.push({ m: rq.method(), p: u.pathname, q: u.search });
  });

  console.log("\n== El tablero en pantalla ==");
  await page.goto(`${BASE}/pipeline`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Configurar más tarde" }).click({ timeout: 8000 }).catch(() => {});
  await page.waitForSelector('[data-testid="pipeline-board"][data-loaded="true"]', { timeout: 40000 });
  const col = (nombre) => page.locator(`[data-stage-name="${nombre}"]`);
  const tarjetas = (nombre) => col(nombre).locator('[data-testid="lead-card"]');
  const cuenta = async (nombre) => Number(((await col(nombre).locator('[data-testid="stage-count"]').textContent()) ?? "").trim());
  const filtrar = page.getByPlaceholder("Buscar nombre, teléfono o mensaje…");
  await filtrar.fill(PREFIJO);
  const cargado = await espera(async () => (await tarjetas("Nuevo").count()) === 25 && (await cuenta("Nuevo")) === 220, 30000);
  ok("«Nuevo» abre con 25 tarjetas y su contador dice 220", Boolean(cargado), `tarjetas=${await tarjetas("Nuevo").count()} contador=${await cuenta("Nuevo")}`);
  ok("las demás columnas dicen su total real (90 · 50 · 30 · 10)", (await cuenta("En conversación")) === 90 && (await cuenta("Interesado")) === 50 && (await cuenta("Cliente")) === 30 && (await cuenta("No interesado")) === 10);
  ok("el pie de «Nuevo» suma toda la columna: 44 montos de 100,00 (4.400)", /4[.,\s]?400/.test((await col("Nuevo").locator('[data-testid="stage-total"]').textContent()) ?? ""), (await col("Nuevo").locator('[data-testid="stage-total"]').textContent()) ?? "");
  await page.screenshot({ path: `${SALIDA}/01-tablero.png` });

  await col("Nuevo").locator('[data-testid="stage-scroll"]').evaluate((el) => (el.scrollTop = el.scrollHeight));
  const mas = await espera(async () => (await tarjetas("Nuevo").count()) > 25, 15000);
  ok("al llegar al final de la columna se cargan más tarjetas", Boolean(mas), `tarjetas=${await tarjetas("Nuevo").count()}`);
  for (let i = 0; i < 12 && (await tarjetas("Nuevo").count()) < 220; i++) {
    await col("Nuevo").locator('[data-testid="stage-scroll"]').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await sleep(500);
  }
  const nombres = await col("Nuevo").locator('[data-testid="lead-name"]').allTextContents();
  ok("se recorren las 220 sin repetir ninguna", nombres.length === 220 && new Set(nombres).size === 220, `n=${nombres.length} únicos=${new Set(nombres).size}`);
  await page.screenshot({ path: `${SALIDA}/02-nuevo-completo.png` });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="pipeline-board"][data-loaded="true"]', { timeout: 40000 });
  await page.getByPlaceholder("Buscar nombre, teléfono o mensaje…").fill(PREFIJO);
  await espera(async () => (await tarjetas("Nuevo").count()) === 25, 20000);

  console.log("\n== Arrastrar: orden dentro de la columna y entre columnas ==");
  const arrastrar = async (desde, hasta) => {
    const a = await desde.boundingBox();
    const b = await hasta.boundingBox();
    if (!a || !b) return false;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2 + 8, { steps: 3 });
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 14 });
    await sleep(200);
    await page.mouse.up();
    return true;
  };
  const primerosIds = async (nombre, n = 5) => (await col(nombre).locator('[data-testid="lead-card"]').evaluateAll((els, k) => els.slice(0, k).map((e) => e.getAttribute("data-lead-id")), n));
  const antes = await primerosIds("Interesado", 4);
  await arrastrar(tarjetas("Interesado").nth(0), tarjetas("Interesado").nth(2));
  const reordenada = await espera(async () => {
    const d = await primerosIds("Interesado", 4);
    return d[0] === antes[1] && d[1] === antes[2] && d[2] === antes[0] ? d : null;
  }, 15000);
  ok("arrastrar la 1ª tarjeta sobre la 3ª la deja en 3er lugar (reordenar dentro de la columna)", Boolean(reordenada), JSON.stringify(await primerosIds("Interesado", 4)));
  // El servidor de desarrollo compila la ruta la primera vez: se espera el resultado, no un reloj.
  const esperado = JSON.stringify([antes[1], antes[2], antes[0]]);
  let enServidor = [];
  const guardado = await espera(async () => {
    enServidor = (await api(`/api/pipeline/stages/${stage.interested}/leads?limit=4`)).json?.leads?.map((l) => l.id) ?? [];
    return JSON.stringify(enServidor.slice(0, 3)) === esperado;
  }, 40000);
  ok("el orden quedó guardado en el servidor", Boolean(guardado), JSON.stringify(enServidor));
  await sleep(1500); // deja que llegue el delta y la recarga de la columna
  const posiciones = await sql`select position from lead where stage_id = ${stage.interested} order by position, id`;
  ok("las posiciones de la columna quedaron contiguas 0..49 (sin empates)", posiciones.every((p, i) => Number(p.position) === i) && posiciones.length >= 50, `n=${posiciones.length}`);

  const arrastrada = (await primerosIds("Nuevo", 1))[0];
  await arrastrar(tarjetas("Nuevo").nth(0), tarjetas("En conversación").nth(1));
  const movida = await espera(async () => (await sql`select s.name from lead l join pipeline_stage s on s.id = l.stage_id where l.id = ${arrastrada}`)[0]?.name === "En conversación", 15000);
  ok("arrastrar una tarjeta a otra columna la mueve", Boolean(movida));
  const ev = await sql`select source, auto_rule from lead_stage_event where lead_id = ${arrastrada} order by occurred_at desc limit 1`;
  ok("la bitácora la registra como movimiento del dueño (no automático)", ev[0]?.source === "dueno" && ev[0]?.auto_rule === null, JSON.stringify(ev[0]));
  const enNueva = await espera(async () => (await cuenta("Nuevo")) === 219 && (await cuenta("En conversación")) === 91, 15000);
  ok("los contadores de las dos columnas se actualizan (219 · 91)", Boolean(enNueva), `${await cuenta("Nuevo")} · ${await cuenta("En conversación")}`);
  const pos2 = await sql`select position from lead where stage_id = ${stage.new} order by position, id`;
  ok("la columna de origen quedó compactada y la de destino contigua", pos2.every((p, i) => Number(p.position) === i));
  await page.screenshot({ path: `${SALIDA}/03-arrastre.png` });

  console.log("\n== Búsqueda y filtros ==");
  await filtrar.click();
  await filtrar.fill("");
  await filtrar.pressSequentially(`${PREFIJO} new 017`, { delay: 40 });
  // (3 o más dígitos también buscan por teléfono, como en la Bandeja: la tarjeta exacta debe estar y el resto, acotado.)
  const uno = await espera(async () => {
    const n = await col("Nuevo").locator('[data-testid="lead-name"]').allTextContents();
    return n.includes(`${PREFIJO} new 017`) && (await cuenta("Nuevo")) < 220 ? n : null;
  }, 20000);
  ok("el operador teclea un nombre y «Nuevo» se acota (incluye la tarjeta exacta y el contador baja de 220)", Boolean(uno), String(await cuenta("Nuevo")));
  ok("el input conserva el foco mientras la lista se actualiza", await filtrar.evaluate((el) => el === document.activeElement));
  await filtrar.fill("");
  await filtrar.pressSequentially(PALABRA, { delay: 40 });
  const porMsg = await espera(async () => (await page.locator('[data-testid="lead-card"]').count()) === 1, 20000);
  ok("buscar una palabra que solo vive en un mensaje deja ese lead", Boolean(porMsg));
  await page.screenshot({ path: `${SALIDA}/04-busqueda.png` });
  await filtrar.fill(PREFIJO);
  await espera(async () => (await tarjetas("Nuevo").count()) === 25, 20000);

  console.log("\n== Tiempo real ==");
  const sesion2 = await ctx.newPage(); // otra pestaña del mismo operador: no hace nada, el movimiento va por la API
  await sesion2.close();
  const ids = (await sql`select id from lead where stage_id = ${stage.interested} order by position, id offset 5 limit 10`).map((x) => x.id);
  peticiones.length = 0;
  const t0 = Date.now();
  const resultados = await Promise.all(
    ids.map((id) => api(`/api/pipeline/leads/${id}`, { method: "PATCH", body: JSON.stringify({ stageId: stage.client }) }))
  );
  ok("una ráfaga de 10 movimientos desde otra sesión responde bien", resultados.every((x) => x.ok), JSON.stringify(resultados.map((x) => x.status)));
  const apareceron = await espera(async () => (await cuenta("Interesado")) === 40 && (await cuenta("Cliente")) === 40, 20000);
  ok("el tablero abierto lo refleja SIN recargar (Interesado 40 · Cliente 40)", Boolean(apareceron), `${await cuenta("Interesado")} · ${await cuenta("Cliente")}`);
  await sleep(800);
  const cargasCompletas = peticiones.filter((p) => p.m === "GET" && p.p === "/api/pipeline/board" && !p.q.includes("since="));
  const deltas = peticiones.filter((p) => p.m === "GET" && p.p === "/api/pipeline/board" && p.q.includes("since="));
  ok(`la ráfaga NO descargó el tablero entero (${cargasCompletas.length} cargas completas, ${deltas.length} deltas en ${Date.now() - t0} ms)`, cargasCompletas.length === 0 && deltas.length >= 1 && deltas.length <= 4);
  await page.screenshot({ path: `${SALIDA}/05-tiempo-real.png` });

  console.log("\n== Reglas automáticas con la app real ==");
  // 1) El operador responde desde el compositor de la Bandeja.
  const respuesta = await cliente(`${PREFIJO} Respuesta`);
  ok("un cliente que escribe nace en «Nuevo»", (await donde(respuesta.contact.id))?.rol === "new");
  const bandeja = await ctx.newPage();
  await bandeja.goto(`${BASE}/bandeja?contact=${respuesta.contact.id}`, { waitUntil: "domcontentloaded" });
  await bandeja.getByRole("button", { name: "Configurar más tarde" }).click({ timeout: 8000 }).catch(() => {});
  const caja = bandeja.getByPlaceholder("Escribe una respuesta…");
  await caja.waitFor({ timeout: 40000 });
  await caja.fill("Hola, con gusto te atendemos");
  await caja.press("Enter");
  const p1 = await espera(async () => (await donde(respuesta.contact.id))?.rol === "conversation", 90000);
  ok("el operador responde desde la Bandeja → el lead pasa a «En conversación»", Boolean(p1), JSON.stringify(await donde(respuesta.contact.id)));
  ok("la bitácora dice que fue la regla de primera respuesta", (await donde(respuesta.contact.id))?.regla === "first_reply");
  await bandeja.close();
  const dos = await api(`/api/conversations/${respuesta.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Y un segundo mensaje" }) });
  await sleep(800);
  ok("un segundo mensaje no vuelve a moverlo ni duplica el evento", dos.ok && (await donde(respuesta.contact.id))?.automaticos === 1);

  // 2) Un envío que FALLA no mueve nada.
  const fallido = await cliente(`${PREFIJO} Fallido`);
  await modo("fallo");
  const rf = await api(`/api/conversations/${fallido.id}/messages`, { method: "POST", body: JSON.stringify({ text: "este no sale" }) });
  await modo("normal");
  ok("el envío falla (el mock rechaza)", !rf.ok, `status ${rf.status}`);
  ok("un envío fallido NO mueve el lead de «Nuevo»", (await donde(fallido.contact.id))?.rol === "new");

  // 3) Una cita agendada: desde «Nuevo» y desde «En conversación».
  const disp = (await api("/api/calendar/availability")).json?.slots ?? [];
  const dias = [...new Set(disp.map((s) => s.dayIso))].slice(2);
  const hueco = (i) => disp.find((s) => s.dayIso === dias[i]);
  const citaA = await cliente(`${PREFIJO} Cita Directa`);
  const sA = hueco(0);
  const rA = await api("/api/bookings", { method: "POST", body: JSON.stringify({ kind: "session", contactId: citaA.contact.id, conversationId: citaA.id, startUtc: sA?.startUtc }) });
  ok("agendar una cita desde «Nuevo» responde 201", rA.status === 201, `status ${rA.status} ${JSON.stringify(rA.json).slice(0, 120)}`);
  ok("…y el lead pasa DIRECTO a «Interesado»", (await donde(citaA.contact.id))?.rol === "interested" && (await donde(citaA.contact.id))?.regla === "booking", JSON.stringify(await donde(citaA.contact.id)));
  // desde «En conversación»: la «Respuesta» de arriba
  const sB = hueco(1);
  const rB = await api("/api/bookings", { method: "POST", body: JSON.stringify({ kind: "session", contactId: respuesta.contact.id, conversationId: respuesta.id, startUtc: sB?.startUtc }) });
  ok("agendar una cita desde «En conversación» responde 201", rB.status === 201, `status ${rB.status}`);
  ok("…y el lead pasa a «Interesado»", (await donde(respuesta.contact.id))?.rol === "interested");

  // 4) Una venta en Caja: salto directo desde «Nuevo» y la toma del monto.
  const staff = (await api("/api/negocio/equipo", { method: "POST", body: JSON.stringify({ name: "Barbero Pipeline" }) })).json?.staff;
  ok("hay un profesional para cobrar", Boolean(staff?.id));
  const pago = await cliente(`${PREFIJO} Pago Inmediato`);
  const telPago = (await sql`select phone from contact where id = ${pago.contact.id}`)[0].phone;
  const venta = await api("/api/negocio/ventas", {
    method: "POST",
    body: JSON.stringify({ customerPhone: telPago, staffId: staff.id, other: true, otherNote: "Corte y barba", amountCents: 15000, paymentMethod: "efectivo" }),
  });
  ok("cobrar en Caja por el teléfono del contacto responde 201", venta.status === 201, `status ${venta.status} ${JSON.stringify(venta.json).slice(0, 160)}`);
  const d = await donde(pago.contact.id);
  ok("el lead salta de «Nuevo» DIRECTO a «Cliente» (pago inmediato, sin cita previa)", d?.rol === "client" && d?.regla === "sale", JSON.stringify(d));
  ok("el lead toma el monto de la venta (150,00) porque no tenía", d?.amount_cents === 15000, String(d?.amount_cents));

  // 5) Lo que NO debe moverse.
  const perdido = await cliente(`${PREFIJO} Perdido`);
  await api(`/api/pipeline/leads/${(await sql`select id from lead where contact_id = ${perdido.contact.id}`)[0].id}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: perdida, lossReason: "precio" }),
  });
  const telPer = (await sql`select phone from contact where id = ${perdido.contact.id}`)[0].phone;
  await api("/api/negocio/ventas", { method: "POST", body: JSON.stringify({ customerPhone: telPer, staffId: staff.id, other: true, otherNote: "Corte", amountCents: 5000, paymentMethod: "efectivo" }) });
  await api(`/api/conversations/${perdido.id}/messages`, { method: "POST", body: JSON.stringify({ text: "hola otra vez" }) });
  ok("un lead PERDIDO no se reabre solo (ni por venta ni por respuesta)", (await donde(perdido.contact.id))?.etapa === "No interesado");
  const mostrador = `52155${DIG}99`;
  const vm = await api("/api/negocio/ventas", { method: "POST", body: JSON.stringify({ customerName: "Cliente Mostrador", customerPhone: mostrador, staffId: staff.id, other: true, otherNote: "Corte", amountCents: 5000, paymentMethod: "efectivo" }) });
  const sinLead = await sql`select count(*)::int as n from lead l join contact c on c.id = l.contact_id where c.organization_id = ${org} and (c.phone = ${mostrador} or c.wa_identity = ${mostrador})`;
  ok("una venta de un contacto SIN lead se registra y no crea ninguna tarjeta", vm.status === 201 && sinLead[0].n === 0, `status ${vm.status} leads=${sinLead[0].n}`);

  // 6) El tablero abierto lo refleja en vivo.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="pipeline-board"][data-loaded="true"]', { timeout: 40000 });
  await page.getByPlaceholder("Buscar nombre, teléfono o mensaje…").fill(`${PREFIJO} Pago`);
  await espera(async () => (await page.locator('[data-testid="lead-card"]').count()) === 1, 20000);
  ok("el cobro aparece en la columna «Cliente» del tablero", (await tarjetas("Cliente").count()) === 1);
  await page.screenshot({ path: `${SALIDA}/06-reglas.png` });

  console.log("\n== Papeles de etapa ==");
  const otra = await api("/api/pipeline/stages", { method: "POST", body: JSON.stringify({ name: `Extra ${LETRAS}` }) });
  const extraId = otra.json?.stage?.id;
  ok("se crea una etapa propia sin papel", otra.status === 201 && otra.json?.stage?.autoRole === null);
  let pr = await api(`/api/pipeline/stages/${extraId}`, { method: "PATCH", body: JSON.stringify({ autoRole: "interested" }) });
  ok("asignarle un papel que ya tiene otra etapa responde 409 con el nombre de la que lo tiene", pr.status === 409 && /Interesado/.test(pr.json?.error?.message ?? ""), `${pr.status} ${pr.json?.error?.message}`);
  pr = await api(`/api/pipeline/stages/${perdida}`, { method: "PATCH", body: JSON.stringify({ autoRole: "new" }) });
  ok("una etapa perdida no admite papel (422)", pr.status === 422, `status ${pr.status}`);
  await api(`/api/pipeline/stages/${stage.conversation}`, { method: "PATCH", body: JSON.stringify({ autoRole: null }) });
  const sinRol = await cliente(`${PREFIJO} SinPapel`);
  await api(`/api/conversations/${sinRol.id}/messages`, { method: "POST", body: JSON.stringify({ text: "hola" }) });
  await sleep(1000);
  ok("sin etapa con el papel «En conversación», responder no mueve ni falla", (await donde(sinRol.contact.id))?.rol === "new");
  await api(`/api/pipeline/stages/${stage.conversation}`, { method: "PATCH", body: JSON.stringify({ autoRole: "conversation" }) });
  await api(`/api/pipeline/stages/${extraId}`, { method: "DELETE" });
  await modo("normal");
} catch (err) {
  failures++;
  console.log(`  ✗ el guion se interrumpió — ${err instanceof Error ? err.stack : err}`);
} finally {
  await modo("normal").catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (sql && org) {
    await sql`delete from contact where organization_id = ${org} and (id like ${"ct_tab" + RUN + "%"} or id = any(${contactos}))`;
    await sql.end();
  }
}

console.log(`\n${checks - failures}/${checks} comprobaciones en verde`);
process.exit(failures ? 1 : 0);
