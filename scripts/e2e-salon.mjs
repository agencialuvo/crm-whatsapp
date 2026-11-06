/**
 * Self-test E2E de comportamiento — módulo SALON (barberías, salones, manicure):
 * catálogo de servicios y combos, equipo con horarios y comisiones, caja con
 * cierres y la agenda por sillas (multicupo). Guion: tests/e2e/us-salon.md
 *
 * Qué conduce, contra la app real y un navegador:
 *  - API: validaciones (422), permisos (401/403), la regla de comisiones, el
 *    reparto exacto en centavos, el reporte por rango en la zona del negocio,
 *    el borrado protegido por el historial (409 in_use) y el multicupo con el
 *    índice único por instante y silla.
 *  - Pantallas: crear/editar/activar/eliminar en Servicios y Combos, alta de
 *    profesionales con horario y comisiones, cobrar y anular en Caja, exportar
 *    el CSV, y la agenda por sillas viva (una cita nueva aparece sin recargar).
 *  - Móvil: ninguna pantalla desborda a lo ancho.
 * Con SALON apagado, comprueba que la sección y la API no existen (404).
 *
 * Uso: node --env-file=.env scripts/e2e-salon.mjs
 * Requiere: app viva con AGENDA=on y SALON=on, BD migrada y Playwright.
 *
 * ⚠ Úsalo SOLO contra una instancia de PRUEBAS. Espera una organización sin
 * profesionales activos ni citas en los días que usa; con E2E_ALLOW_RESET=1
 * desactiva a los profesionales previos y cancela esas citas, en vez de abortar.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const SALON = /^(on|1|true|si|sí|yes)$/i.test((process.env.SALON ?? "").trim());
const RESET = process.env.E2E_ALLOW_RESET === "1";
const SHOTS = process.env.E2E_SHOTS_DIR ?? "";
const TZ = "America/Lima"; // UTC−5, sin horario de verano: el día del negocio es predecible
const TZ_NAVEGADOR = "Asia/Tokyo"; // otra zona a propósito: todo debe pintarse en la del negocio
const RUN = Date.now().toString(36);

let failures = 0;
let checks = 0;
function ok(name, cond, extra = "") {
  checks++;
  if (cond) console.log(`  OK  ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* reintenta */
    }
    if (Date.now() - t0 > ms) return false;
    await sleep(200);
  }
}

/* ------------------------------- fechas ------------------------------- */
function offsetMin(date, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value])
  );
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - date.getTime()) / 60000;
}
function wallToUtc(day, hhmm, tz = TZ) {
  const [y, m, d] = day.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ts = guess - offsetMin(new Date(guess), tz) * 60000;
  const second = offsetMin(new Date(ts), tz);
  if (second !== offsetMin(new Date(guess), tz)) ts = guess - second * 60000;
  return new Date(ts).toISOString();
}
const dayIn = (instant, tz = TZ) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(instant)
  );
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dow = (day) => new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = domingo

/** Lo que el navegador pinta para un monto (Intl con NBSP → espacio normal). */
const fmt = (cents) =>
  new Intl.NumberFormat("es-PE", { style: "currency", currency: "PEN" })
    .format(cents / 100)
    .replace(/ /g, " ");
const plain = (s) => s.replace(/ /g, " ");

/* -------------------------------- cliente ------------------------------- */
let browser;
async function launch() {
  try {
    return await chromium.launch();
  } catch (err) {
    // El paquete pide un build de Chromium que no siempre está instalado:
    // se usa el más nuevo que haya en la caché de Playwright.
    const root =
      process.env.PLAYWRIGHT_BROWSERS_PATH ??
      path.join(process.env.LOCALAPPDATA ?? path.join(process.env.HOME ?? "", ".cache"), "ms-playwright");
    const dirs = existsSync(root) ? readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort() : [];
    for (const d of dirs.reverse()) {
      for (const sub of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const exe = path.join(root, d, sub);
        if (existsSync(exe)) return await chromium.launch({ executablePath: exe });
      }
    }
    throw err;
  }
}

function makeApi(ctx) {
  return async function api(p, opts = {}) {
    const res = await ctx.request.fetch(`${BASE}${p}`, {
      method: opts.method ?? "GET",
      headers: { origin: BASE, "content-type": "application/json" },
      data: opts.body,
      failOnStatusCode: false,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* sin cuerpo */
    }
    return { status: res.status(), json };
  };
}

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

async function noHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

/* ============================== PRUEBA ============================== */
browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: TZ_NAVEGADOR, locale: "es-PE" });
const api = makeApi(ctx);

