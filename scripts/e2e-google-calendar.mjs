/**
 * Self-test E2E de comportamiento — Paso 3: Google Calendar (tests/e2e/us-google-calendar.md).
 *
 * Contra la app REAL y el mock de Google (`/api/dev/google-mock`), como usuario:
 *  1. Ajustes → Agenda muestra «Sin conectar»; «Conectar con Google» pasa por la pantalla de permisos (el
 *     mock la acepta sola) y vuelve con «Conectado como …».
 *  2. Encender «Publicar las citas en Google Calendar» desde la pantalla.
 *  3. Una cita nueva aparece en el calendario sin Meet (conector enlace fijo), con nombre corto y sin teléfono;
 *     moverla mueve el MISMO evento; cancelarla lo borra.
 *  4. Camino infeliz: Google caído → la cita se crea igual (201), queda «error» y reintentando la
 *     sincronización se publica sin duplicar.
 *  5. Paso 4 — Lo ocupado en Google: encender «Tener en cuenta lo ocupado» desde la pantalla; un evento del
 *     dueño bloquea ese horario (ni se ofrece ni se puede reservar, y no se quita desde Vocero); Google
 *     caído → aviso y se conserva lo último leído; borrarlo en Google + «Leer ahora» lo libera; sin permiso
 *     de lectura → «Falta permiso…» con «Reconectar con Google».
 *  6. Desconectar desde la pantalla revoca el permiso, deja «Sin conectar» y quita lo traído de Google.
 *
 * Uso: node --env-file=.env scripts/e2e-google-calendar.mjs
 * Requiere la app corriendo con: AGENDA=on, WA_MOCK_ENABLED=true, GOOGLE_OAUTH_CLIENT_ID/SECRET (cualquier
 * valor), y GOOGLE_CAL_BASE_URL, GOOGLE_OAUTH_BASE_URL y GOOGLE_ACCOUNTS_BASE_URL apuntando a
 * ${APP_BASE_URL}/api/dev/google-mock. Usuario: E2E_EMAIL / E2E_PASSWORD (se registra si no existe).
 */
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? process.env.APP_BASE_URL ?? "http://localhost:3000";
const SHOTS = process.env.E2E_SHOTS ?? null;

let failures = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(cond, ms = 15000, paso = 300) {
  const fin = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > fin) return null;
    await sleep(paso);
  }
}

