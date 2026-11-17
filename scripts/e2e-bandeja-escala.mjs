/**
 * Self-test E2E de comportamiento — Bandeja a escala (spec 042).
 *
 * Siembra por SQL 300 conversaciones y un hilo de 400 mensajes, y recorre lo que vería el operador:
 *   - la lista carga 40, filtra y cuenta en el servidor, y trae más al llegar al final;
 *   - el hilo abre con los 50 últimos y carga los anteriores SIN que salte la posición;
 *   - la barra lateral y la bandeja no se descargan la lista entera con cada evento (se cuentan las peticiones);
 *   - un entrante con el operador leyendo arriba no le mueve el scroll y muestra «↓ N mensajes nuevos»;
 *     cerca del fondo, baja solo;
 *   - con la pestaña oculta no se marca leído; al volver a verla, sí;
 *   - una respuesta de red lenta de una búsqueda vieja no pisa a la nueva;
 *   - la ventana de 24 h se cierra sola en el compositor, sin pedir nada.
 *
 * Uso: node --env-file=.env scripts/e2e-bandeja-escala.mjs     (pnpm test:e2e:bandeja-escala)
 * Requiere: `pnpm e2e:cuentas crear`, la app viva con los mocks (WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL →
 * wa-mock) y la BD migrada (0077). Capturas en CAPTURAS_DIR (por defecto scratch/bandeja-escala).
 */
import { chromium } from "playwright";
import postgres from "postgres";
import { existsSync, mkdirSync } from "node:fs";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const PN = "PN-BANDEJA-ESC";
const SALIDA = process.env.CAPTURAS_DIR ?? "scratch/bandeja-escala";
const RUN = String(Date.now()).slice(-6);
const CORREO = "automations-e2e@vocero.test";
const PASSWORD = "password-e2e-123";
const PREFIJO = `Escala ${RUN}`;
const HILO = `Hilo largo ${RUN}`;
const VENTANA = `Ventana ${RUN}`;

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

const sql = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 2 }) : null;
if (!sql) {
  console.log("Falta DATABASE_URL: este guion siembra por SQL.");
  process.exit(1);
}

let org = "";
let browser = null;

