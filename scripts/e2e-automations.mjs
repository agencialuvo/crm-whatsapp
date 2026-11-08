/**
 * Self-test E2E de comportamiento — API de gestión de automatizaciones (`/api/automations`).
 *
 * Qué conduce, contra la app REAL y con sesiones de verdad:
 *  - Apagado (sin AUTOMATIONS): ninguna ruta existe (404).
 *  - Seguridad: sin sesión → 401; un miembro del equipo → 403; el dueño pasa.
 *  - Multi-tenant: la otra organización recibe 404 en TODA operación sobre flujos y pasos ajenos,
 *    y no ve sus flujos en el listado.
 *  - Validación (422): disparadores sin ejecutor, claves desconocidas, ajustes y config inválidos,
 *    etapa o plantilla inexistentes, JSON roto.
 *  - Reglas: un flujo nace apagado, encender exige pasos (409), el orden de ejecución sigue al lienzo,
 *    el último paso borrado apaga el flujo, el tope de pasos, y la cascada al borrar el flujo.
 *
 * Antes: pnpm e2e:cuentas crear   (dos propietarios de negocios distintos). Al terminar: pnpm e2e:cuentas borrar
 *
 * Uso: AUTOMATIONS=on node --env-file=.env scripts/e2e-automations.mjs   (contra la instancia viva)
 *      node --env-file=.env scripts/e2e-automations.mjs                  (con la app SIN la bandera: comprueba los 404)
 * Debe correrse con el MISMO valor de AUTOMATIONS que la app que prueba.
 *
 * ⚠ Úsalo solo contra una instancia de PRUEBAS: crea (y borra al terminar) usuarios y flujos.
 */

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const ON = /^(on|1|true|si|sí|yes)$/i.test((process.env.AUTOMATIONS ?? "").trim());
const RUN = Date.now().toString(36);
const PASS = "password-e2e-123";

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

/** Cliente HTTP con su propio jar de cookies: cada instancia es una sesión distinta. */
function client() {
  const jar = new Map();
  return async function api(p, opts = {}) {
    const headers = { origin: BASE, "content-type": "application/json" };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${BASE}${p}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
      redirect: "manual",
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* sin cuerpo */
    }
    return { status: res.status, json };
  };
}

/** El registro público ya no abre sesión: las cuentas de prueba las crea `pnpm e2e:cuentas crear`. */
async function login(api, email) {
  const r = await api("/api/auth/sign-in/email", { method: "POST", body: { email, password: PASS } });
  if (r.status >= 400) console.log(`  (no se pudo iniciar sesión con ${email}: ¿corriste "pnpm e2e:cuentas crear"?)`);
  return r.status < 400;
}

const errCode = (r) => r.json?.error?.code;