const browser = await chromium.launch(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const req = ctx.request;
const page = await ctx.newPage();
/** Captura de la tarjeta de Google (la página desplaza por dentro: una captura de pantalla completa no la ve). */
const shot = async (name) => {
  if (!SHOTS) return;
  const card = page.locator("div", { has: page.getByText("Google Calendar", { exact: true }) }).last();
  await card.scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

console.log("== Sesión ==");
const email = process.env.E2E_EMAIL ?? "e2e@vocero.test";
const password = process.env.E2E_PASSWORD ?? "password-e2e-123";
let sesion = await req.post(`${BASE}/api/auth/sign-in/email`, { data: { email, password }, headers: { origin: BASE } });
if (!sesion.ok()) {
  sesion = await req.post(`${BASE}/api/auth/sign-up/email`, { data: { email, password, name: "Operador E2E" }, headers: { origin: BASE } });
}
ok("sesión iniciada", sesion.ok(), `status ${sesion.status()}`);
if (!sesion.ok()) {
  await browser.close();
  process.exit(1);
}

const mock = (path, data) => req.post(`${BASE}/api/dev/google-mock/${path}`, { data: data ?? {} });
const mockState = async () => (await req.get(`${BASE}/api/dev/google-mock/_state`)).json();
const eventOf = async (bookingId) =>
  (await mockState()).events.find((e) => e.privateProps?.voceroBookingId === bookingId) ?? null;

console.log("\n== Preparación ==");
// Un negocio recién creado abre el selector de sector encima de todo: se deja para después, como en los
// demás guiones.
await req.put(`${BASE}/api/organization/sector`, { data: { action: "skip" } });
ok("mock de Google disponible", (await mock("_reset")).ok());
await req.delete(`${BASE}/api/settings/google`);
const all = [{ start: "09:00", end: "18:00" }];
const cfg = await req.put(`${BASE}/api/calendar/settings`, {
  data: {
    weeklyHours: { mon: all, tue: all, wed: all, thu: all, fri: all, sat: all, sun: all },
    minNoticeHours: 0,
    maxDaysAhead: 30,
    connector: "enlace-fijo",
    meetingLink: "https://sala.fija/e2e",
    googleSync: false,
    googleSyncPhone: false,
    googleBusy: false,
  },
});
ok("agenda abierta todos los días, conector enlace fijo, sincronización apagada", cfg.ok(), `status ${cfg.status()}`);

const phone = `5199${String(Date.now()).slice(-9)}`;
const alta = await req.post(`${BASE}/api/contacts`, { data: { name: "Ana Pérez E2E", phone } });
const contactId = (await alta.json()).contact?.id;
ok("contacto de prueba creado", alta.status() === 201 && !!contactId, `status ${alta.status()}`);

console.log("\n== 1. Conectar con Google en un clic ==");
await page.goto(`${BASE}/ajustes/calendario`);
await page.getByText("Sin conectar.").waitFor({ timeout: 30000 });
ok("Ajustes → Agenda muestra «Sin conectar»", true);
const conectar = page.getByRole("link", { name: "Conectar con Google" });
ok("ofrece «Conectar con Google» (la instancia tiene app OAuth)", (await conectar.count()) === 1);
await shot("google-1-sin-conectar");
await conectar.click();
await page.waitForURL(/\/ajustes\/calendario/, { timeout: 30000 });
await page.getByText("Google Calendar conectado.").waitFor({ timeout: 15000 });
ok("vuelve de Google con el aviso de conexión", true);
const comoCuenta = await page
  .getByText("Conectado como agenda@negocio.mock")
  .waitFor({ timeout: 15000 })
  .then(() => true)
  .catch(() => false);
ok("muestra «Conectado como agenda@negocio.mock»", comoCuenta);
ok("la URL se limpia (sin ?google=…)", !page.url().includes("google="), page.url());
const estado = await (await req.get(`${BASE}/api/settings/google`)).json();
ok("la API dice conectado por OAuth, sin secretos", estado.connection?.status === "connected" && estado.connection?.source === "oauth" && !JSON.stringify(estado).includes("mock-refresh"), JSON.stringify(estado));
await shot("google-2-conectado");

console.log("\n== 2. Encender la publicación desde la pantalla ==");
await page.getByRole("switch", { name: "Publicar las citas en Google Calendar" }).click();
const encendida = await hasta(async () => (await (await req.get(`${BASE}/api/calendar/settings`)).json()).settings.googleSync === true);
ok("«Publicar las citas en Google Calendar» queda encendido", !!encendida);

console.log("\n== 3. Crear, mover y cancelar una cita ==");
const huecos = (await (await req.get(`${BASE}/api/calendar/availability`)).json()).slots ?? [];
ok("hay huecos libres", huecos.length >= 4, `huecos=${huecos.length}`);
const crear = await req.post(`${BASE}/api/bookings`, { data: { kind: "session", contactId, startUtc: huecos[1].startUtc } });
const bookingId = (await crear.json()).booking?.id;
ok("la cita se crea (201)", crear.status() === 201 && !!bookingId, `status ${crear.status()}`);
const ev = await hasta(() => eventOf(bookingId));
ok("aparece en Google Calendar", !!ev);
ok("título con nombre corto y sin Meet", ev?.summary === "Cita — Ana P." && ev?.wantsMeet === false, JSON.stringify(ev));
ok("sin teléfono ni apellido completo", ev && !ev.description.includes(phone) && !ev.description.includes("Pérez"), ev?.description);
ok("con el enlace fijo en el lugar", ev?.location === "https://sala.fija/e2e");
ok("el id del evento es el determinista de Vocero (vcr…)", /^vcr[a-v0-9]+$/.test(ev?.id ?? ""), ev?.id);

const mover = await req.patch(`${BASE}/api/bookings/${bookingId}`, { data: { action: "reschedule", startUtc: huecos[3].startUtc } });
ok("mover la cita", mover.ok(), `status ${mover.status()}`);
const movido = await hasta(async () => {
  const e = await eventOf(bookingId);
  return e && Date.parse(e.start) === Date.parse(huecos[3].startUtc) ? e : null;
});
ok("el MISMO evento se movió (no se creó otro)", !!movido && movido.id === ev?.id && (await mockState()).events.length === 1);

const cancelar = await req.patch(`${BASE}/api/bookings/${bookingId}`, { data: { action: "cancel" } });
ok("cancelar la cita", cancelar.ok());
const borrado = await hasta(async () => ((await mockState()).deleted.includes(ev?.id) ? true : null));
ok("el evento se borró del calendario", !!borrado);

console.log("\n== 4. Google caído: la cita no se pierde ==");
await mock("_fail", { status: 503, count: 3 });
const caida = await req.post(`${BASE}/api/bookings`, { data: { kind: "session", contactId, startUtc: huecos[2].startUtc } });
const caidaId = (await caida.json()).booking?.id;
ok("con Google caído la cita se crea igual (201)", caida.status() === 201 && !!caidaId, `status ${caida.status()}`);
const lista = async () => {
  const from = huecos[0].startUtc.slice(0, 10);
  const to = new Date(Date.parse(huecos[huecos.length - 1].startUtc) + 86400000).toISOString().slice(0, 10);
  return (await (await req.get(`${BASE}/api/bookings?from=${from}&to=${to}`)).json()).bookings ?? [];
};
const conError = await hasta(async () => (await lista()).find((b) => b.id === caidaId && b.calendarSync?.status === "error") ?? null);
ok("la cita queda «error» y se reintentará sola", conError?.calendarSync?.willRetry === true, JSON.stringify(conError?.calendarSync));
await mock("_fail", { status: 503, count: 0 });
const retry = await req.patch(`${BASE}/api/bookings/${caidaId}`, { data: { action: "retry_calendar_sync" } });
ok("reintentar la sincronización", retry.ok());
const recuperada = await hasta(async () => (await lista()).find((b) => b.id === caidaId && b.calendarSync?.status === "synced") ?? null);
ok("tras reintentar queda publicada", !!recuperada);
const eventos = (await mockState()).events.filter((e) => e.privateProps?.voceroBookingId === caidaId);
ok("un solo evento para esa cita (sin duplicados)", eventos.length === 1, `eventos=${eventos.length}`);
await req.patch(`${BASE}/api/bookings/${caidaId}`, { data: { action: "cancel" } });

console.log("\n== 5. Lo ocupado en Google bloquea la agenda (Paso 4) ==");
const ocupado = huecos[6];
const finOcupado = new Date(Date.parse(ocupado.startUtc) + 60 * 60_000).toISOString();
await mock("_external", {
  replace: true,
  events: [
    { id: "dentista", summary: "Dentista", start: { dateTime: ocupado.startUtc }, end: { dateTime: finOcupado } },
    { id: "libre", summary: "Recordatorio", transparency: "transparent", start: { dateTime: huecos[8].startUtc }, end: { dateTime: huecos[9].endUtc } },
  ],
});
const ofrecidos = async () => ((await (await req.get(`${BASE}/api/calendar/availability`)).json()).slots ?? []).map((s) => s.startUtc);
ok("antes de encenderlo, ese horario se ofrece", (await ofrecidos()).includes(ocupado.startUtc));
await page.reload();
await page.getByRole("switch", { name: "Tener en cuenta lo ocupado en Google Calendar" }).click();
const leido = await page
  .getByText(/Última lectura: .* · 1 tramo ocupado/)
  .waitFor({ timeout: 20000 })
  .then(() => true)
  .catch(() => false);
ok("la tarjeta muestra la última lectura con 1 tramo ocupado", leido);
await shot("google-4-ocupado-leido");
ok("ese horario ya NO se ofrece", !(await ofrecidos()).includes(ocupado.startUtc));
ok("lo marcado «Disponible» en Google sigue ofreciéndose", (await ofrecidos()).includes(huecos[8].startUtc));
const bloqueoGoogle = (await lista()).find((b) => b.busySource === "google" && b.scheduledAtUtc === ocupado.startUtc);
ok("aparece en la agenda como bloqueo de Google", bloqueoGoogle?.kind === "block" && bloqueoGoogle?.notes === "Ocupado en Google Calendar", JSON.stringify(bloqueoGoogle));
const encima = await req.post(`${BASE}/api/bookings`, { data: { kind: "session", contactId, startUtc: ocupado.startUtc } });
ok("reservar encima se rechaza (409 slot_taken)", encima.status() === 409 && (await encima.json()).error?.code === "slot_taken", `status ${encima.status()}`);
const quitar = await req.patch(`${BASE}/api/bookings/${bloqueoGoogle?.id}`, { data: { action: "cancel" } });
ok("no se puede quitar desde Vocero (409 external_block)", quitar.status() === 409 && (await quitar.json()).error?.code === "external_block", `status ${quitar.status()}`);
ok("las citas publicadas por Vocero no se leen como ocupado (sin bucle)", (await lista()).filter((b) => b.busySource === "google").length === 1);

await mock("_fail", { status: 503, count: 1 });
await page.getByRole("button", { name: "Leer ahora" }).click();
const avisoCaida = await page.getByText(/No se pudo leer tu calendario/).waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
ok("Google caído: la tarjeta avisa y dice que usa lo último leído", avisoCaida);
ok("…y el bloqueo se conserva", !(await ofrecidos()).includes(ocupado.startUtc));
await shot("google-5-ocupado-caido");

await mock("_external", { replace: true, events: [] });
await page.getByRole("button", { name: "Leer ahora" }).click();
await page.getByText("Calendario leído.").waitFor({ timeout: 15000 }).catch(() => {});
ok("borrado en Google + «Leer ahora»: el horario vuelve a ofrecerse", (await ofrecidos()).includes(ocupado.startUtc));
ok("…y ya no hay bloqueos de Google", (await lista()).every((b) => b.busySource !== "google"));

await mock("_external", { replace: true, events: [{ id: "otra", start: { dateTime: ocupado.startUtc }, end: { dateTime: finOcupado } }] });
await page.getByRole("button", { name: "Leer ahora" }).click();
await page.getByText(/1 tramo ocupado/).waitFor({ timeout: 15000 }).catch(() => {});
await mock("_fail", { status: 403, count: 50 });
await page.getByRole("button", { name: "Leer ahora" }).click();
const sinPermiso = await page.getByText("Falta permiso para leer tu calendario.").waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
ok("sin permiso de lectura: «Falta permiso…» con «Reconectar con Google»", sinPermiso && (await page.getByRole("link", { name: "Reconectar con Google" }).count()) >= 1);
ok("…y se conserva lo último leído", !(await ofrecidos()).includes(ocupado.startUtc));
await shot("google-6-ocupado-sin-permiso");
await mock("_fail", { status: 503, count: 0 });

console.log("\n== 6. Desconectar desde la pantalla ==");
await page.reload();
await page.getByRole("button", { name: "Desconectar" }).first().click();
await page.getByText("Google Calendar desconectado.").waitFor({ timeout: 15000 });
ok("la pantalla confirma la desconexión", true);
const tras = await (await req.get(`${BASE}/api/settings/google`)).json();
ok("ya no hay conexión", tras.connection === null);
ok("el permiso se revocó en Google", (await mockState()).revoked.includes("mock-refresh-oauth"));
ok("desconectar quita lo traído de Google y el horario vuelve a ofrecerse", (await lista()).every((b) => b.busySource !== "google") && (await ofrecidos()).includes(ocupado.startUtc));
await shot("google-3-desconectado");

await req.put(`${BASE}/api/calendar/settings`, { data: { googleSync: false, googleBusy: false } });
await browser.close();
console.log(failures === 0 ? "\nTodo verde." : `\n${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
