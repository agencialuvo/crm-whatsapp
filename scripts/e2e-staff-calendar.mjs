/**
 * Self-test E2E de comportamiento — Mejora 3: calendario por profesional (tests/e2e/us-staff-calendar.md).
 *
 * Contra la app REAL y el mock de Google (`/api/dev/google-mock`), como usuario:
 *  1. Equipo muestra la columna «Google Calendar»; el dueño abre el diálogo de Carla y genera el enlace de
 *     24 h (con «Enviar por WhatsApp» a su teléfono).
 *  2. Carla abre el enlace en OTRO navegador, SIN sesión: ve qué negocio lo pide y qué se lee, pulsa
 *     «Conectar con Google» (el mock la deja entrar con su cuenta personal) y ve «Listo».
 *  3. Reusar el enlace: «Este enlace ya no sirve» (ya se usó).
 *  4. Equipo la muestra «Conectado»; un evento en SU calendario + «Leer ahora» la saca SOLO a ella: reservar
 *     con Carla da 409, «cualquiera» va a Beto, y el tablero pinta su celda «Ocupado en Google».
 *  5. Desactivar a Carla desde Equipo revoca su permiso y libera su horario.
 *
 * Uso: node --env-file=.env scripts/e2e-staff-calendar.mjs
 * Requiere la app corriendo con: AGENDA=on, SALON=on, GOOGLE_STAFF_CALENDARS=on, WA_MOCK_ENABLED=true,
 * GOOGLE_OAUTH_CLIENT_ID/SECRET (cualquier valor), y GOOGLE_CAL_BASE_URL, GOOGLE_OAUTH_BASE_URL y
 * GOOGLE_ACCOUNTS_BASE_URL apuntando a ${APP_BASE_URL}/api/dev/google-mock. Usuario: E2E_EMAIL / E2E_PASSWORD.
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
const visible = (locator, timeout = 15000) => locator.waitFor({ timeout }).then(() => true).catch(() => false);

const browser = await chromium.launch(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const req = ctx.request;
const page = await ctx.newPage();
const shot = async (p, name) => {
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` });
};

console.log("== Sesión ==");
const email = process.env.E2E_EMAIL ?? "e2e@vocero.test";
const password = process.env.E2E_PASSWORD ?? "password-e2e-123";
const sesion = await req.post(`${BASE}/api/auth/sign-in/email`, { data: { email, password }, headers: { origin: BASE } });
ok("sesión iniciada (dueño)", sesion.ok(), `status ${sesion.status()}`);
if (!sesion.ok()) {
  await browser.close();
  process.exit(1);
}

const mock = (path, data) => req.post(`${BASE}/api/dev/google-mock/${path}`, { data: data ?? {} });
const mockState = async () => (await req.get(`${BASE}/api/dev/google-mock/_state`)).json();

console.log("\n== Preparación ==");
await req.put(`${BASE}/api/organization/sector`, { data: { action: "skip" } });
ok("mock de Google disponible", (await mock("_reset")).ok());
const CARLA_MAIL = "carla@personal.mock";
await mock("_staff", { email: CARLA_MAIL, grantRead: true });
const all = [{ start: "09:00", end: "18:00" }];
const cfg = await req.put(`${BASE}/api/calendar/settings`, {
  data: {
    weeklyHours: { mon: all, tue: all, wed: all, thu: all, fri: all, sat: all, sun: all },
    minNoticeHours: 0,
    maxDaysAhead: 30,
    connector: "enlace-fijo",
    googleSync: false,
    googleBusy: false,
  },
});
ok("agenda abierta todos los días", cfg.ok(), `status ${cfg.status()}`);
// El nombre solo admite letras: el sufijo que distingue cada corrida también.
const suf = Array.from({ length: 5 }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
const alta = async (name, phone) => (await (await req.post(`${BASE}/api/negocio/equipo`, { data: { name, phone } })).json()).staff;
const carla = await alta(`Carla ${suf}`, "+51911111111");
const beto = await alta(`Beto ${suf}`, "+51922222222");
ok("dos profesionales dados de alta", !!carla?.id && !!beto?.id);
const contacto = await req.post(`${BASE}/api/contacts`, { data: { name: "Ana Pérez E2E", phone: `5199${String(Date.now()).slice(-9)}` } });
const contactId = (await contacto.json()).contact?.id;
ok("contacto de prueba", !!contactId);

console.log("\n== 1. El dueño genera el enlace de Carla ==");
await page.goto(`${BASE}/equipo`, { timeout: 120000 });
ok("Equipo muestra la columna «Google Calendar»", await visible(page.getByRole("columnheader", { name: "Google Calendar" }), 30000));
await page.getByRole("button", { name: `Google Calendar de ${carla.name}` }).click();
await page.getByRole("button", { name: "Generar enlace (24 h)" }).click();
const campo = page.getByLabel("Enlace para conectar el calendario");
ok("aparece el enlace", await visible(campo));
const enlace = await campo.inputValue();
ok("el enlace es de la página pública", enlace.startsWith(`${BASE}/conectar-calendario/`), enlace);
const wa = await page.getByRole("link", { name: "Enviar por WhatsApp" }).getAttribute("href");
ok("«Enviar por WhatsApp» va a su teléfono con el enlace", wa?.startsWith("https://wa.me/51911111111?text=") && decodeURIComponent(wa).includes(enlace), wa ?? "");
await shot(page, "staff-1-enlace");
await page.keyboard.press("Escape");

console.log("\n== 2. Carla conecta desde OTRO navegador, sin sesión ==");
const anon = await browser.newContext({ viewport: { width: 420, height: 860 } });
const carlaPage = await anon.newPage();
await carlaPage.goto(enlace, { timeout: 120000 });
ok("la página dice quién lo pide y qué se lee", await visible(carlaPage.getByText(`Hola, ${carla.name}`)) && (await carlaPage.getByText(/Solo se leen los horarios/).count()) === 1);
await shot(carlaPage, "staff-2-pagina-publica");
await carlaPage.getByRole("link", { name: "Conectar con Google" }).click();
ok("vuelve con «Listo»", await visible(carlaPage.getByText(/tu calendario quedó conectado/), 20000));
await shot(carlaPage, "staff-3-listo");

console.log("\n== 3. El enlace sirve una sola vez ==");
await carlaPage.goto(enlace, { timeout: 120000 });
ok("reusarlo: «Este enlace ya no sirve» (ya se usó)", await visible(carlaPage.getByText("Este enlace ya no sirve")) && (await carlaPage.getByText(/ya se usó/).count()) === 1);
await anon.close();

console.log("\n== 4. Lo ocupado de Carla la saca SOLO a ella ==");
const estado = await hasta(async () => {
  const s = (await (await req.get(`${BASE}/api/negocio/equipo/calendarios`)).json()).staff?.find((x) => x.staffId === carla.id);
  return s?.connection?.busy?.status === "ok" ? s : null;
});
ok("la API la da conectada con su cuenta y ya leída", estado?.connection?.accountEmail === CARLA_MAIL, JSON.stringify(estado));
const disp = (await (await req.get(`${BASE}/api/calendar/availability`)).json()).slots ?? [];
const hueco = disp[4];
const fin = new Date(Date.parse(hueco.startUtc) + 60 * 60_000).toISOString();
await mock("_external", { replace: true, events: [{ id: "dentista-carla", calendarId: CARLA_MAIL, start: { dateTime: hueco.startUtc }, end: { dateTime: fin } }] });
await page.reload({ timeout: 120000 });
ok("Equipo la muestra «Conectado»", await visible(page.getByText("Conectado", { exact: true }).first(), 20000));
await page.getByRole("button", { name: `Google Calendar de ${carla.name}` }).click();
ok("el diálogo dice con qué cuenta", await visible(page.getByText(`Conectado como ${CARLA_MAIL}`)));
await page.getByRole("button", { name: "Leer ahora" }).click();
ok("«Leer ahora» lee su calendario", await visible(page.getByText("Calendario leído.")));
await shot(page, "staff-4-conectado");
await page.keyboard.press("Escape");

const conCarla = await req.post(`${BASE}/api/bookings`, { data: { kind: "session", contactId, startUtc: hueco.startUtc, staffId: carla.id } });
ok("reservar CON Carla en su tramo ocupado: 409", conCarla.status() === 409, `status ${conCarla.status()}`);
const cualquiera = await req.post(`${BASE}/api/bookings`, { data: { kind: "session", contactId, startUtc: hueco.startUtc } });
const cualquieraId = (await cualquiera.json()).booking?.id;
ok("«cualquiera disponible» entra (201)", cualquiera.status() === 201 && !!cualquieraId, `status ${cualquiera.status()}`);
// El día del hueco en la zona del NEGOCIO (no el día UTC).
const dia = hueco.dayIso;
const tablero = await (await req.get(`${BASE}/api/negocio/agenda?date=${dia}`)).json();
const franja = tablero.slots?.find((s) => Date.parse(s.startUtc) === Date.parse(hueco.startUtc));
ok("el tablero la marca ocupada solo a ella", franja?.busyStaffIds?.includes(carla.id) && !franja?.busyStaffIds?.includes(beto.id) && franja?.blocked === false, JSON.stringify(franja));
ok("la cita de «cualquiera» quedó con Beto", tablero.bookings?.find((b) => b.id === cualquieraId)?.staffId === beto.id);
await page.goto(`${BASE}/citas?pestana=sillas&fecha=${dia}`, { timeout: 120000 });
ok("la celda de Carla dice «Ocupado en Google»", await visible(page.getByText("Ocupado en Google").first(), 20000));
await shot(page, "staff-5-tablero");
await req.patch(`${BASE}/api/bookings/${cualquieraId}`, { data: { action: "cancel" } });

console.log("\n== 5. Desactivar a Carla libera su horario ==");
await page.goto(`${BASE}/equipo`, { timeout: 120000 });
await page.getByRole("switch", { name: `Desactivar a ${carla.name}` }).click();
const libre = await hasta(async () => {
  const t = await (await req.get(`${BASE}/api/negocio/agenda?date=${dia}`)).json();
  const f = t.slots?.find((s) => Date.parse(s.startUtc) === Date.parse(hueco.startUtc));
  return f && !f.busyStaffIds?.includes(carla.id) ? f : null;
});
ok("su tramo ya no aparece ocupado", !!libre);
ok("su permiso se revocó en Google", (await mockState()).revoked.some((t) => t === `mock-refresh-staff|${CARLA_MAIL}`));
const tras = (await (await req.get(`${BASE}/api/negocio/equipo/calendarios`)).json()).staff ?? [];
ok("ya no aparece en los calendarios del equipo", !tras.some((x) => x.staffId === carla.id));

// Limpieza: quedan inactivos (con historial de pruebas no se borran).
await req.patch(`${BASE}/api/negocio/equipo/${beto.id}`, { data: { active: false } });
await browser.close();
console.log(failures === 0 ? "\nTodo verde." : `\n${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