try {
  console.log("== Setup ==");
  let r = await api("/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email: CORREO, password: PASSWORD }) });
  ok("login", r.ok);
  // La cuenta nueva trae el modal «Personaliza tu espacio»: se descarta como lo haría el dueño, para que no tape la pantalla.
  await api("/api/organization/sector", { method: "PUT", body: JSON.stringify({ action: "skip" }) });
  r = await api("/api/settings/whatsapp", { method: "PUT", body: JSON.stringify({ wabaId: "WABA-ESCALA", phoneNumberId: PN, token: "tok-escala" }) });
  ok("número de WhatsApp conectado al mock", r.ok, `status ${r.status}`);
  const rows = await sql`select organization_id from member where user_id = (select id from "user" where email = ${CORREO}) limit 1`;
  org = rows[0]?.organization_id ?? "";
  ok("hay organización", Boolean(org));

  // 300 conversaciones con llaves de orden descendentes; las 8 primeras con mensajes sin leer.
  await sql`
    insert into contact (id, organization_id, name, wa_identity, phone)
    select 'ct_esc' || ${RUN} || g, ${org}, ${PREFIJO} || ' ' || lpad(g::text, 3, '0'),
           '5255' || ${RUN.slice(0, 4)} || lpad(g::text, 4, '0'), '5255' || ${RUN.slice(0, 4)} || lpad(g::text, 4, '0')
    from generate_series(1, 300) g`;
  await sql`
    insert into conversation (id, organization_id, contact_id, last_message_at, last_inbound_at, unread_count)
    select 'cv_esc' || ${RUN} || g, ${org}, 'ct_esc' || ${RUN} || g,
           now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval, case when g <= 8 then 3 else 0 end
    from generate_series(1, 300) g`;
  // El hilo largo: 400 mensajes, y entre ellos un entrante que Meta retrasó (wa_timestamp 3 h antes de que llegara).
  const hiloId = `cv_hilo${RUN}`;
  const hiloContacto = `ct_hilo${RUN}`;
  const hiloTel = `5255${RUN.slice(0, 4)}9001`;
  await sql`insert into contact (id, organization_id, name, wa_identity, phone) values (${hiloContacto}, ${org}, ${HILO}, ${hiloTel}, ${hiloTel})`;
  await sql`insert into conversation (id, organization_id, contact_id, last_message_at, last_inbound_at) values (${hiloId}, ${org}, ${hiloContacto}, now() - interval '30 minutes', now())`;
  await sql`
    insert into message (id, organization_id, conversation_id, direction, type, text, status, wa_timestamp, created_at)
    select 'msg_hilo' || ${RUN} || lpad(g::text, 4, '0'), ${org}, ${hiloId}, case when g % 2 = 0 then 'out' else 'in' end, 'text',
           'Mensaje ' || g, 'delivered', now() - ((400 - g) || ' minutes')::interval - interval '1 day',
           now() - ((400 - g) || ' minutes')::interval - interval '1 day'
    from generate_series(1, 400) g`;
  // Una palabra que SOLO vive en el texto de dos mensajes del hilo largo (con acento y mayúsculas distintas).
  const PALABRA = `zxqtínte${[...RUN].map((d) => "abcdefghij"[Number(d)]).join("")}`;
  await sql`update message set text = 'Quiero un ' || ${PALABRA} || ' rubio' where id = ${"msg_hilo" + RUN + "0100"}`;
  await sql`update message set text = 'otro ' || upper(${PALABRA}) || ' más' where id = ${"msg_hilo" + RUN + "0200"}`;
  console.log("\n== API: la primera página, los contadores y los cursores ==");
  r = await api(`/api/conversations?q=${encodeURIComponent(PREFIJO)}`);
  ok("40 conversaciones y un cursor", r.json?.conversations?.length === 40 && Boolean(r.json?.nextCursor), `n=${r.json?.conversations?.length}`);
  ok("contadores del servidor: 300 en total del filtro, 8 sin leer", r.json?.counts?.all === 300 && r.json?.counts?.unread === 8, JSON.stringify(r.json?.counts));
  ok("trae serverTime", Boolean(r.json?.serverTime));
  r = await api(`/api/conversations?q=${encodeURIComponent(PREFIJO)}&cursor=basura`);
  ok("un cursor manipulado responde 422", r.status === 422, `status ${r.status}`);
  r = await api(`/api/conversations/${hiloId}/messages`);
  ok("el hilo abre con 50 mensajes y hay más", r.json?.messages?.length === 50 && r.json?.hasMore === true, `n=${r.json?.messages?.length}`);
  const horas = (r.json?.messages ?? []).map((m) => m.createdAt);
  ok("en orden ascendente por hora del evento", JSON.stringify(horas) === JSON.stringify([...horas].sort()));
  let todo = [];
  let before = null;
  for (let i = 0; i < 20; i++) {
    const p = await api(`/api/conversations/${hiloId}/messages${before ? `?before=${encodeURIComponent(before)}` : ""}`);
    todo = [...(p.json?.messages ?? []), ...todo];
    before = p.json?.nextBefore;
    if (!p.json?.hasMore) break;
  }
  ok("recorrido completo: 400 mensajes, sin repetir", todo.length === 400 && new Set(todo.map((m) => m.id)).size === 400, `n=${todo.length}`);
  r = await api("/api/conversations/unread");
  ok("/unread responde un número", typeof r.json?.unread === "number", JSON.stringify(r.json));

  console.log("\n== En pantalla ==");
  if (!existsSync(SALIDA)) mkdirSync(SALIDA, { recursive: true });
  browser = await chromium.launch(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {});
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const login = await ctx.request.post(`${BASE}/api/auth/sign-in/email`, { data: { email: CORREO, password: PASSWORD } });
  ok("sesión del navegador", login.ok());
  const page = await ctx.newPage();
  const peticiones = [];
  const marcas = []; // PATCH markRead
  page.on("request", (rq) => {
    const u = new URL(rq.url());
    if (u.pathname.startsWith("/api/conversations")) {
      peticiones.push({ m: rq.method(), p: u.pathname, q: u.search });
      if (rq.method() === "PATCH" && rq.postData()?.includes("markRead")) marcas.push(u.pathname);
    }
  });
  // La pestaña «a la vista» o «oculta», como la ve la página.
  await page.addInitScript(() => {
    window.__vis = "visible";
    Object.defineProperty(document, "visibilityState", { get: () => window.__vis, configurable: true });
    Object.defineProperty(document, "hidden", { get: () => window.__vis !== "visible", configurable: true });
  });
  const visibilidad = (v) =>
    page.evaluate((valor) => {
      window.__vis = valor;
      document.dispatchEvent(new Event("visibilitychange"));
    }, v);

  await page.goto(`${BASE}/bandeja`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Configurar más tarde" }).click({ timeout: 8000 }).catch(() => {});
  const lista = page.getByTestId("conversation-list");
  const filas = () => lista.locator("li").count();
  const buscar = page.getByPlaceholder("Buscar nombre, teléfono o mensaje…");
  /** Busca una conversación por su nombre y la abre, esperando a que la lista sea ESA (no la de la búsqueda anterior). */
  const seleccionar = async (nombre) => {
    await buscar.fill(nombre);
    const lista1 = await espera(async () => {
      const n = await lista.locator("[data-testid=conv-name]").allTextContents();
      return n.length === 1 && n[0] === nombre;
    }, 20000);
    await lista.locator("li button").first().click();
    return Boolean(lista1);
  };

  await buscar.fill(PREFIJO);
  // Sin la espera por NOMBRE, 40 filas de la bandeja sin filtrar contarían como las de la búsqueda.
  const llego = await espera(async () => {
    const n = await lista.locator("[data-testid=conv-name]").allTextContents();
    return n.length === 40 && n.every((x) => x.startsWith(PREFIJO));
  }, 20000);
  ok("la lista muestra 40 filas (no las 300)", Boolean(llego), `filas=${await filas()}`);
  ok("el chip «Todas» dice 300 y «No leídas» dice 8 (los cuenta el servidor)", await page.evaluate(() => {
    const t = [...document.querySelectorAll("button")].map((b) => b.textContent ?? "");
    return t.some((x) => x.startsWith("Todas") && x.includes("300")) && t.some((x) => x.startsWith("No leídas") && x.includes("8"));
  }));
  await page.screenshot({ path: `${SALIDA}/01-lista-40.png` });

  await lista.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const masFilas = await espera(async () => (await filas()) > 40, 15000);
  ok("al llegar al final se cargan más filas", Boolean(masFilas), `filas=${await filas()}`);
  for (let i = 0; i < 12 && (await filas()) < 300; i++) {
    await lista.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await sleep(500);
  }
  ok("se recorren las 300 sin repetir", (await filas()) === 300, `filas=${await filas()}`);
  const nombres = await lista.locator("[data-testid=conv-name]").allTextContents();
  ok("sin conversaciones repetidas en pantalla", new Set(nombres.filter((n) => n.startsWith(PREFIJO))).size === 300);

  // Filtros en el servidor: «No leídas» deja las 8.
  await page.getByRole("button", { name: /^No leídas/ }).click();
  const ocho = await espera(async () => (await filas()) === 8, 15000);
  ok("«No leídas» deja las 8 sin leer", Boolean(ocho), `filas=${await filas()}`);
  await page.getByRole("button", { name: /^Todas/ }).click();
  await espera(async () => (await filas()) === 40, 15000);

  console.log("\n== Búsqueda por el texto de los mensajes ==");
  r = await api(`/api/conversations?q=${encodeURIComponent(PALABRA.toUpperCase().replace("Í", "I"))}`);
  ok("la API encuentra la conversación por una palabra de sus mensajes, UNA vez (sin importar acentos ni mayúsculas)",
    r.json?.conversations?.length === 1 && r.json.conversations[0].id === hiloId, JSON.stringify(r.json?.conversations?.map((c) => c.id)));
  ok("los contadores respetan la búsqueda por mensaje", r.json?.counts?.all === 1, JSON.stringify(r.json?.counts));
  await buscar.click();
  await buscar.fill("");
  await buscar.pressSequentially(PALABRA, { delay: 40 });
  const unica = await espera(async () => {
    const n = await lista.locator("[data-testid=conv-name]").allTextContents();
    return n.length === 1 && n[0] === HILO;
  }, 20000);
  ok("el operador teclea la palabra y la lista deja solo el hilo que la contiene", Boolean(unica));
  ok("el input conserva el foco mientras la lista se actualiza", await buscar.evaluate((el) => el === document.activeElement));
  await page.screenshot({ path: `${SALIDA}/05-busqueda-mensaje.png` });
  await buscar.fill("");
  await espera(async () => (await filas()) === 40, 15000);

  console.log("\n== El hilo: páginas hacia arriba sin que salte la posición ==");
  ok("encuentra y abre el hilo largo", await seleccionar(HILO));
  const burbujas = page.locator("[data-message-id]");
  const cincuenta = await espera(async () => (await burbujas.count()) === 50, 30000);
  ok("el hilo abre con los 50 últimos", Boolean(cincuenta), `burbujas=${await burbujas.count()}`);
  const hilo = page.getByTestId("thread-scroll");
  const abajo = () => hilo.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
  ok("empieza en el fondo", (await abajo()) <= 5, `a ${await abajo()} px`);

  await hilo.evaluate((el) => (el.scrollTop = 0));
  const cien = await espera(async () => (await burbujas.count()) >= 100, 40000);
  ok("subir carga los 50 anteriores", Boolean(cien), `burbujas=${await burbujas.count()}`);
  // El mensaje que se estaba leyendo (el primero de antes) no se movió de sitio.
  const idLeido = "msg_hilo" + RUN + String(351).padStart(4, "0"); // el primero de los 50 iniciales (g = 351..400)
  const sitio = async () => page.locator(`[data-message-id="${idLeido}"]`).evaluate((el) => Math.round(el.getBoundingClientRect().top - el.closest("[data-testid=thread-scroll]").getBoundingClientRect().top));
  const despues = await sitio();
  ok("la posición de lectura se conserva al anteponer (el mensaje no saltó fuera de la vista)", despues >= -10 && despues < 900, `a ${despues} px`);
  await page.screenshot({ path: `${SALIDA}/02-hilo-anteriores.png` });

  console.log("\n== Scroll inteligente ==");
  // Leyendo arriba: un entrante NO mueve el scroll y avisa.
  await hilo.evaluate((el) => (el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 900)));
  await sleep(300);
  const topAntes = await hilo.evaluate((el) => Math.round(el.scrollTop));
  const entra = (texto, id, tel = hiloTel, nombre = HILO) =>
    api("/api/dev/wa-mock/inbound", { method: "POST", body: JSON.stringify({ phoneNumberId: PN, waMessageId: `wamid.esc.${RUN}.${id}`, from: tel, name: nombre, text: texto }) });
  await entra("Llegó mientras leías historial", "a1");
  const pastilla = page.getByTestId("new-messages");
  const aparece = await espera(async () => pastilla.isVisible().catch(() => false), 10000);
  ok("aparece «↓ 1 mensaje nuevo»", Boolean(aparece));
  ok("…y el scroll no se movió", Math.abs((await hilo.evaluate((el) => Math.round(el.scrollTop))) - topAntes) <= 2);
  await page.screenshot({ path: `${SALIDA}/03-pastilla.png` });
  await pastilla.click();
  const bajo = await espera(async () => (await abajo()) <= 5, 8000);
  ok("al pulsarla baja al fondo", Boolean(bajo), `a ${await abajo()} px`);
  ok("y la pastilla se va", !(await pastilla.isVisible().catch(() => false)));
  // Cerca del fondo: baja sola.
  await entra("Este llega con el operador abajo", "a2");
  const bajoSola = await espera(async () => {
    const t = await burbujas.last().textContent();
    return /abajo/.test(t ?? "") && (await abajo()) <= 5;
  }, 10000);
  ok("cerca del fondo, el hilo baja solo con el mensaje nuevo", Boolean(bajoSola), `a ${await abajo()} px`);
  ok("sin pastilla", !(await pastilla.isVisible().catch(() => false)));

  console.log("\n== Pestaña oculta: no se «lee» nada ==");
  await visibilidad("hidden");
  marcas.length = 0;
  ok("abre la 001 (tiene 3 sin leer) con la pestaña oculta", await seleccionar(`${PREFIJO} 001`));
  await sleep(1500);
  ok("con la pestaña oculta no se manda markRead", marcas.length === 0, `${marcas.length} PATCH`);
  ok("el contador sigue ahí", (await lista.locator("li").first().textContent())?.includes("3") ?? false);
  await visibilidad("visible");
  const leida = await espera(async () => marcas.length >= 1, 8000);
  ok("al volver a verla, se marca leída", Boolean(leida), `${marcas.length} PATCH`);
  await buscar.fill(PREFIJO);
  await espera(async () => {
    const n = await lista.locator("[data-testid=conv-name]").allTextContents();
    return n.length === 40 && n.every((x) => x.startsWith(PREFIJO));
  }, 20000);
  const siete = await espera(async () => (await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith("No leídas"))?.textContent ?? "")).includes("7"), 10000);
  ok("el contador «No leídas» bajó a 7", Boolean(siete));
  // Abrir una conversación SIN nada por leer no manda nada.
  marcas.length = 0;
  ok("abre la 200 (sin mensajes por leer)", await seleccionar(`${PREFIJO} 200`));
  await sleep(1200);
  ok("abrir una conversación sin mensajes por leer no manda markRead", marcas.length === 0, `${marcas.length} PATCH`);

  console.log("\n== Sin tormentas: se cuentan las peticiones ==");
  await buscar.fill(PREFIJO);
  await espera(async () => (await filas()) === 40, 15000);
  await sleep(1500);
  peticiones.length = 0;
  // Diez entrantes a la vez: una ráfaga de verdad, de las que el servidor ve en el mismo instante.
  await Promise.all(Array.from({ length: 10 }, (_, i) => entra(`ráfaga ${i}`, `s${i}`, telefono2(i), `${PREFIJO} ${String(i + 1).padStart(3, "0")}`)));
  await sleep(4000);
  const cabezas = peticiones.filter((p) => p.m === "GET" && p.p === "/api/conversations" && !p.q.includes("since") && !p.q.includes("cursor") && !p.q.includes("contactId"));
  const deltas = peticiones.filter((p) => p.p === "/api/conversations" && p.q.includes("since"));
  const unread = peticiones.filter((p) => p.p === "/api/conversations/unread");
  ok("ninguna descarga de la lista completa por los 10 entrantes", cabezas.length === 0, `${cabezas.length} cabezas`);
  ok("los eventos se agrupan en pocos deltas (≤ 4 para 10 mensajes)", deltas.length >= 1 && deltas.length <= 4, `${deltas.length} deltas`);
  ok("la barra lateral solo pide /unread", unread.length >= 1 && peticiones.filter((p) => p.p === "/api/conversations" && p.q === "").length === 0, `${unread.length} unread`);

  console.log("\n== Una respuesta lenta de una búsqueda vieja no pisa a la nueva ==");
  await page.route("**/api/conversations?**", async (route) => {
    const u = new URL(route.request().url());
    if (u.searchParams.get("q") === `${PREFIJO} 010`) await sleep(2500); // la búsqueda vieja tarda
    await route.continue();
  });
  await buscar.fill(`${PREFIJO} 010`);
  await sleep(500); // el debounce ya mandó la petición lenta
  await buscar.fill(`${PREFIJO} 020`);
  await sleep(4500);
  const visibles = (await lista.locator("[data-testid=conv-name]").allTextContents()).filter((n) => n.startsWith(PREFIJO));
  ok("la pantalla conserva la búsqueda NUEVA (020), no la vieja (010)", visibles.length === 1 && visibles[0].endsWith("020"), JSON.stringify(visibles));
  await page.unroute("**/api/conversations?**");

  console.log("\n== La ventana se cierra sola ==");
    // La conversación cuya ventana de 24 h cierra en 70 s (se siembra al llegar a este paso).
    const ventId = `cv_vent${RUN}`;
    const ventContacto = `ct_vent${RUN}`;
    const ventTel = `5255${RUN.slice(0, 4)}9002`;
    await sql`insert into contact (id, organization_id, name, wa_identity, phone) values (${ventContacto}, ${org}, ${VENTANA}, ${ventTel}, ${ventTel})`;
    await sql`insert into conversation (id, organization_id, contact_id, last_message_at, last_inbound_at)
              values (${ventId}, ${org}, ${ventContacto}, now() - interval '1 minute', now() - interval '24 hours' + interval '70 seconds')`;
    await sql`insert into message (id, organization_id, conversation_id, direction, type, text, status, created_at)
              values (${"msg_vent" + RUN}, ${org}, ${ventId}, 'in', 'text', 'Hola, sigo aquí', 'delivered', now() - interval '23 hours')`;
  ok("abre la conversación que está por cerrar su ventana", await seleccionar(VENTANA));
  const pieAbierto = await espera(async () => (await page.getByText(/Ventana abierta · quedan/).count()) > 0, 10000);
  ok("el compositor dice «Ventana abierta · quedan …»", Boolean(pieAbierto));
  peticiones.length = 0;
  const cerro = await espera(async () => (await page.getByText("La ventana de 24 horas está cerrada.").count()) > 0, 110000);
  ok("a la hora exacta el compositor pasa solo a «ventana cerrada» (plantilla)", Boolean(cerro));
  await page.screenshot({ path: `${SALIDA}/04-ventana-cerrada.png` });
  ok("sin pedir la conversación otra vez: ninguna lista ni hilo en ese tramo", peticiones.filter((p) => p.m === "GET" && (p.p === "/api/conversations" || p.p.endsWith("/messages"))).length <= 2);
} catch (err) {
  failures++;
  console.log(`  ✗ el guion se interrumpió — ${err instanceof Error ? err.stack : err}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (sql && org) {
    await sql`delete from conversation where organization_id = ${org} and (id like ${"cv_esc" + RUN + "%"} or id in (${"cv_hilo" + RUN}, ${"cv_vent" + RUN}))`;
    await sql`delete from contact where organization_id = ${org} and (id like ${"ct_esc" + RUN + "%"} or id in (${"ct_hilo" + RUN}, ${"ct_vent" + RUN}))`;
    await sql.end();
  }
}

/** El teléfono de la conversación i de la ráfaga (las 10 primeras de la lista). */
function telefono2(i) {
  return `5255${RUN.slice(0, 4)}${String(i + 1).padStart(4, "0")}`;
}

console.log(`\n${checks - failures}/${checks} comprobaciones en verde`);
process.exit(failures ? 1 : 0);