async function main() {
  console.log("== Setup: login del dueño ==");
  let su = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: { email: "salon-e2e@vocero.test", password: "password-e2e-123", name: "Dueño Salón" },
  });
  if (su.status >= 400) {
    su = await api("/api/auth/sign-in/email", {
      method: "POST",
      body: { email: "salon-e2e@vocero.test", password: "password-e2e-123" },
    });
  }
  ok("registro o login del dueño", su.status < 400, `status=${su.status}`);

  if (!SALON) {
    console.log("\n== SALON apagado: la sección no existe ==");
    for (const p of [
      "/api/negocio/servicios",
      "/api/negocio/ofertas",
      "/api/negocio/equipo",
      "/api/negocio/ventas",
      "/api/negocio/opciones",
      "/api/negocio/agenda",
    ]) {
      const r = await api(p);
      ok(`GET ${p} → 404`, r.status === 404, `status=${r.status}`);
    }
    const post = await api("/api/negocio/ventas", { method: "POST", body: {} });
    ok("POST /api/negocio/ventas → 404", post.status === 404, `status=${post.status}`);
    const page = await ctx.newPage();
    for (const p of ["/servicios", "/equipo", "/caja", "/agenda-por-sillas"]) {
      const nav = await page.goto(`${BASE}${p}`, { waitUntil: "domcontentloaded" });
      ok(`la pantalla ${p} es 404`, nav?.status() === 404, `status=${nav?.status()}`);
    }
    const inbox = await page.goto(`${BASE}/bandeja`, { waitUntil: "domcontentloaded" });
    ok(
      "la navegación no ofrece Servicios, Equipo, Caja ni Agenda por sillas",
      inbox?.ok() &&
        (await page.locator('a[href="/servicios"], a[href="/equipo"], a[href="/caja"], a[href="/agenda-por-sillas"]').count()) === 0
    );
    return;
  }

  /* ---------------------------- configuración ---------------------------- */
  console.log("\n== Setup: moneda, horario del negocio y estado limpio ==");
  const brand = await api("/api/settings/branding", {
    method: "PUT",
    body: { name: "Barbería E2E", accent: "#0d5bff", currency: "PEN" },
  });
  ok("moneda del negocio: soles (PEN)", brand.status < 400, `status=${brand.status}`);

  const allDays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const cfg = await api("/api/calendar/settings", {
    method: "PUT",
    body: {
      timezone: TZ,
      weeklyHours: Object.fromEntries(allDays.map((d) => [d, [{ start: "09:00", end: "18:00" }]])),
      slotMinutes: 30,
      minNoticeHours: 0,
      maxDaysAhead: 14,
      connector: "enlace-fijo",
      meetingLink: "https://meet.ejemplo.test/salon",
    },
  });
  ok("horario del negocio 09:00–18:00 todos los días, zona de Lima", cfg.status < 400, `status=${cfg.status}`);

  const hoy = dayIn(Date.now());
  const D = addDays(hoy, 3); // día del multicupo
  const D2 = addDays(hoy, 4); // día con turnos distintos por profesional

  const previos = ((await api("/api/negocio/equipo")).json?.staff ?? []).filter((s) => s.active);
  if (previos.length > 0) {
    if (!RESET) {
      ok("la organización de pruebas no trae profesionales activos", false, "usa E2E_ALLOW_RESET=1 en una instancia de PRUEBAS");
      return;
    }
    for (const s of previos) await api(`/api/negocio/equipo/${s.id}`, { method: "PATCH", body: { active: false } });
  }
  // Agendadas, realizadas (las cobradas de una corrida anterior) y bloqueos: todo lo que ocupa el día.
  const futuras = ((await api(`/api/bookings?from=${D}&to=${D2}`)).json?.bookings ?? []).filter((b) => b.status === "agendada" || b.status === "realizada");
  if (futuras.length > 0) {
    if (!RESET) {
      ok("no hay citas en los días de la prueba", false, "usa E2E_ALLOW_RESET=1 en una instancia de PRUEBAS");
      return;
    }
    for (const b of futuras) await api(`/api/bookings/${b.id}`, { method: "PATCH", body: { action: "cancel" } });
  }

  /* ------------------------------ permisos ------------------------------ */
  console.log("\n== Permisos ==");
  const anon = await browser.newContext();
  const anonApi = makeApi(anon);
  for (const p of ["/api/negocio/servicios", "/api/negocio/ventas", "/api/negocio/opciones", "/api/negocio/agenda"]) {
    const r = await anonApi(p);
    ok(`sin sesión: GET ${p} → 401`, r.status === 401, `status=${r.status}`);
  }
  await anon.close();

  /* ------------------------------ servicios ------------------------------ */
  console.log("\n== Servicios: validación y CRUD ==");
  const bad = [
    ["nombre de 1 letra", { name: "A", priceCents: 2500, durationMinutes: 30 }],
    ["precio negativo", { name: "Corte", priceCents: -5, durationMinutes: 30 }],
    ["precio con decimales (no son centavos)", { name: "Corte", priceCents: 25.5, durationMinutes: 30 }],
    ["duración 0", { name: "Corte", priceCents: 2500, durationMinutes: 0 }],
    ["comisión de 150 %", { name: "Corte", priceCents: 2500, durationMinutes: 30, defaultCommissionPercentage: 150 }],
  ];
  for (const [label, body] of bad) {
    const r = await api("/api/negocio/servicios", { method: "POST", body });
    ok(`rechaza ${label} → 422`, r.status === 422, `status=${r.status}`);
  }
  const corte = (await api("/api/negocio/servicios", {
    method: "POST",
    body: { name: `Corte ${RUN}`, description: "Clásico", priceCents: 2500, durationMinutes: 30, defaultCommissionPercentage: 50 },
  })).json?.service;
  ok("crea «Corte» (201) con la comisión que se le escribió (50 %)", corte?.defaultCommissionPercentage === 50 && corte?.priceCents === 2500);
  const sinCom = (await api("/api/negocio/servicios", { method: "POST", body: { name: `SinCom ${RUN}`, priceCents: 1000 } })).json?.service;
  ok("un servicio SIN comisión escrita queda en null (no hay porcentaje por defecto)", sinCom?.defaultCommissionPercentage === null);
  const barba = (await api("/api/negocio/servicios", {
    method: "POST",
    body: { name: `Barba ${RUN}`, priceCents: 1500, durationMinutes: 20, defaultCommissionPercentage: 40 },
  })).json?.service;
  ok("crea «Barba» con comisión por defecto 40 %", barba?.defaultCommissionPercentage === 40);
  const patch = await api(`/api/negocio/servicios/${corte.id}`, { method: "PATCH", body: { priceCents: 2800 } });
  ok("PATCH parcial cambia solo el precio", patch.json?.service?.priceCents === 2800 && patch.json?.service?.name === corte.name);
  await api(`/api/negocio/servicios/${corte.id}`, { method: "PATCH", body: { priceCents: 2500 } });
  ok("PATCH vacío → 422", (await api(`/api/negocio/servicios/${corte.id}`, { method: "PATCH", body: {} })).status === 422);
  ok("PATCH de un servicio ajeno/inexistente → 404", (await api("/api/negocio/servicios/srv_no_existe", { method: "PATCH", body: { name: "Zz" } })).status === 404);
  const efimero = (await api("/api/negocio/servicios", { method: "POST", body: { name: `Efímero ${RUN}`, priceCents: 100, durationMinutes: 15 } })).json?.service;
  ok("elimina un servicio sin ventas (200)", (await api(`/api/negocio/servicios/${efimero.id}`, { method: "DELETE" })).status === 200);
  ok("eliminarlo otra vez → 404", (await api(`/api/negocio/servicios/${efimero.id}`, { method: "DELETE" })).status === 404);

  /* -------------------------------- combos -------------------------------- */
  console.log("\n== Combos: palabra clave normalizada y única ==");
  const fresh = (await api("/api/negocio/ofertas", {
    method: "POST",
    body: { name: `Combo Fresh ${RUN}`, description: "Corte, mascarilla y masaje", priceCents: 4500, durationMinutes: 60, keywordTrigger: `combo fresh ${RUN}` },
  })).json?.combo;
  const kw = `COMBO_FRESH_${RUN.toUpperCase()}`;
  ok("la palabra clave se guarda en MAYÚSCULAS con _", fresh?.keywordTrigger === kw, JSON.stringify(fresh?.keywordTrigger));
  const dup = await api("/api/negocio/ofertas", {
    method: "POST",
    body: { name: "Otro", description: "Algo", priceCents: 1000, durationMinutes: 30, keywordTrigger: kw.toLowerCase() },
  });
  ok("la misma palabra clave en otro combo → 409 keyword_taken", dup.status === 409 && dup.json?.error?.code === "keyword_taken", `status=${dup.status}`);
  const sinClave = await api("/api/negocio/ofertas", {
    method: "POST",
    body: { name: `Combo sin clave ${RUN}`, description: "Algo", priceCents: 1000, durationMinutes: 30 },
  });
  ok("un combo sin palabra clave es válido", sinClave.status === 201);
  const dos = await api("/api/negocio/ofertas", {
    method: "POST",
    body: { name: `Otro sin clave ${RUN}`, description: "Algo", priceCents: 1000, durationMinutes: 30 },
  });
  ok("dos combos sin palabra clave conviven (NULL no choca)", dos.status === 201);
  ok("palabra clave de 2 letras → 422", (await api("/api/negocio/ofertas", { method: "POST", body: { name: "Mal", description: "Algo", priceCents: 1, durationMinutes: 30, keywordTrigger: "ab" } })).status === 422);
  const lista = (await api("/api/negocio/ofertas")).json?.combos ?? [];
  ok("GET lista los combos", lista.some((c) => c.id === fresh.id));

  /* -------------------------------- equipo -------------------------------- */
  console.log("\n== Equipo: alta, horarios y comisiones ==");
  ok("teléfono con letras → 422", (await api("/api/negocio/equipo", { method: "POST", body: { name: "Mal", phone: "llámame" } })).status === 422);
  const carlos = (await api("/api/negocio/equipo", { method: "POST", body: { name: `Carlos ${RUN}`, phone: "+51 987 654 321", globalCommissionPercentage: 50 } })).json?.staff;
  const ana = (await api("/api/negocio/equipo", { method: "POST", body: { name: `Ana ${RUN}`, globalCommissionPercentage: 60 } })).json?.staff;
  const luis = (await api("/api/negocio/equipo", { method: "POST", body: { name: `Luis ${RUN}` } })).json?.staff;
  ok("da de alta a Carlos, Ana y Luis (201)", Boolean(carlos?.id && ana?.id && luis?.id));
  ok("Luis sin porcentaje propio (null)", luis.globalCommissionPercentage === null);

  const dowD2 = dow(D2);
  const badSchedule = await api(`/api/negocio/equipo/${luis.id}/horario`, {
    method: "PUT",
    body: { days: [{ dayOfWeek: dowD2, isOff: false, startTime: "18:00", endTime: "09:00" }] },
  });
  ok("horario con salida antes de la entrada → 422", badSchedule.status === 422);
  const dupDays = await api(`/api/negocio/equipo/${luis.id}/horario`, {
    method: "PUT",
    body: { days: [
      { dayOfWeek: 1, isOff: true, startTime: "09:00", endTime: "18:00" },
      { dayOfWeek: 1, isOff: true, startTime: "09:00", endTime: "18:00" },
    ] },
  });
  ok("día repetido en el horario → 422", dupDays.status === 422);
  const luisOff = await api(`/api/negocio/equipo/${luis.id}/horario`, {
    method: "PUT",
    body: { days: [{ dayOfWeek: dowD2, isOff: true, startTime: "09:00", endTime: "18:00" }] },
  });
  ok("Luis libre el día de D2", luisOff.status === 200 && luisOff.json?.staff?.schedule?.[0]?.isOff === true);
  const anaCustom = await api(`/api/negocio/equipo/${ana.id}/horario`, {
    method: "PUT",
    body: { days: [{ dayOfWeek: dowD2, isOff: false, startTime: "12:00", endTime: "18:00" }] },
  });
  ok("Ana entra a las 12:00 el día de D2", anaCustom.status === 200);
  const replace = await api(`/api/negocio/equipo/${ana.id}/horario`, { method: "PUT", body: { days: [{ dayOfWeek: dowD2, isOff: false, startTime: "12:00", endTime: "18:00" }] } });
  ok("reemplazar el horario es idempotente (no duplica filas)", replace.json?.staff?.schedule?.length === 1);

  const pact = await api(`/api/negocio/equipo/${carlos.id}/comisiones`, {
    method: "PUT",
    body: { overrides: [{ serviceId: corte.id, percentage: 70 }] },
  });
  ok("pacto de Carlos × Corte = 70 %", pact.status === 200 && pact.json?.staff?.commissions?.[0]?.percentage === 70);
  ok("pacto con un servicio inexistente → 422", (await api(`/api/negocio/equipo/${carlos.id}/comisiones`, { method: "PUT", body: { overrides: [{ serviceId: "srv_no_existe", percentage: 10 }] } })).status === 422);
  ok("pacto repetido → 422", (await api(`/api/negocio/equipo/${carlos.id}/comisiones`, { method: "PUT", body: { overrides: [{ serviceId: corte.id, percentage: 10 }, { serviceId: corte.id, percentage: 20 }] } })).status === 422);
  const equipo = (await api("/api/negocio/equipo")).json?.staff ?? [];
  ok("GET equipo trae horario y pactos de cada uno", equipo.find((s) => s.id === carlos.id)?.commissions?.length === 1 && equipo.find((s) => s.id === luis.id)?.schedule?.length === 1);

  /* --------------------------------- caja --------------------------------- */
  console.log("\n== Caja: comisiones exactas y reporte por rango ==");
  const cliente = (await api("/api/contacts", { method: "POST", body: { name: `Cliente Uno ${RUN}`, phone: `5199${Math.floor(1000000 + Math.random() * 8999999)}` } })).json?.contact;
  ok("hay un contacto al que cobrar", Boolean(cliente?.id));
  const base = (await api(`/api/negocio/ventas?from=${hoy}&to=${hoy}`)).json;
  const sale = (body) => api("/api/negocio/ventas", { method: "POST", body });

  const A = await sale({ contactId: cliente.id, staffId: carlos.id, serviceId: corte.id, amountCents: 2500, paymentMethod: "efectivo" });
  ok("A: Carlos × Corte → 201", A.status === 201, `status=${A.status} ${JSON.stringify(A.json)}`);
  ok("A: manda el pacto (70 %): 1750 / 750", A.json?.sale?.staffCommissionCents === 1750 && A.json?.sale?.businessNetCents === 750 && A.json?.commissionSource === "staff_service", JSON.stringify(A.json));
  ok("A: el nombre del cliente queda en la venta", A.json?.sale?.customerName === `Cliente Uno ${RUN}`);
  const B = await sale({ customerName: `Cliente Walk-in ${RUN}`, staffId: ana.id, comboId: fresh.id, amountCents: 4500, paymentMethod: "yape" });
  ok("B: Ana × Combo (global 60 %): 2700 / 1800", B.json?.sale?.staffCommissionCents === 2700 && B.json?.sale?.businessNetCents === 1800 && B.json?.commissionSource === "staff", JSON.stringify(B.json));
  ok("B: cliente de mostrador con nombre suelto", B.json?.sale?.customerName === `Cliente Walk-in ${RUN}`);
  const C = await sale({ staffId: luis.id, serviceId: corte.id, amountCents: 3333, paymentMethod: "tarjeta" });
  ok("C: Luis sin % propio → manda el del servicio (50 %): 1667 / 1666 (suman 3333)", C.json?.sale?.staffCommissionCents === 1667 && C.json?.sale?.businessNetCents === 1666 && C.json?.commissionSource === "service", JSON.stringify(C.json));
  ok("C: sin cliente → «Cliente de mostrador»", C.json?.sale?.customerName === "Cliente de mostrador");
  const Dv = await sale({ staffId: carlos.id, serviceId: barba.id, amountCents: 1500, paymentMethod: "efectivo", customCommissionPercentage: 10 });
  ok("D: porcentaje puntual de la venta (10 %): 150 / 1350", Dv.json?.sale?.staffCommissionCents === 150 && Dv.json?.sale?.businessNetCents === 1350 && Dv.json?.commissionSource === "custom", JSON.stringify(Dv.json));

  console.log("  -- ventas inválidas --");
  ok("servicio Y combo a la vez → 422", (await sale({ staffId: carlos.id, serviceId: corte.id, comboId: fresh.id, amountCents: 100, paymentMethod: "yape" })).status === 422);
  ok("ni servicio ni combo → 422", (await sale({ staffId: carlos.id, amountCents: 100, paymentMethod: "yape" })).status === 422);
  ok("método de pago desconocido → 422", (await sale({ staffId: carlos.id, serviceId: corte.id, amountCents: 100, paymentMethod: "bitcoin" })).status === 422);
  ok("monto negativo → 422", (await sale({ staffId: carlos.id, serviceId: corte.id, amountCents: -100, paymentMethod: "yape" })).status === 422);
  ok("profesional inexistente → 404", (await sale({ staffId: "stf_no_existe", serviceId: corte.id, amountCents: 100, paymentMethod: "yape" })).status === 404);
  ok("servicio inexistente → 404", (await sale({ staffId: carlos.id, serviceId: "srv_no_existe", amountCents: 100, paymentMethod: "yape" })).status === 404);
  ok("contacto inexistente → 404", (await sale({ contactId: "ct_no_existe", staffId: carlos.id, serviceId: corte.id, amountCents: 100, paymentMethod: "yape" })).status === 404);

  console.log("  -- el reporte --");
  const rep = (await api(`/api/negocio/ventas?from=${hoy}&to=${hoy}`)).json;
  const delta = (k) => rep.totals[k] - base.totals[k];
  ok("ingresos del día = 11833", delta("revenueCents") === 11833, `delta=${delta("revenueCents")}`);
  ok("comisiones del día = 6267", delta("commissionsCents") === 6267, `delta=${delta("commissionsCents")}`);
  ok("ganancia neta del día = 5566", delta("netCents") === 5566, `delta=${delta("netCents")}`);
  ok("comisión + neto = ingresos (ni un centavo se pierde)", rep.totals.commissionsCents + rep.totals.netCents === rep.totals.revenueCents);
  ok("4 ventas nuevas", delta("count") === 4);
  const of = (id, key) => rep.byStaff.find((s) => s.staffId === id)?.[key];
  ok("a pagar: Ana 2700, Carlos 1900, Luis 1667", of(ana.id, "commissionCents") === 2700 && of(carlos.id, "commissionCents") === 1900 && of(luis.id, "commissionCents") === 1667, JSON.stringify(rep.byStaff));
  ok("a pagar ordenado de más a menos", rep.byStaff.map((s) => s.commissionCents).every((v, i, a) => i === 0 || a[i - 1] >= v));
  const pm = (m) => (rep.byPayment.find((p) => p.method === m)?.amountCents ?? 0) - (base.byPayment.find((p) => p.method === m)?.amountCents ?? 0);
  ok("cuadre por método: efectivo 4000, yape 4500, tarjeta 3333", pm("efectivo") === 4000 && pm("yape") === 4500 && pm("tarjeta") === 3333);
  const rowA = rep.rows.find((r) => r.id === A.json.sale.id);
  ok("la fila de A trae cliente, profesional, servicio y método", rowA?.staffName === carlos.name && rowA?.itemName === corte.name && rowA?.paymentMethod === "efectivo");
  ok("la fila de B dice que es combo", rep.rows.find((r) => r.id === B.json.sale.id)?.itemKind === "combo");
  ok("el periodo se cuenta en la zona del negocio", rep.period.timezone === TZ && rep.period.from === hoy);
  ok("un rango sin ventas responde ceros (no error)", (await api(`/api/negocio/ventas?from=2020-01-01&to=2020-01-02`)).json?.totals?.count === 0);
  ok("fechas al revés → 422", (await api(`/api/negocio/ventas?from=${hoy}&to=2020-01-01`)).status === 422);
  ok("formato de fecha inválido → 422", (await api(`/api/negocio/ventas?from=ayer&to=hoy`)).status === 422);
  ok("fecha inexistente (2026-02-31) → 422", (await api(`/api/negocio/ventas?from=2026-02-31&to=2026-03-01`)).status === 422);
  ok("rango de más de 366 días → 422", (await api(`/api/negocio/ventas?from=2024-01-01&to=2026-01-01`)).status === 422);

  console.log("  -- el historial protege el catálogo --");
  const delSvc = await api(`/api/negocio/servicios/${corte.id}`, { method: "DELETE" });
  ok("eliminar un servicio con ventas → 409 in_use", delSvc.status === 409 && delSvc.json?.error?.code === "in_use", `status=${delSvc.status}`);
  const delStaff = await api(`/api/negocio/equipo/${carlos.id}`, { method: "DELETE" });
  ok("eliminar a un profesional con ventas → 409 in_use", delStaff.status === 409 && delStaff.json?.error?.code === "in_use");
  const delCombo = await api(`/api/negocio/ofertas/${fresh.id}`, { method: "DELETE" });
  ok("eliminar un combo con ventas → 409 in_use", delCombo.status === 409 && delCombo.json?.error?.code === "in_use");
  const inact = (await api("/api/negocio/servicios", { method: "POST", body: { name: `Inactivo ${RUN}`, priceCents: 900, durationMinutes: 15, active: false } })).json?.service;
  ok("un servicio desactivado no se puede cobrar → 409", (await sale({ staffId: carlos.id, serviceId: inact.id, amountCents: 900, paymentMethod: "yape" })).status === 409);

  console.log("  -- anular una venta --");
  ok("anula D (200)", (await api(`/api/negocio/ventas/${Dv.json.sale.id}`, { method: "DELETE" })).status === 200);
  ok("anularla otra vez → 404", (await api(`/api/negocio/ventas/${Dv.json.sale.id}`, { method: "DELETE" })).status === 404);
  const rep2 = (await api(`/api/negocio/ventas?from=${hoy}&to=${hoy}`)).json;
  ok("los totales bajan lo anulado (150 de comisión, 1500 de ingresos)", rep.totals.revenueCents - rep2.totals.revenueCents === 1500 && rep.totals.commissionsCents - rep2.totals.commissionsCents === 150);

  console.log("  -- un miembro del equipo --");
  const memberEmail = `miembro-${RUN}@vocero.test`;
  const teamAdd = await api("/api/settings/team", { method: "POST", body: { name: "Recepción", email: memberEmail, password: "password-e2e-123" } });
  ok("el dueño crea la cuenta de recepción", teamAdd.status === 201, `status=${teamAdd.status}`);
  const mctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: TZ_NAVEGADOR, locale: "es-PE" });
  const mapi = makeApi(mctx);
  const msi = await mapi("/api/auth/sign-in/email", { method: "POST", body: { email: memberEmail, password: "password-e2e-123" } });
  ok("recepción inicia sesión", msi.status < 400);
  const mOpts = await mapi("/api/negocio/opciones");
  ok("recepción lee las opciones del cobro (200)", mOpts.status === 200 && mOpts.json?.staff?.length === 3);
  ok("…y las opciones NO traen comisiones", !JSON.stringify(mOpts.json).includes("ommission"));
  const mSale = await mapi("/api/negocio/ventas", { method: "POST", body: { staffId: carlos.id, serviceId: barba.id, amountCents: 1500, paymentMethod: "plin" } });
  ok("recepción registra una venta (201)", mSale.status === 201);
  await api(`/api/negocio/ventas/${mSale.json?.sale?.id}`, { method: "DELETE" });
  for (const [label, r] of [
    ["ver el reporte de caja", await mapi(`/api/negocio/ventas?from=${hoy}&to=${hoy}`)],
    ["anular una venta", await mapi(`/api/negocio/ventas/${A.json.sale.id}`, { method: "DELETE" })],
    ["leer el equipo con sus comisiones", await mapi("/api/negocio/equipo")],
    ["crear un servicio", await mapi("/api/negocio/servicios", { method: "POST", body: { name: "Intruso", priceCents: 1, durationMinutes: 15 } })],
    ["cambiar un horario", await mapi(`/api/negocio/equipo/${carlos.id}/horario`, { method: "PUT", body: { days: [] } })],
  ]) {
    ok(`recepción NO puede ${label} → 403`, r.status === 403, `status=${r.status}`);
  }

  /* ------------------------- agenda por sillas ------------------------- */
  console.log("\n== Agenda por sillas: multicupo ==");
  ok("fecha inválida → 422", (await api("/api/negocio/agenda?date=ayer")).status === 422);
  ok("fecha inexistente → 422", (await api("/api/negocio/agenda?date=2026-02-31")).status === 422);
  const b0 = (await api(`/api/negocio/agenda?date=${D}`)).json;
  ok("el tablero trae las 18 franjas de 09:00 a 18:00", b0?.slots?.length === 18 && b0.slots[0].time === "09:00" && b0.slots.at(-1).time === "17:30", `n=${b0?.slots?.length}`);
  ok("tres sillas y cupos libres = 3 en todas", b0?.chairs?.length === 3 && b0.slots.every((s) => s.capacity === 3 && s.free === 3));
  ok("la zona es la del negocio", b0.timezone === TZ);

  const mk = async (name) => (await api("/api/contacts", { method: "POST", body: { name: `${name} ${RUN}`, phone: `5198${Math.floor(1000000 + Math.random() * 8999999)}` } })).json?.contact;
  const [c1, c2, c3, c4] = [await mk("Cita1"), await mk("Cita2"), await mk("Cita3"), await mk("Cita4")];
  const T10 = wallToUtc(D, "10:00");
  const book = (contactId, startUtc = T10) => api("/api/bookings", { method: "POST", body: { kind: "session", contactId, startUtc } });

  const k1 = await book(c1.id);
  ok("1.ª cita a las 10:00 (201)", k1.status === 201, `status=${k1.status} ${JSON.stringify(k1.json)}`);
  const k1b = await book(c2.id);
  ok("2.ª cita SIN asignar a la misma hora choca (la 1.ª sin asignar ocupa el instante) → 409", k1b.status === 409, `status=${k1b.status}`);
  const as1 = await api(`/api/negocio/agenda/citas/${k1.json.bookingId}/profesional`, { method: "PUT", body: { staffId: carlos.id } });
  ok("se asigna la 1.ª a Carlos", as1.status === 200);
  const k2 = await book(c2.id);
  ok("MULTICUPO: ya con Carlos asignado, otra cita a las 10:00 cabe (201)", k2.status === 201, `status=${k2.status} ${JSON.stringify(k2.json?.error)}`);
  const busy = await api(`/api/negocio/agenda/citas/${k2.json?.bookingId}/profesional`, { method: "PUT", body: { staffId: carlos.id } });
  ok("asignar a Carlos otra cita a la misma hora → 409 staff_busy", busy.status === 409 && busy.json?.error?.code === "staff_busy", `status=${busy.status}`);
  ok("…con el nombre de quien está ocupado en el mensaje", String(busy.json?.error?.message).includes(carlos.name));
  ok("asignar a Ana (libre) funciona", (await api(`/api/negocio/agenda/citas/${k2.json.bookingId}/profesional`, { method: "PUT", body: { staffId: ana.id } })).status === 200);
  const k3 = await book(c3.id);
  ok("una 3.ª cita a las 10:00 cabe (Luis aún libre)", k3.status === 201, `status=${k3.status}`);
  ok("asignar a Luis", (await api(`/api/negocio/agenda/citas/${k3.json.bookingId}/profesional`, { method: "PUT", body: { staffId: luis.id } })).status === 200);
  const k4 = await book(c4.id);
  ok("4.ª cita a las 10:00: las 3 sillas llenas → 409 slot_taken", k4.status === 409 && k4.json?.error?.code === "slot_taken", `status=${k4.status}`);
  ok("asignar un profesional inexistente → 404", (await api(`/api/negocio/agenda/citas/${k1.json.bookingId}/profesional`, { method: "PUT", body: { staffId: "stf_no_existe" } })).status === 404);
  ok("asignar en una cita inexistente → 404", (await api(`/api/negocio/agenda/citas/bk_no_existe/profesional`, { method: "PUT", body: { staffId: ana.id } })).status === 404);

  const b1 = (await api(`/api/negocio/agenda?date=${D}`)).json;
  const s10 = b1.slots.find((s) => s.time === "10:00");
  const s1030 = b1.slots.find((s) => s.time === "10:30");
  ok("el tablero: 10:00 con 3 citas y 0 cupos", s10.booked === 3 && s10.free === 0 && s10.capacity === 3, JSON.stringify(s10));
  ok("el tablero: 10:30 sigue con 3 cupos", s1030.free === 3 && s1030.booked === 0);
  ok("las citas llegan con su silla, cliente y hora del negocio", b1.bookings.filter((b) => b.kind === "session").length === 3 && b1.bookings.find((b) => b.id === k1.json.bookingId)?.staffId === carlos.id && b1.bookings.find((b) => b.id === k1.json.bookingId)?.time === "10:00");
  const avail = (await api(`/api/calendar/availability?from=${D}&to=${D}`)).json?.slots ?? [];
  ok("el motor de disponibilidad YA NO ofrece las 10:00 (consistente con el tablero)", !avail.some((s) => s.startUtc === T10) && avail.some((s) => s.startUtc === wallToUtc(D, "10:30")));

  console.log("  -- bloqueo --");
  const blk = await api("/api/bookings", { method: "POST", body: { kind: "block", startUtc: wallToUtc(D, "15:00"), durationMinutes: 60, notes: "Comida con proveedor" } });
  ok("bloquea 15:00–16:00 (201)", blk.status === 201);
  const b2 = (await api(`/api/negocio/agenda?date=${D}`)).json;
  const blocked = b2.slots.filter((s) => s.blocked).map((s) => s.time);
  ok("el tablero marca bloqueadas 15:00 y 15:30, con 0 cupos", blocked.join() === "15:00,15:30" && b2.slots.filter((s) => s.blocked).every((s) => s.free === 0), blocked.join());
  const avail2 = (await api(`/api/calendar/availability?from=${D}&to=${D}`)).json?.slots ?? [];
  const ofrecidas = ["15:00", "15:30"].filter((t) => avail2.some((s) => s.startUtc === wallToUtc(D, t)));
  ok("el motor tampoco ofrece lo bloqueado (con 3 sillas, un bloqueo sigue bloqueando)", ofrecidas.length === 0, `sigue ofreciendo: ${ofrecidas.join(", ")}`);

  console.log("  -- turnos distintos por profesional (D2) --");
  const bd2 = (await api(`/api/negocio/agenda?date=${D2}`)).json;
  const at = (t) => bd2.slots.find((s) => s.time === t);
  ok("09:00: solo Carlos (Luis libre, Ana entra a las 12) → 1 cupo", at("09:00").capacity === 1 && at("09:00").workingStaffIds.join() === carlos.id, JSON.stringify(at("09:00")));
  ok("12:00: entran Carlos y Ana → 2 cupos", at("12:00").capacity === 2 && !at("12:00").workingStaffIds.includes(luis.id));
  ok("11:30 todavía sin Ana", at("11:30").capacity === 1);

  console.log("  -- cobrar una cita --");
  const cob = await sale({ bookingId: k1.json.bookingId, staffId: carlos.id, serviceId: corte.id, amountCents: 2500, paymentMethod: "efectivo" });
  ok("cobrar la cita de las 10:00 (201)", cob.status === 201, `status=${cob.status} ${JSON.stringify(cob.json?.error)}`);
  ok("el cliente es el de la cita", cob.json?.sale?.customerName === c1.name);
  const again = await sale({ bookingId: k1.json.bookingId, staffId: carlos.id, serviceId: corte.id, amountCents: 2500, paymentMethod: "efectivo" });
  ok("cobrarla otra vez → 409 already_sold (la base lo garantiza)", again.status === 409 && again.json?.error?.code === "already_sold", `status=${again.status}`);
  const b3 = (await api(`/api/negocio/agenda?date=${D}`)).json;
  const cobrada = b3.bookings.find((b) => b.id === k1.json.bookingId);
  ok("la cita queda «realizada» y marcada como cobrada", cobrada?.status === "realizada" && cobrada?.sold === true);
  ok("…y sigue ocupando su silla (cupos de las 10:00 = 0)", b3.slots.find((s) => s.time === "10:00").free === 0);
  await api(`/api/bookings/${k3.json.bookingId}`, { method: "PATCH", body: { action: "cancel" } });
  const canc = await sale({ bookingId: k3.json.bookingId, staffId: luis.id, serviceId: corte.id, amountCents: 2500, paymentMethod: "efectivo" });
  ok("una cita cancelada no se cobra → 409", canc.status === 409 && canc.json?.error?.code === "booking_not_chargeable", `status=${canc.status}`);
  const b4 = (await api(`/api/negocio/agenda?date=${D}`)).json;
  ok("al cancelar, la silla se libera en el tablero (10:00 → 1 cupo)", b4.slots.find((s) => s.time === "10:00").free === 1);

  /* ================================ UI ================================ */
  console.log("\n== Pantallas ==");
  const page = await ctx.newPage();
  const errores = [];
  page.on("pageerror", (e) => errores.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/favicon|Failed to load resource/.test(m.text()) && errores.push(m.text()));

  await page.goto(`${BASE}/bandeja`, { waitUntil: "domcontentloaded" });
  const enlaces = await page.locator('a[href="/servicios"], a[href="/equipo"], a[href="/caja"], a[href="/agenda-por-sillas"]').evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  ok("el menú ofrece las cuatro páginas, en orden", enlaces.join("|") === "/servicios|/equipo|/caja|/agenda-por-sillas", enlaces.join("|"));
  const hrefsMenu = await page.locator("aside nav a").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  const iCitas = hrefsMenu.indexOf("/citas");
  ok("…justo debajo de Citas", iCitas >= 0 && hrefsMenu.slice(iCitas, iCitas + 5).join("|") === "/citas|/servicios|/equipo|/caja|/agenda-por-sillas", hrefsMenu.join("|"));
  ok("ya no existe la entrada «Negocio»", (await page.locator('a[href="/negocio"]').count()) === 0);
  await page.locator('a[href="/servicios"]').click();
  await page.waitForURL(/\/servicios/);
  ok("«Servicios» abre el catálogo", page.url().endsWith("/servicios"));

  /* ---- Servicios ---- */
  await page.getByRole("button", { name: /^Nuevo servicio$/ }).first().waitFor();
  ok("la tabla lista los servicios de la API", (await page.getByRole("row", { name: new RegExp(`Corte ${RUN}`) }).count()) === 1);
  ok("el precio se ve en soles", plain(await page.getByRole("row", { name: new RegExp(`Corte ${RUN}`) }).innerText()).includes("S/ 25.00"));
  await shot(page, "servicios");

  await page.getByRole("button", { name: /^Nuevo servicio$/ }).first().click();
  const dlg = page.getByRole("dialog", { name: "Nuevo servicio" });
  await dlg.getByRole("button", { name: "Crear servicio" }).click();
  ok("enviar vacío muestra los errores junto a cada campo", (await dlg.getByRole("alert").count()) >= 2 && (await dlg.innerText()).includes("al menos 2 caracteres"));
  ok("…y el diálogo sigue abierto", await dlg.isVisible());
  await dlg.getByLabel("Nombre").fill(`Manicure UI ${RUN}`);
  await dlg.getByLabel("Precio").fill("35.50");
  await dlg.getByLabel("Duración (minutos)").fill("45");
  await dlg.getByRole("button", { name: "Crear servicio" }).click();
  await dlg.waitFor({ state: "hidden" });
  const rowM = page.getByRole("row", { name: new RegExp(`Manicure UI ${RUN}`) });
  ok("crear desde la pantalla: aparece la fila con S/ 35.50 y 45 min", (await rowM.count()) === 1 && plain(await rowM.innerText()).includes("S/ 35.50") && (await rowM.innerText()).includes("45 min"));
  const apiM = ((await api("/api/negocio/servicios")).json?.services ?? []).find((s) => s.name === `Manicure UI ${RUN}`);
  ok("…y está en la base con 3550 centavos", apiM?.priceCents === 3550);

  await page.getByRole("button", { name: `Editar Manicure UI ${RUN}` }).click();
  const edit = page.getByRole("dialog", { name: "Editar servicio" });
  ok("editar precarga el precio (35.50)", (await edit.getByLabel("Precio").inputValue()) === "35.50");
  await edit.getByLabel("Precio").fill("40");
  await edit.getByRole("button", { name: "Guardar cambios" }).click();
  await edit.waitFor({ state: "hidden" });
  ok("editar actualiza la fila (S/ 40.00)", plain(await rowM.innerText()).includes("S/ 40.00"));

  await page.getByRole("switch", { name: `Desactivar Manicure UI ${RUN}` }).click();
  ok("el interruptor desactiva en línea", await until(async () => ((await api("/api/negocio/servicios")).json?.services ?? []).find((s) => s.id === apiM.id)?.active === false));

  await page.getByRole("button", { name: `Eliminar Manicure UI ${RUN}` }).click();
  await page.getByRole("dialog", { name: "Eliminar servicio" }).getByRole("button", { name: "Eliminar", exact: true }).click();
  ok("eliminar (sin ventas) quita la fila", await until(async () => (await rowM.count()) === 0));

  await page.getByRole("button", { name: `Eliminar Corte ${RUN}` }).click();
  const delDlg = page.getByRole("dialog", { name: "Eliminar servicio" });
  await delDlg.getByRole("button", { name: "Eliminar", exact: true }).click();
  ok("eliminar uno con ventas explica por qué y NO cierra el diálogo", await until(async () => (await delDlg.innerText()).includes("ya tiene ventas registradas")));
  await delDlg.getByRole("button", { name: "Desactivar en su lugar" }).click();
  await delDlg.waitFor({ state: "hidden" });
  ok("«Desactivar en su lugar» lo desactiva (y cierra)", ((await api("/api/negocio/servicios")).json?.services ?? []).find((s) => s.id === corte.id)?.active === false);
  await api(`/api/negocio/servicios/${corte.id}`, { method: "PATCH", body: { active: true } });

  /* ---- Combos ---- */
  await page.getByRole("tab", { name: /^Ofertas/ }).click();
  ok("la pestaña Ofertas lista la oferta con su palabra clave", (await page.getByRole("row", { name: new RegExp(`Combo Fresh ${RUN}`) }).innerText()).includes(kw));
  await page.getByRole("button", { name: /^Nueva oferta$/ }).click();
  const cd = page.getByRole("dialog", { name: "Nueva oferta" });
  await cd.getByLabel("Palabra clave del anuncio (opcional)").fill(`mi oferta ñandú ${RUN}`);
  ok("la palabra clave se previsualiza normalizada", (await cd.innerText()).includes(`MI_OFERTA_NANDU_${RUN.toUpperCase()}`));
  await cd.getByLabel("Nombre").fill(`Combo UI ${RUN}`);
  await cd.getByLabel("Qué incluye").fill("Corte y barba");
  await cd.getByLabel("Precio de la oferta").fill("45");
  await cd.getByRole("button", { name: "Crear oferta" }).click();
  await cd.waitFor({ state: "hidden" });
  ok("crear el combo: aparece con su palabra clave normalizada", await until(async () => (await page.getByRole("row", { name: new RegExp(`Combo UI ${RUN}`) }).innerText()).includes(`MI_OFERTA_NANDU_${RUN.toUpperCase()}`)));
  await page.getByRole("button", { name: /^Nueva oferta$/ }).click();
  const cd2 = page.getByRole("dialog", { name: "Nueva oferta" });
  await cd2.getByLabel("Nombre").fill("Repetido");
  await cd2.getByLabel("Qué incluye").fill("Lo mismo");
  await cd2.getByLabel("Precio de la oferta").fill("10");
  await cd2.getByLabel("Palabra clave del anuncio (opcional)").fill(`MI OFERTA ÑANDÚ ${RUN}`);
  await cd2.getByRole("button", { name: "Crear oferta" }).click();
  ok("una palabra clave repetida se avisa en el diálogo sin perder lo escrito", await until(async () => (await cd2.innerText()).includes("ya la usa otro combo")) && (await cd2.getByLabel("Nombre").inputValue()) === "Repetido");
  await cd2.getByRole("button", { name: "Cancelar" }).click();
  await page.keyboard.press("Escape");

  /* ---- Equipo ---- */
  await page.getByRole("link", { name: "Equipo" }).click();
  await page.waitForURL(/\/equipo/);
  ok("Equipo lista a los tres", await until(async () => (await page.getByRole("row", { name: new RegExp(`(Carlos|Ana|Luis) ${RUN}`) }).count()) === 3));
  ok("Carlos muestra 50 % y 1 pacto; Luis «Según el servicio»", (await page.getByRole("row", { name: new RegExp(`Carlos ${RUN}`) }).innerText()).includes("1 pacto") && (await page.getByRole("row", { name: new RegExp(`Luis ${RUN}`) }).innerText()).includes("Según el servicio"));
  ok("Luis muestra su día libre en el horario", (await page.getByRole("row", { name: new RegExp(`Luis ${RUN}`) }).innerText()).includes("Libre:"));
  await shot(page, "equipo");

  await page.getByRole("button", { name: "Nuevo profesional" }).first().click();
  const sd = page.getByRole("dialog", { name: "Nuevo profesional" });
  ok("la comisión nace vacía (sin porcentaje por defecto)", (await sd.getByLabel("Comisión (% opcional)").inputValue()) === "");
  await sd.getByLabel("Comisión (% opcional)").fill("50");
  await sd.getByRole("button", { name: "Dar de alta" }).click();
  ok("sin nombre se avisa", (await sd.innerText()).includes("al menos 2 caracteres"));
  await sd.getByLabel("Nombre").fill(`Marta UI ${RUN}`);
  await sd.getByLabel("Teléfono (opcional)").fill("abc");
  await sd.getByRole("button", { name: "Dar de alta" }).click();
  ok("un teléfono con letras se rechaza", (await sd.innerText()).includes("Teléfono no válido"));
  await sd.getByLabel("Teléfono (opcional)").fill("+51 912 345 678");
  await sd.getByRole("button", { name: "Dar de alta" }).click();
  await sd.waitFor({ state: "hidden" });
  const rowMarta = page.getByRole("row", { name: new RegExp(`Marta UI ${RUN}`) });
  ok("Marta aparece con su teléfono y 50 %", (await rowMarta.count()) === 1 && (await rowMarta.innerText()).includes("+51 912 345 678") && (await rowMarta.innerText()).includes("50%"));

  await page.getByRole("button", { name: `Horario de Marta UI ${RUN}` }).click();
  const hd = page.getByRole("dialog", { name: new RegExp(`Horario y comisiones · Marta UI ${RUN}`) });
  await hd.getByLabel("Domingo: tipo de horario").selectOption("libre");
  await hd.getByLabel("Sábado: tipo de horario").selectOption("custom");
  await hd.getByLabel("Sáb: entrada").fill("08:00");
  await hd.getByLabel("Sáb: salida").fill("14:00");
  await hd.getByRole("button", { name: "Guardar" }).click();
  await hd.waitFor({ state: "hidden" });
  ok("el horario se resume en la fila (Libre: Dom · Sáb 08:00–14:00)", (await rowMarta.innerText()).includes("Libre: Dom · Sáb 08:00–14:00"), await rowMarta.innerText());

  await page.getByRole("button", { name: `Horario de Marta UI ${RUN}` }).click();
  const hd2 = page.getByRole("dialog", { name: /Horario y comisiones/ });
  await hd2.getByLabel("Sábado: tipo de horario").selectOption("custom");
  await hd2.getByLabel("Sáb: entrada").fill("15:00");
  await hd2.getByLabel("Sáb: salida").fill("09:00");
  await hd2.getByRole("button", { name: "Guardar" }).click();
  ok("una salida antes de la entrada se rechaza en el diálogo", (await hd2.innerText()).includes("la hora de salida debe ser después"));
  await hd2.getByRole("button", { name: "Cancelar" }).click();

  await page.getByRole("button", { name: `Comisiones de Marta UI ${RUN}` }).click();
  const comm = page.getByRole("dialog", { name: /Horario y comisiones/ });
  await comm.getByLabel("Comisión global (%)").fill("45");
  await comm.getByLabel(new RegExp(`^Barba ${RUN}`)).fill("55");
  await comm.getByRole("button", { name: "Guardar" }).click();
  await comm.waitFor({ state: "hidden" });
  const martaApi = ((await api("/api/negocio/equipo")).json?.staff ?? []).find((s) => s.name === `Marta UI ${RUN}`);
  ok("comisión global 45 % y pacto Barba 55 % guardados", martaApi?.globalCommissionPercentage === 45 && martaApi?.commissions?.[0]?.percentage === 55 && martaApi?.commissions?.[0]?.serviceId === barba.id);
  ok("el horario guardado antes sobrevive al guardar comisiones", martaApi?.schedule?.length === 2);

  await page.getByRole("switch", { name: `Desactivar a Marta UI ${RUN}` }).click();
  ok("desactivar a Marta desde la fila", await until(async () => ((await api("/api/negocio/equipo")).json?.staff ?? []).find((s) => s.id === martaApi.id)?.active === false));
  await page.getByRole("button", { name: `Eliminar a Marta UI ${RUN}` }).click();
  await page.getByRole("dialog", { name: "Eliminar profesional" }).getByRole("button", { name: "Eliminar", exact: true }).click();
  ok("eliminar a Marta (sin ventas) quita la fila", await until(async () => (await rowMarta.count()) === 0));

  /* ---- Caja ---- */
  await page.getByRole("link", { name: "Caja" }).click();
  await page.waitForURL(/\/caja/);
  const reportNow = (await api(`/api/negocio/ventas?from=${hoy}&to=${hoy}`)).json;
  await page.getByText("Cierre de hoy").waitFor();
  const cajaTexto = async () => plain(await page.locator("main, body").first().innerText());
  ok("«Cierre de hoy» muestra ingresos, comisiones y neto del reporte", await until(async () => {
    const t = await cajaTexto();
    return t.includes(fmt(reportNow.totals.revenueCents)) && t.includes(fmt(reportNow.totals.commissionsCents)) && t.includes(fmt(reportNow.totals.netCents));
  }), `esperaba ${fmt(reportNow.totals.revenueCents)}`);
  const filaCaja = page.getByRole("row", { name: new RegExp(`Cliente Walk-in ${RUN}`) });
  ok("la tabla detalla fecha, cliente, profesional, combo, pago, comisión y neto", await until(async () => {
    const t = plain(await filaCaja.innerText());
    return t.includes(`Ana ${RUN}`) && t.includes(`Combo Fresh ${RUN}`) && t.includes("Yape") && t.includes("S/ 27.00") && t.includes("S/ 18.00");
  }));
  ok("la hora se pinta en la zona del negocio, no en la del navegador (Tokio)", await (async () => {
    const t = await filaCaja.innerText();
    const esperada = new Intl.DateTimeFormat("es-MX", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(B.json.sale.createdAt));
    return t.includes(esperada);
  })());
  ok("«A pagar a cada profesional» lista las comisiones", (await cajaTexto()).includes(fmt(2700)));
  await shot(page, "caja");

  // Filtro por rango
  await page.getByRole("button", { name: "Ayer", exact: true }).click();
  ok("«Ayer» recalcula: sin ventas", await until(async () => (await cajaTexto()).includes("Todavía no hay ventas en este periodo")));
  ok("…y el título refleja el rango", (await page.getByText(/^Cierre del \d{4}-\d{2}-\d{2}$/).count()) === 1);
  await page.getByRole("button", { name: "Este mes", exact: true }).click();
  ok("«Este mes» incluye las ventas de hoy", await until(async () => (await page.getByRole("row", { name: new RegExp(`Cliente Walk-in ${RUN}`) }).count()) === 1));
  await page.getByLabel("Desde").fill(hoy);
  await page.getByLabel("Hasta").fill(hoy);
  ok("las fechas sueltas también filtran", await until(async () => (await page.getByText("Cierre de hoy").count()) === 1));
  await page.getByRole("button", { name: "Hoy", exact: true }).click();

  // Registrar venta desde la pantalla
  const antes = (await api(`/api/negocio/ventas?from=${hoy}&to=${hoy}`)).json;
  await page.getByRole("button", { name: "Registrar venta" }).first().click();
  const sv = page.getByRole("dialog", { name: "Registrar venta" });
  await sv.getByRole("button", { name: "Registrar venta" }).click();
  ok("enviar vacío pide profesional, servicio y método", (await sv.getByRole("alert").count()) >= 3);
  await sv.getByLabel("Cliente").fill(`Cliente Uno ${RUN}`);
  await sv.getByRole("option", { name: new RegExp(`Cliente Uno ${RUN}`) }).waitFor({ timeout: 8000 });
  await sv.getByRole("option", { name: new RegExp(`Cliente Uno ${RUN}`) }).click();
  ok("se elige un contacto del CRM de la búsqueda", (await sv.innerText()).includes(`Cliente Uno ${RUN}`));
  await sv.getByLabel("Atendió").selectOption({ label: `Ana ${RUN}` });
  await sv.getByLabel("Servicio u oferta").selectOption({ label: `Barba ${RUN}` });
  ok("el monto se rellena con el precio de lista (15.00)", (await sv.getByLabel("Monto cobrado").inputValue()) === "15.00");
  await sv.getByLabel("Monto cobrado").fill("12");
  await sv.getByRole("radio", { name: "Plin" }).click();
  await sv.getByRole("button", { name: "Registrar venta" }).click();
  await sv.waitFor({ state: "hidden" });
  const despues = (await api(`/api/negocio/ventas?from=${hoy}&to=${hoy}`)).json;
  ok("la venta se registró con el monto editado (1200)", despues.totals.revenueCents - antes.totals.revenueCents === 1200);
  ok("…con la comisión de Ana (60 % global): 720", despues.totals.commissionsCents - antes.totals.commissionsCents === 720);
  ok("aviso de éxito con la comisión y su regla", await until(async () => { const t = await cajaTexto(); return t.includes("Venta registrada") && t.includes("S/ 7.20") && t.includes("porcentaje del profesional"); }));
  ok("los totales de pantalla se actualizan solos", await until(async () => (await cajaTexto()).includes(fmt(despues.totals.revenueCents))));

  // Anular
  await page.getByRole("button", { name: `Anular la venta de Cliente Uno ${RUN}` }).first().click();
  const vd = page.getByRole("dialog", { name: "Anular venta" });
  await vd.getByRole("button", { name: "Anular venta" }).click();
  await vd.waitFor({ state: "hidden" });
  ok("anular quita la venta de la caja", await until(async () => (await api(`/api/negocio/ventas?from=${hoy}&to=${hoy}`)).json?.totals?.count === despues.totals.count - 1));
  const trasAnular = (await api(`/api/negocio/ventas?from=${hoy}&to=${hoy}`)).json;
  ok("…y el total baja exactamente lo anulado (1200 de ingresos)", despues.totals.revenueCents - trasAnular.totals.revenueCents === 1200);
  ok("…y la pantalla se actualiza", await until(async () => (await cajaTexto()).includes(fmt(trasAnular.totals.revenueCents))));

  // CSV
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Exportar CSV" }).click()]);
  const csvPath = await download.path();
  const csv = (await import("node:fs")).readFileSync(csvPath, "utf8");
  const lines = csv.replace(/^﻿/, "").trim().split(/\r\n/);
  ok("el CSV trae BOM UTF-8 y la cabecera pedida", csv.startsWith("﻿") && lines[0] === "Fecha,Cliente,Profesional,Servicio u oferta,Pago,Monto,Comisión,Neto", lines[0]);
  ok("…una línea por venta del periodo", lines.length - 1 === trasAnular.totals.count, `${lines.length - 1} vs ${trasAnular.totals.count}`);
  ok("…con montos decimales exactos", lines.some((l) => l.includes(",27.00,") || l.includes("45.00,27.00,18.00")));
  ok("el archivo se llama con el rango", /^caja-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/.test(download.suggestedFilename()), download.suggestedFilename());

  /* ---- Agenda por sillas ---- */
  await page.getByRole("link", { name: "Agenda por sillas" }).click();
  await page.waitForURL(/\/agenda-por-sillas/);
  await page.getByLabel("Elegir el día").fill(D);
  // Las sillas ya están pintadas con los datos de HOY: se espera a las citas del día elegido.
  await page.getByRole("button", { name: new RegExp(`^Cita1 ${RUN}, 10:00`) }).waitFor({ timeout: 15000 });
  ok("la agenda dibuja una columna por silla", (await page.getByRole("columnheader", { name: new RegExp(`(Carlos|Ana|Luis) ${RUN}`) }).count()) === 3);
  ok("…y la columna de cupos", (await page.getByRole("columnheader", { name: "Cupos" }).count()) === 1);
  const chipC1 = page.getByRole("button", { name: new RegExp(`^Cita1 ${RUN}, 10:00`) });
  ok("la cita de Carlos está en su silla, cobrada", (await chipC1.count()) === 1 && /cobrada/.test((await chipC1.getAttribute("aria-label")) ?? ""));
  const fila10 = page.getByRole("row", { name: /^10:00/ });
  ok("la franja de las 10:00 muestra 1/3 cupos (una cita cancelada)", (await fila10.innerText()).includes("1/3"), await fila10.innerText());
  ok("la franja de las 11:00 muestra 3/3", (await page.getByRole("row", { name: /^11:00/ }).innerText()).includes("3/3"));
  ok("el bloqueo se ve en 15:00 y 15:30", (await page.getByRole("row", { name: /^15:00/ }).innerText()).includes("Bloqueado") && (await page.getByRole("row", { name: /^15:30/ }).innerText()).includes("Bloqueado"));
  ok("«Libre» en las sillas sin cita", (await page.getByRole("row", { name: /^11:00/ }).innerText()).split("Libre").length - 1 === 3);
  await shot(page, "agenda");

  // Detalle y asignación
  const chipC2 = page.getByRole("button", { name: new RegExp(`^Cita2 ${RUN}, 10:00`) });
  await chipC2.click();
  const bp = page.getByRole("dialog", { name: new RegExp(`Cita2 ${RUN}`) });
  ok("el panel de la cita muestra estado y origen", (await bp.innerText()).includes("Agendada") && (await bp.innerText()).includes("Manual"));
  await bp.getByLabel("Atiende").selectOption({ label: `Carlos ${RUN}` });
  await bp.getByRole("button", { name: "Guardar profesional" }).click();
  ok("asignar a un profesional ocupado muestra el 409 en el panel", await until(async () => (await bp.innerText()).includes("ya tiene una cita a esa hora")));
  await bp.getByLabel("Atiende").selectOption({ label: `Luis ${RUN}` });
  await bp.getByRole("button", { name: "Guardar profesional" }).click();
  await bp.waitFor({ state: "hidden" });
  ok("reasignar a Luis (libre) funciona y se refleja", await until(async () => (await api(`/api/negocio/agenda?date=${D}`)).json?.bookings?.find((b) => b.id === k2.json.bookingId)?.staffId === luis.id));

  // Cobrar desde la agenda
  await page.getByRole("button", { name: new RegExp(`^Cita2 ${RUN}, 10:00`) }).click();
  const bp2 = page.getByRole("dialog", { name: new RegExp(`Cita2 ${RUN}`) });
  await bp2.getByRole("button", { name: "Cobrar", exact: true }).click();
  const sd2 = page.getByRole("dialog", { name: "Cobrar cita" });
  // El formulario aparece cuando cargan las opciones: se espera a un campo antes de leer.
  await sd2.getByLabel("Atendió").waitFor();
  ok("«Cobrar cita» llega con el cliente y el profesional ya puestos", (await sd2.innerText()).includes(`Cita2 ${RUN}`) && (await sd2.getByLabel("Atendió").inputValue()) === luis.id);
  await sd2.getByLabel("Servicio u oferta").selectOption({ label: `Barba ${RUN}` });
  await sd2.getByRole("radio", { name: "Efectivo" }).click();
  await sd2.getByRole("button", { name: "Registrar venta" }).click();
  await sd2.waitFor({ state: "hidden" });
  ok("cobrar desde la agenda: aviso y la cita queda cobrada", await until(async () => (await page.getByText(/^Cobrado: /).count()) === 1) && (await until(async () => /cobrada/.test((await page.getByRole("button", { name: new RegExp(`^Cita2 ${RUN}, 10:00`) }).getAttribute("aria-label")) ?? ""))));

  // Tiempo real: una cita creada por otro canal aparece sin recargar
  const c5 = await mk("Cita5");
  await page.getByLabel("Elegir el día").fill(D);
  const chip5 = page.getByRole("button", { name: new RegExp(`^Cita5 ${RUN}, 11:00`) });
  ok("(antes) la cita nueva no está", (await chip5.count()) === 0);
  const k5 = await book(c5.id, wallToUtc(D, "11:00"));
  ok("se agenda por la API (como lo haría el agente)", k5.status === 201);
  ok("TIEMPO REAL: aparece en la agenda abierta sin recargar", await until(async () => (await chip5.count()) === 1, 12000));
  ok("…en la columna «Sin asignar» (aparece al haber una)", (await page.getByRole("columnheader", { name: "Sin asignar" }).count()) === 1);

  ok("navegar el día: «Día siguiente» y «Hoy»", await (async () => {
    await page.getByRole("button", { name: "Día siguiente" }).click();
    await page.getByRole("columnheader", { name: `Carlos ${RUN}` }).waitFor();
    await page.getByRole("button", { name: "Hoy", exact: true }).click();
    return await until(async () => (await page.getByLabel("Elegir el día").inputValue()) === hoy);
  })());
  ok("sin errores de consola ni de página", errores.length === 0, errores.slice(0, 3).join(" | "));

  /* ---- Móvil ---- */
  console.log("\n== Móvil (390 px) ==");
  const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: TZ_NAVEGADOR, locale: "es-PE" });
  const mobApi = makeApi(mob);
  await mobApi("/api/auth/sign-in/email", { method: "POST", body: { email: "salon-e2e@vocero.test", password: "password-e2e-123" } });
  const mp = await mob.newPage();
  for (const p of ["/servicios", "/equipo", "/caja", `/agenda-por-sillas`]) {
    await mp.goto(`${BASE}${p}`, { waitUntil: "load" });
    await sleep(1500);
    ok(`${p}: no desborda a lo ancho`, await noHorizontalOverflow(mp));
  }
  await mp.goto(`${BASE}/caja`, { waitUntil: "load" });
  await mp.getByRole("button", { name: "Registrar venta" }).first().click();
  const dm = mp.getByRole("dialog", { name: "Registrar venta" });
  await dm.waitFor();
  ok("el diálogo de cobro cabe en el teléfono", await mp.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    const r = d?.getBoundingClientRect();
    return !!r && r.left >= 0 && r.right <= window.innerWidth + 1;
  }));
  await shot(mp, "movil-cobro");
  await mob.close();

  /* ---- Miembro del equipo en la interfaz ---- */
  console.log("\n== Recepción en la interfaz ==");
  const mpage = await mctx.newPage();
  await mpage.goto(`${BASE}/bandeja`, { waitUntil: "domcontentloaded" });
  ok("recepción ve «Agenda por sillas» en el menú (hay agenda)", (await mpage.locator('a[href="/agenda-por-sillas"]').count()) === 1);
  ok("…y no ve Servicios, Equipo ni Caja", (await mpage.locator('a[href="/servicios"], a[href="/equipo"], a[href="/caja"]').count()) === 0);
  await mpage.locator('a[href="/agenda-por-sillas"]').click();
  await mpage.waitForURL(/\/agenda-por-sillas/);
  ok("…y abre la agenda por sillas", mpage.url().includes("/agenda-por-sillas"));
  for (const p of ["/caja", "/equipo", "/servicios"]) {
    await mpage.goto(`${BASE}${p}`, { waitUntil: "domcontentloaded" });
    await mpage.waitForURL(/\/agenda-por-sillas/, { timeout: 8000 }).catch(() => {});
    ok(`recepción no entra a ${p} (la manda a la agenda)`, mpage.url().includes("/agenda-por-sillas"), mpage.url());
  }
  await mctx.close();
}

try {
  await main();
} catch (err) {
  failures++;
  console.log(`  FAIL excepción no controlada — ${err?.stack ?? err}`);
} finally {
  await browser.close();
}

console.log(`\n${checks - failures}/${checks} checks OK${failures ? ` — ${failures} FALLARON` : ""}`);
process.exit(failures ? 1 : 0);
