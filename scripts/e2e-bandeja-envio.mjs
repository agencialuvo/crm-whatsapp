/**
 * Self-test E2E de comportamiento — envío robusto de la Bandeja y reconciliación de estados (spec 041).
 *
 * Recorre, contra la app real y el mock de la Graph API, lo que vería el operador:
 *   - la carrera del estado temprano: Meta manda `delivered` ANTES de responder al envío y el mensaje igual
 *     termina entregado (texto, plantilla, ubicación, contacto y adjunto), sin quedarse con el reloj;
 *   - un fallo de Meta deja una burbuja roja con el motivo en los cinco tipos, y el texto vuelve al compositor;
 *   - una ventana cerrada se rechaza sin dejar burbuja;
 *   - una llamada a Meta que no responde se corta y se avisa de que pudo haber salido;
 *   - la barredera rescata un envío sin confirmar que nadie va a cerrar.
 *
 * Uso: node --env-file=.env scripts/e2e-bandeja-envio.mjs     (pnpm test:e2e:bandeja-envio)
 * Requiere: `pnpm e2e:cuentas crear`, la app viva con los mocks (WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL →
 * wa-mock) y, para acortar las esperas, META_GRAPH_TIMEOUT_MS=2500 y OUTBOX_SWEEP_AFTER_MS=5000. La BD migrada.
 * Capturas en CAPTURAS_DIR (por defecto scratch/bandeja-envio).
 */
import { chromium } from "playwright";
import postgres from "postgres";
import { existsSync, mkdirSync } from "node:fs";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const PN = "PN-BANDEJA-1";
const SALIDA = process.env.CAPTURAS_DIR ?? "scratch/bandeja-envio";
const RUN = String(Date.now()).slice(-6);
const CORREO = "automations-e2e@vocero.test";
const PASSWORD = "password-e2e-123";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

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
const jar = new Map();
function guardaCookies(res) {
  const set = res.headers.getSetCookie?.() ?? [];
  for (const c of set) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
  if (set.length) cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}
async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
  });
  guardaCookies(res);
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* sin cuerpo */
  }
  return { status: res.status, ok: res.ok, json };
}
/** Subida multipart (el `content-type` lo pone fetch, con su frontera). */
async function adjunto(conversationId) {
  const form = new FormData();
  form.set("file", new Blob([PNG], { type: "image/png" }), "prueba.png");
  const res = await fetch(`${BASE}/api/conversations/${conversationId}/messages/media`, {
    method: "POST",
    body: form,
    headers: { origin: BASE, cookie },
  });
  return { status: res.status, ok: res.ok, json: await res.json().catch(() => null) };
}

const sql = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1 }) : null;
const modo = (m) => api("/api/dev/wa-mock/modo", { method: "POST", body: JSON.stringify({ modo: m }) });
const mensajes = async (cv) => (await api(`/api/conversations/${cv}/messages`)).json?.messages ?? [];
const enviarTexto = (cv, text) => api(`/api/conversations/${cv}/messages`, { method: "POST", body: JSON.stringify({ text }) });
const enviarUbicacion = (cv) =>
  api(`/api/conversations/${cv}/messages`, { method: "POST", body: JSON.stringify({ type: "location", location: { latitude: 21.01, longitude: -101.25 } }) });
const enviarContacto = (cv) =>
  api(`/api/conversations/${cv}/messages`, {
    method: "POST",
    body: JSON.stringify({ type: "contacts", contacts: [{ name: "Ana Prueba", phone: "5215512345678" }] }),
  });
const enviarPlantilla = (cv, templateId) =>
  api(`/api/conversations/${cv}/messages/template`, { method: "POST", body: JSON.stringify({ templateId, variables: ["Ana"] }) });

async function espera(cond, ms = 15000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    const v = await cond();
    if (v) return v;
    await sleep(300);
  }
  return null;
}

let org = "";
let tpl = "";
let browser = null;
const contactos = [];
const DIG = String(Date.now()).slice(-6);
let n = 0;

/** Un cliente que escribe por WhatsApp: crea su conversación real, con la ventana abierta. */
async function cliente(nombre) {
  const idx = ++n;
  await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({ phoneNumberId: PN, waMessageId: `wamid.bandeja.${RUN}.${idx}`, from: `52155${DIG}${String(idx).padStart(2, "0")}`, name: nombre, text: "Hola" }),
  });
  const hallada = await espera(async () => {
    const lista = (await api(`/api/conversations?q=${encodeURIComponent(nombre)}`)).json?.conversations ?? [];
    return lista.find((c) => c.contact.name === nombre);
  });
  if (!hallada) throw new Error(`la conversación de ${nombre} no apareció`);
  contactos.push(hallada.contact.id);
  return hallada;
}