async function main() {
  console.log(`== Setup (AUTOMATIONS ${ON ? "encendida" : "apagada"}) ==`);
  const A = client();
  const B = client();
  ok("login del dueño A", await login(A, "automations-e2e@vocero.test"));
  ok("login del dueño B (otra organización)", await login(B, "automations-e2e-b@vocero.test"));

  const routes = [
    ["GET", "/api/automations"],
    ["POST", "/api/automations"],
    ["GET", "/api/automations/aut_x"],
    ["PATCH", "/api/automations/aut_x"],
    ["DELETE", "/api/automations/aut_x"],
    ["POST", "/api/automations/aut_x/steps"],
    ["PATCH", "/api/automations/aut_x/steps/stp_x"],
    ["DELETE", "/api/automations/aut_x/steps/stp_x"],
  ];

  if (!ON) {
    console.log("\n== Apagado: la superficie no existe ==");
    for (const [method, p] of routes) {
      const r = await A(p, { method, body: method === "GET" || method === "DELETE" ? undefined : {} });
      ok(`${method} ${p} → 404`, r.status === 404, `status=${r.status}`);
    }
    return;
  }

  console.log("\n== Seguridad: sin sesión → 401 ==");
  const anon = client();
  for (const [method, p] of routes) {
    const r = await anon(p, { method, body: method === "GET" || method === "DELETE" ? undefined : {} });
    ok(`${method} ${p} sin sesión → 401`, r.status === 401, `status=${r.status}`);
  }

  console.log("\n== Seguridad: un miembro del equipo → 403 ==");
  const memberEmail = `automations-miembro-${RUN}@vocero.test`;
  const add = await A("/api/settings/team", { method: "POST", body: { name: "Recepción", email: memberEmail, password: PASS } });
  ok("el dueño crea la cuenta del miembro", add.status === 201, `status=${add.status}`);
  const M = client();
  ok("el miembro inicia sesión", (await M("/api/auth/sign-in/email", { method: "POST", body: { email: memberEmail, password: PASS } })).status < 400);
  for (const [method, p] of routes) {
    const r = await M(p, { method, body: method === "GET" || method === "DELETE" ? undefined : {} });
    ok(`${method} ${p} como miembro → 403`, r.status === 403 && errCode(r) === "forbidden", `status=${r.status}`);
  }

  console.log("\n== Crear y listar flujos ==");
  const stage = (await A("/api/pipeline/stages")).json?.stages?.[0];
  ok("la organización A tiene etapas", !!stage?.id);
  const stageB = (await B("/api/pipeline/stages")).json?.stages?.[0];

  const created = await A("/api/automations", { method: "POST", body: { name: `Cumple ${RUN}`, triggerType: "birthday", triggerConfig: { hour: 9 } } });
  ok("crear un flujo → 201", created.status === 201, `status=${created.status}`);
  const flow = created.json?.flow;
  ok("nace apagado, con su disparador y sus ajustes", flow?.active === false && flow?.triggerType === "birthday" && flow?.triggerConfig?.hour === 9);
  ok("el id lleva el prefijo del recurso", /^aut_/.test(flow?.id ?? ""));

  const stageFlow = (await A("/api/automations", { method: "POST", body: { name: `Etapa ${RUN}`, triggerType: "stage_changed", triggerConfig: { toStageId: stage.id } } })).json?.flow;
  ok("un flujo de cambio de etapa guarda su etapa", stageFlow?.triggerConfig?.toStageId === stage.id);
  const bare = (await A("/api/automations", { method: "POST", body: { name: `Lead ${RUN}`, triggerType: "lead_created" } })).json?.flow;
  ok("sin ajustes, triggerConfig queda en null", bare && bare.triggerConfig === null);

  const list = await A("/api/automations");
  const row = list.json?.flows?.find((f) => f.id === flow.id);
  ok("el listado trae los campos principales", list.status === 200 && row && ["id", "name", "triggerType", "active", "createdAt"].every((k) => k in row));
  ok("…y la cantidad de pasos", row?.stepCount === 0);
  ok("los más nuevos primero", list.json.flows[0].createdAt >= list.json.flows[list.json.flows.length - 1].createdAt);

  console.log("\n== Validación (422) ==");
  const bad = async (label, p, opts) => {
    const r = await A(p, opts);
    ok(label, r.status === 422 && errCode(r) !== undefined, `status=${r.status} ${JSON.stringify(r.json)}`);
    return r;
  };
  await bad("JSON roto", "/api/automations", { method: "POST", raw: "{no es json" });
  await bad("sin nombre", "/api/automations", { method: "POST", body: { triggerType: "manual" } });
  await bad("nombre en blanco", "/api/automations", { method: "POST", body: { name: "   ", triggerType: "manual" } });
  const bookingRes = await bad("booking_reminder aún no tiene disparador", "/api/automations", { method: "POST", body: { name: "x", triggerType: "booking_reminder" } });
  ok("…y el mensaje lo explica", /aún no tienen disparador/.test(bookingRes.json?.error?.message ?? ""));
  await bad("tag_added aún no tiene disparador", "/api/automations", { method: "POST", body: { name: "x", triggerType: "tag_added" } });
  await bad("un disparador inventado", "/api/automations", { method: "POST", body: { name: "x", triggerType: "inventado" } });
  await bad("`active` al crear (nace apagado)", "/api/automations", { method: "POST", body: { name: "x", triggerType: "manual", active: true } });
  await bad("una clave desconocida (organizationId)", "/api/automations", { method: "POST", body: { name: "x", triggerType: "manual", organizationId: "org_otra" } });
  await bad("hora de cumpleaños fuera de rango", "/api/automations", { method: "POST", body: { name: "x", triggerType: "birthday", triggerConfig: { hour: 25 } } });
  await bad("ajustes que el tipo no admite", "/api/automations", { method: "POST", body: { name: "x", triggerType: "manual", triggerConfig: { hour: 9 } } });
  const noStage = await A("/api/automations", { method: "POST", body: { name: "x", triggerType: "stage_changed", triggerConfig: { toStageId: "stg_no_existe" } } });
  ok("una etapa que no existe → 422 stage_not_found", noStage.status === 422 && errCode(noStage) === "stage_not_found");
  if (stageB?.id) {
    const foreign = await A("/api/automations", { method: "POST", body: { name: "x", triggerType: "stage_changed", triggerConfig: { toStageId: stageB.id } } });
    ok("una etapa de OTRA organización → 422 stage_not_found", foreign.status === 422 && errCode(foreign) === "stage_not_found");
  }
  await bad("PATCH vacío", `/api/automations/${flow.id}`, { method: "PATCH", body: {} });
  await bad("PATCH no cambia el tipo de disparador", `/api/automations/${flow.id}`, { method: "PATCH", body: { triggerType: "manual" } });
  await bad("PATCH con ajustes que su tipo no admite", `/api/automations/${flow.id}`, { method: "PATCH", body: { triggerConfig: { toStageId: stage.id } } });

  console.log("\n== Pasos ==");
  const stepsUrl = `/api/automations/${flow.id}/steps`;
  await bad("un paso sin mensaje ni plantilla", stepsUrl, { method: "POST", body: { stepType: "send_whatsapp", config: {} } });
  await bad("una espera en cero", stepsUrl, { method: "POST", body: { stepType: "delay", config: { amount: 0, unit: "hours" } } });
  await bad("una unidad inventada", stepsUrl, { method: "POST", body: { stepType: "delay", config: { amount: 1, unit: "weeks" } } });
  await bad("la config de un tipo en otro", stepsUrl, { method: "POST", body: { stepType: "delay", config: { content: "Hola" } } });
  const cond = await bad("condition aún no tiene ejecutor", stepsUrl, { method: "POST", body: { stepType: "condition", config: {} } });
  ok("…y el mensaje lo explica", /aún no tienen ejecutor/.test(cond.json?.error?.message ?? ""));
  await bad("add_tag aún no tiene ejecutor", stepsUrl, { method: "POST", body: { stepType: "add_tag", config: {} } });
  await bad("posición fuera de rango", stepsUrl, { method: "POST", body: { stepType: "delay", config: { amount: 1, unit: "days" }, positionX: 9_999_999 } });
  const noTpl = await A(stepsUrl, { method: "POST", body: { stepType: "send_whatsapp", config: { templateId: "tpl_no_existe" } } });
  ok("una plantilla que no existe → 422 template_not_found", noTpl.status === 422 && errCode(noTpl) === "template_not_found");

  const s3 = (await A(stepsUrl, { method: "POST", body: { stepType: "send_whatsapp", config: { name: "Felicitación", content: "Feliz cumple {{name}}" }, positionX: 0, positionY: 200 } })).json?.step;
  const s1 = (await A(stepsUrl, { method: "POST", body: { stepType: "send_whatsapp", config: { content: "Hola {{name}}" }, positionX: 0, positionY: 0 } })).json?.step;
  const s2 = (await A(stepsUrl, { method: "POST", body: { stepType: "delay", config: { amount: 2, unit: "hours" }, positionX: 0, positionY: 100 } })).json?.step;
  ok("crear pasos → 201 con su config y posición", s1?.id && s2?.id && s3?.id && s3.positionY === 200 && s3.config.content === "Feliz cumple {{name}}");
  ok("el id del paso lleva su prefijo", /^stp_/.test(s1?.id ?? ""));

  const detail = await A(`/api/automations/${flow.id}`);
  ok("el detalle devuelve el flujo con sus pasos", detail.status === 200 && detail.json?.flow?.id === flow.id && detail.json?.steps?.length === 3);
  ok("…en orden de ejecución, numerados", detail.json.steps.map((s) => s.id).join() === [s1.id, s2.id, s3.id].join() && detail.json.steps.map((s) => s.order).join() === "1,2,3");

  const moved = await A(`${stepsUrl}/${s3.id}`, { method: "PATCH", body: { positionY: -50, config: { content: "Nuevo texto" } } });
  ok("editar un paso (config y posición) → 200", moved.status === 200 && moved.json?.step?.config?.content === "Nuevo texto" && moved.json.step.positionY === -50);
  ok("mover un nodo cambia el orden de ejecución", (await A(`/api/automations/${flow.id}`)).json.steps[0].id === s3.id);
  const badPatch = await A(`${stepsUrl}/${s2.id}`, { method: "PATCH", body: { config: { content: "no es un delay" } } });
  ok("la config se valida contra el tipo que YA tiene el paso → 422", badPatch.status === 422 && errCode(badPatch) === "invalid_step_config");
  await bad("el tipo de un paso no se cambia", `${stepsUrl}/${s2.id}`, { method: "PATCH", body: { stepType: "send_whatsapp" } });

  console.log("\n== Encender y apagar ==");
  const empty = (await A("/api/automations", { method: "POST", body: { name: `Vacío ${RUN}`, triggerType: "manual" } })).json?.flow;
  const noSteps = await A(`/api/automations/${empty.id}`, { method: "PATCH", body: { active: true } });
  ok("encender un flujo sin pasos → 409 flow_without_steps", noSteps.status === 409 && errCode(noSteps) === "flow_without_steps");
  const on = await A(`/api/automations/${flow.id}`, { method: "PATCH", body: { active: true, name: `Cumple VIP ${RUN}` } });
  ok("con pasos se enciende (y renombra) → 200", on.status === 200 && on.json?.flow?.active === true && on.json.flow.name === `Cumple VIP ${RUN}`);
  const cfg = await A(`/api/automations/${flow.id}`, { method: "PATCH", body: { triggerConfig: { hour: 7 } } });
  ok("cambiar los ajustes no toca el estado", cfg.status === 200 && cfg.json.flow.triggerConfig.hour === 7 && cfg.json.flow.active === true);
  const off = await A(`/api/automations/${flow.id}`, { method: "PATCH", body: { active: false } });
  ok("apagar → 200", off.status === 200 && off.json.flow.active === false);

  console.log("\n== Multi-tenant: la organización B no alcanza lo de A ==");
  const bList = (await B("/api/automations")).json?.flows ?? [];
  ok("B no ve los flujos de A en su listado", !bList.some((f) => [flow.id, stageFlow.id, bare.id, empty.id].includes(f.id)));
  const foreignOps = [
    ["GET detalle", await B(`/api/automations/${flow.id}`)],
    ["PATCH", await B(`/api/automations/${flow.id}`, { method: "PATCH", body: { name: "robado" } })],
    ["DELETE", await B(`/api/automations/${flow.id}`, { method: "DELETE" })],
    ["POST paso", await B(stepsUrl, { method: "POST", body: { stepType: "delay", config: { amount: 1, unit: "days" } } })],
    ["PATCH paso", await B(`${stepsUrl}/${s1.id}`, { method: "PATCH", body: { positionX: 1 } })],
    ["DELETE paso", await B(`${stepsUrl}/${s1.id}`, { method: "DELETE" })],
  ];
  for (const [label, r] of foreignOps) ok(`${label} de un flujo ajeno → 404 (no 403)`, r.status === 404 && errCode(r) === "not_found", `status=${r.status}`);
  const intact = (await A(`/api/automations/${flow.id}`)).json;
  ok("nada de A cambió tras los intentos de B", intact.flow.name === `Cumple VIP ${RUN}` && intact.steps.length === 3);
  const wrongFlow = await A(`/api/automations/${empty.id}/steps/${s1.id}`, { method: "PATCH", body: { positionX: 3 } });
  ok("un paso solo se alcanza por SU flujo → 404", wrongFlow.status === 404);

  console.log("\n== Borrar ==");
  const solo = (await A("/api/automations", { method: "POST", body: { name: `Solo ${RUN}`, triggerType: "manual" } })).json.flow;
  const only = (await A(`/api/automations/${solo.id}/steps`, { method: "POST", body: { stepType: "delay", config: { amount: 1, unit: "days" } } })).json.step;
  await A(`/api/automations/${solo.id}`, { method: "PATCH", body: { active: true } });
  ok("borrar el único paso → 200", (await A(`/api/automations/${solo.id}/steps/${only.id}`, { method: "DELETE" })).status === 200);
  ok("…y el flujo encendido se apaga solo", (await A(`/api/automations/${solo.id}`)).json.flow.active === false);
  ok("borrar el mismo paso otra vez → 404", (await A(`/api/automations/${solo.id}/steps/${only.id}`, { method: "DELETE" })).status === 404);

  const del = await A(`/api/automations/${flow.id}`, { method: "DELETE" });
  ok("borrar el flujo → 200", del.status === 200 && del.json?.ok === true);
  ok("ya no existe (404)", (await A(`/api/automations/${flow.id}`)).status === 404);
  ok("sus pasos se fueron con él (404 al editarlos)", (await A(`${stepsUrl}/${s1.id}`, { method: "PATCH", body: { positionX: 1 } })).status === 404);
  ok("borrarlo otra vez → 404", (await A(`/api/automations/${flow.id}`, { method: "DELETE" })).status === 404);

  console.log("\n== Tope de pasos ==");
  const big = (await A("/api/automations", { method: "POST", body: { name: `Grande ${RUN}`, triggerType: "manual" } })).json.flow;
  let created50 = 0;
  for (let i = 0; i < 50; i++) {
    const r = await A(`/api/automations/${big.id}/steps`, { method: "POST", body: { stepType: "delay", config: { amount: 1, unit: "minutes" }, positionY: i } });
    if (r.status === 201) created50++;
  }
  ok("caben 50 pasos", created50 === 50, `creados=${created50}`);
  const over = await A(`/api/automations/${big.id}/steps`, { method: "POST", body: { stepType: "delay", config: { amount: 1, unit: "minutes" } } });
  ok("el paso 51 → 409 too_many_steps", over.status === 409 && errCode(over) === "too_many_steps");

  console.log("\n== Limpieza ==");
  for (const id of [stageFlow.id, bare.id, empty.id, solo.id, big.id]) await A(`/api/automations/${id}`, { method: "DELETE" });
  ok("el dueño A queda sin flujos de prueba", !((await A("/api/automations")).json?.flows ?? []).some((f) => /E2E|Cumple|Etapa|Lead|Vacío|Solo|Grande/.test(f.name) && f.name.endsWith(RUN)));
}

try {
  await main();
} catch (err) {
  failures++;
  console.error("\nERROR no controlado:", err);
}
console.log(`\n${checks - failures}/${checks} comprobaciones OK`);
process.exit(failures === 0 ? 0 : 1);