try {
  console.log("== Setup ==");
  let r = await api("/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email: CORREO, password: PASSWORD }) });
  ok("login", r.ok);
  // La cuenta nueva trae el modal «Personaliza tu espacio»: se descarta como lo haría el dueño, para que no tape la pantalla.
  await api("/api/organization/sector", { method: "PUT", body: JSON.stringify({ action: "skip" }) });
  r = await api("/api/settings/whatsapp", { method: "PUT", body: JSON.stringify({ wabaId: "WABA-BANDEJA", phoneNumberId: PN, token: "tok-bandeja" }) });
  ok("número de WhatsApp conectado al mock", r.ok, `status ${r.status}`);
  if (sql) {
    const rows = await sql`select organization_id from member where user_id = (select id from "user" where email = ${CORREO}) limit 1`;
    org = rows[0]?.organization_id ?? "";
    tpl = `tpl_bandeja${RUN}`;
    await sql`insert into template (id, organization_id, name, language, category, body, status)
              values (${tpl}, ${org}, ${"bandeja_" + RUN}, 'es_MX', 'UTILITY', 'Hola {{1}}, te escribimos de la clínica', 'approved')`;
  }
  ok("hay organización y plantilla de prueba", Boolean(org && tpl));
  await modo("normal");

  console.log("\n== Envío normal: queda registrado con su id y a la espera del acuse ==");
  const normal = await cliente(`Normal ${RUN}`);
  r = await enviarTexto(normal.id, "hola desde la bandeja");
  ok("el texto se envía (200 con messageId)", r.ok && r.json?.messageId, `status ${r.status}`);
  let msgs = await mensajes(normal.id);
  const salida = msgs.find((m) => m.direction === "out");
  ok("queda UNA burbuja saliente", msgs.filter((m) => m.direction === "out").length === 1);
  ok("en pending (el acuse llega por webhook), sin error", salida?.status === "pending" && !salida?.error, JSON.stringify(salida));
  if (sql) {
    const [fila] = await sql`select wa_message_id from message where id = ${salida.id}`;
    ok("la fila guarda el id de Meta", Boolean(fila?.wa_message_id));
  }

  console.log("\n== Carrera: Meta manda el acuse ANTES de responder al envío ==");
  await modo("estadoprimero");
  const carrera = await cliente(`Carrera ${RUN}`);
  const tipos = [
    ["texto", () => enviarTexto(carrera.id, "primero el acuse")],
    ["plantilla", () => enviarPlantilla(carrera.id, tpl)],
    ["ubicación", () => enviarUbicacion(carrera.id)],
    ["contacto", () => enviarContacto(carrera.id)],
    ["adjunto", () => adjunto(carrera.id)],
  ];
  for (const [nombre, envia] of tipos) {
    const res = await envia();
    ok(`${nombre}: el envío responde bien`, res.ok, `status ${res.status} ${JSON.stringify(res.json)}`);
  }
  const entregados = await espera(async () => {
    const salientes = (await mensajes(carrera.id)).filter((m) => m.direction === "out");
    return salientes.length === 5 && salientes.every((m) => m.status === "delivered") ? salientes : null;
  });
  ok("los cinco terminan en delivered, ninguno se queda con el reloj", Boolean(entregados), JSON.stringify((await mensajes(carrera.id)).map((m) => `${m.type}:${m.status}`)));
  if (sql) {
    const [o] = await sql`select count(*)::int as n from message_status_orphan where organization_id = ${org} and wa_message_id in (select wa_message_id from message where conversation_id = ${carrera.id})`;
    ok("el búfer de huérfanos quedó vacío", o.n === 0, `n=${o.n}`);
  }

  console.log("\n== Fallo de Meta: burbuja roja con el motivo, en los cinco tipos ==");
  await modo("fallo");
  const falla = await cliente(`Falla ${RUN}`);
  const fallos = [
    ["texto", () => enviarTexto(falla.id, "esto va a fallar")],
    ["plantilla", () => enviarPlantilla(falla.id, tpl)],
    ["ubicación", () => enviarUbicacion(falla.id)],
    ["contacto", () => enviarContacto(falla.id)],
    ["adjunto", () => adjunto(falla.id)],
  ];
  for (const [nombre, envia] of fallos) {
    const res = await envia();
    ok(`${nombre}: la API responde con error y mensaje legible`, !res.ok && Boolean(res.json?.error?.message), `status ${res.status} ${JSON.stringify(res.json)}`);
  }
  const falladas = (await mensajes(falla.id)).filter((m) => m.direction === "out");
  ok("hay cinco burbujas salientes (ninguna se perdió)", falladas.length === 5, `hay ${falladas.length}`);
  ok("todas en failed y con motivo", falladas.every((m) => m.status === "failed" && m.error), JSON.stringify(falladas.map((m) => `${m.type}:${m.status}`)));
  const ubic = falladas.find((m) => m.type === "location");
  ok("la ubicación fallida conserva su contenido", Boolean(ubic?.media?.payload?.latitude));

  console.log("\n== Ventana cerrada: se rechaza sin dejar burbuja ==");
  await modo("normal");
  const cerrada = await cliente(`Cerrada ${RUN}`);
  if (sql) await sql`update conversation set last_inbound_at = now() - interval '30 hours' where id = ${cerrada.id}`;
  const antes = (await mensajes(cerrada.id)).filter((m) => m.direction === "out").length;
  r = await enviarTexto(cerrada.id, "ya no cabe");
  ok("409 window_closed", r.status === 409 && r.json?.error?.code === "window_closed", `status ${r.status}`);
  ok("no queda burbuja", (await mensajes(cerrada.id)).filter((m) => m.direction === "out").length === antes);
  r = await enviarPlantilla(cerrada.id, tpl);
  ok("la plantilla SÍ sale con la ventana cerrada", r.ok, `status ${r.status} ${JSON.stringify(r.json)}`);

  console.log("\n== Meta no responde: se corta y se avisa de que pudo haber salido ==");
  await modo("colgado");
  const colgada = await cliente(`Colgada ${RUN}`);
  const t0 = Date.now();
  r = await enviarTexto(colgada.id, "nadie contesta");
  const seg = (Date.now() - t0) / 1000;
  ok("termina por tiempo, no se cuelga", seg < 30, `${seg.toFixed(1)} s`);
  ok("503 con el aviso de ambigüedad", r.status === 503 && /pudo haber salido/.test(r.json?.error?.message ?? ""), `status ${r.status} ${JSON.stringify(r.json)}`);
  const colg = (await mensajes(colgada.id)).filter((m) => m.direction === "out");
  ok("la burbuja queda failed con ese aviso", colg.length === 1 && colg[0].status === "failed" && /pudo haber salido/.test(colg[0].error ?? ""));
  await modo("normal");

  console.log("\n== Barredera: un envío sin confirmar que nadie va a cerrar ==");
  const huerfana = await cliente(`Huerfana ${RUN}`);
  let viejaId = "";
  if (sql) {
    viejaId = `msg_bandeja${RUN}`;
    await sql`insert into message (id, organization_id, conversation_id, direction, type, text, status, origin, created_at)
              values (${viejaId}, ${org}, ${huerfana.id}, 'out', 'text', 'se perdió en un reinicio', 'pending', 'operator', now() - interval '10 minutes')`;
    const volteada = await espera(async () => {
      const [m] = await sql`select status, error from message where id = ${viejaId}`;
      return m?.status === "failed" ? m : null;
    }, 80000);
    ok("la barredera la pasa a failed (≤ 70 s)", Boolean(volteada), "sigue pending");
    ok("con el aviso de posible envío incompleto", /Posible envío incompleto/.test(volteada?.error ?? ""), volteada?.error);
  }

  console.log("\n== En pantalla: la burbuja roja y el texto de vuelta en el compositor ==");
  if (!existsSync(SALIDA)) mkdirSync(SALIDA, { recursive: true });
  browser = await chromium.launch(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {});
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const login = await ctx.request.post(`${BASE}/api/auth/sign-in/email`, { data: { email: CORREO, password: PASSWORD } });
  ok("sesión del navegador", login.ok());
  const page = await ctx.newPage();
  await page.goto(`${BASE}/bandeja?contact=${falla.contact.id}`, { waitUntil: "domcontentloaded" });
  // El modal de bienvenida de una cuenta nueva tapa la pantalla: se cierra como lo haría el dueño.
  await page.getByRole("button", { name: "Configurar más tarde" }).click({ timeout: 8000 }).catch(() => {});
  await page.waitForSelector("text=No se entregó.", { timeout: 15000 }).catch(() => {});
  ok("la bandeja muestra «No se entregó.» con el motivo", (await page.locator("text=No se entregó.").count()) >= 1);
  await page.screenshot({ path: `${SALIDA}/01-burbujas-fallidas.png` });

  await modo("fallo");
  const caja = page.getByPlaceholder("Escribe una respuesta…");
  await caja.fill("este texto debe volver");
  await caja.press("Enter");
  // El servidor de desarrollo puede tardar varios segundos en compilar: se espera el resultado, no un reloj.
  const volvio = await espera(async () => (await caja.inputValue()) === "este texto debe volver", 40000);
  ok("el texto que no salió vuelve al compositor", Boolean(volvio), `valor: "${await caja.inputValue()}"`);
  const fallidas = await espera(async () => {
    const f = (await mensajes(falla.id)).filter((m) => m.status === "failed" && m.text === "este texto debe volver");
    return f.length ? f : null;
  }, 10000);
  ok("y además queda su burbuja fallida en el hilo (una sola)", fallidas?.length === 1, `hay ${fallidas?.length ?? 0}`);
  await page.screenshot({ path: `${SALIDA}/02-texto-devuelto.png` });
  await modo("normal");
} catch (err) {
  failures++;
  console.log(`  ✗ el guion se interrumpió — ${err instanceof Error ? err.stack : err}`);
} finally {
  await modo("normal").catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (sql && org) {
    if (contactos.length) {
      await sql`delete from conversation where contact_id = any(${contactos})`;
      await sql`delete from contact where id = any(${contactos})`;
    }
    if (tpl) await sql`delete from template where id = ${tpl}`;
    await sql.end();
  }
}

console.log(`\n${checks - failures}/${checks} comprobaciones en verde`);
process.exit(failures ? 1 : 0);
