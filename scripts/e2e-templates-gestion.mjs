/**
 * Self-test E2E de comportamiento — gestionar plantillas: borrar, editar y sincronizar varias páginas
 * (guion tests/e2e/us6-templates.md, «Borrar» y «Editar»).
 *
 * Contra la app real y el wa-mock: borrar quita la plantilla aquí Y en Meta (solo ese idioma, por `hsm_id`);
 * una plantilla que ya no está en Meta se quita igual; una que usa una automatización no se borra (409
 * `in_use`) hasta quitar el paso; borrar dos veces da 404. En el navegador: el icono de papelera, el
 * diálogo de confirmación y la lista sin la plantilla.
 *
 * Uso: node --env-file=.env scripts/e2e-templates-gestion.mjs
 * Requiere: app corriendo (pnpm dev) con WA_MOCK_ENABLED=true y BD migrada.
 */
import { chromium } from "playwright";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const PN = "PN-TPL-1";
const WABA = "WABA-TPL";
const stamp = Date.now().toString(36);

let failures = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
};

const browser = await chromium.launch(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {});
const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
const req = ctx.request;
const api = async (path, { method = "GET", body } = {}) => {
  const r = await req.fetch(`${BASE}${path}`, { method, data: body, headers: { origin: BASE } });
  return { status: r.status(), json: await r.json().catch(() => null) };
};

console.log("== Setup: sesión + conexión WhatsApp ==");
const email = "e2e@vocero.test";
const password = "password-e2e-123";
let s = await api("/api/auth/sign-in/email", { method: "POST", body: { email, password } });
if (s.status !== 200) s = await api("/api/auth/sign-up/email", { method: "POST", body: { email, password, name: "Operador E2E" } });
ok("sesión iniciada", s.status === 200, `status ${s.status}`);
const conn = await api("/api/settings/whatsapp", { method: "PUT", body: { wabaId: WABA, phoneNumberId: PN, token: "tok-tpl" } });
ok("conexión WhatsApp guardada", conn.status === 200, JSON.stringify(conn.json));

const crear = async (name) => {
  const r = await api("/api/templates", {
    method: "POST",
    body: { name, language: "es_MX", category: "UTILITY", body: "Hola {{1}}, ¿retomamos tu cotización?", examples: ["Ana"] },
  });
  return r.json?.template;
};
const enMeta = async (name) => {
  for (let after = 0; ; ) {
    const r = await api(`/api/dev/wa-mock/graph/${WABA}/message_templates?limit=100&after=${after}`);
    if ((r.json?.data ?? []).some((t) => t.name === name)) return true;
    if (!r.json?.paging?.next) return false;
    after = Number(r.json.paging.cursors.after);
  }
};
const enLista = async (id) => ((await api("/api/templates")).json?.templates ?? []).some((t) => t.id === id);

console.log("\n== Borrar: aquí y en Meta ==");
const a = await crear(`borrar_${stamp}`);
ok("plantilla creada y enviada a Meta", !!a && (await enMeta(a.name)));
const del = await api(`/api/templates/${a.id}`, { method: "DELETE" });
ok("DELETE → 200", del.status === 200, `status ${del.status} ${JSON.stringify(del.json)}`);
ok("ya no sale en la lista", !(await enLista(a.id)));
ok("ya no está en Meta", !(await enMeta(a.name)));
const again = await api(`/api/templates/${a.id}`, { method: "DELETE" });
ok("borrar dos veces → 404 not_found", again.status === 404 && again.json?.error?.code === "not_found", `status ${again.status}`);

console.log("\n== Ya borrada en Meta (desde el Administrador de WhatsApp) ==");
const b = await crear(`fantasma_${stamp}`);
await req.fetch(`${BASE}/api/dev/wa-mock/graph/${WABA}/message_templates?name=${b.name}`, {
  method: "DELETE",
  headers: { authorization: "Bearer tok-tpl" },
});
ok("Meta ya no la tiene", !(await enMeta(b.name)));
const delB = await api(`/api/templates/${b.id}`, { method: "DELETE" });
ok("el CRM la quita igual → 200", delB.status === 200 && !(await enLista(b.id)), `status ${delB.status} ${JSON.stringify(delB.json)}`);

console.log("\n== En uso por una automatización ==");
const c = await crear(`en_uso_${stamp}`);
const flow = (await api("/api/automations", { method: "POST", body: { name: `Usa plantilla ${stamp}`, triggerType: "lead_created" } })).json?.flow;
const step = (await api(`/api/automations/${flow?.id}/steps`, { method: "POST", body: { stepType: "send_whatsapp", config: { templateId: c?.id } } })).json?.step;
ok("flujo con paso que envía la plantilla", !!flow && !!step);
const blocked = await api(`/api/templates/${c.id}`, { method: "DELETE" });
ok(
  "DELETE → 409 in_use, nombra el flujo",
  blocked.status === 409 && blocked.json?.error?.code === "in_use" && blocked.json?.error?.message?.includes(`Usa plantilla ${stamp}`),
  `status ${blocked.status} ${JSON.stringify(blocked.json)}`
);
ok("sigue en la lista y en Meta", (await enLista(c.id)) && (await enMeta(c.name)));
await api(`/api/automations/${flow.id}/steps/${step.id}`, { method: "DELETE" });

console.log("\n== En el navegador: papelera → confirmar ==");
const page = await ctx.newPage();
await page.goto(`${BASE}/ajustes/plantillas`);
const fila = page.locator("li", { hasText: c.name });
await fila.waitFor({ timeout: 20000 });
await fila.getByRole("button", { name: `Borrar la plantilla ${c.name}` }).click();
await page.getByText("¿Borrar esta plantilla?").waitFor();
await page.getByRole("button", { name: "Borrar plantilla" }).click();
await page.getByText(`Plantilla «${c.name}» borrada`).waitFor({ timeout: 15000 }).catch(() => {});
ok("aviso de borrada en pantalla", await page.getByText(`Plantilla «${c.name}» borrada`).isVisible());
ok("la fila desaparece", (await fila.count()) === 0);
ok("y ya no está ni aquí ni en Meta", !(await enLista(c.id)) && !(await enMeta(c.name)));

/** Mueve solo el panel simulado de Meta (sin webhook, como en modo agencia) y sincroniza. */
const metaMarca = async (name, event) => {
  await api("/api/dev/wa-mock/template-status", { method: "POST", body: { wabaId: WABA, name, language: "es_MX", event, notify: false } });
  return api("/api/templates/sync", { method: "POST" });
};
const local = async (id) => ((await api("/api/templates")).json?.templates ?? []).find((t) => t.id === id);
const remota = async (name) => {
  let after = 0;
  for (;;) {
    const r = await api(`/api/dev/wa-mock/graph/${WABA}/message_templates?limit=100&after=${after}`);
    const hit = (r.json?.data ?? []).find((t) => t.name === name);
    if (hit || !r.json?.paging?.next) return hit;
    after = Number(r.json.paging.cursors.after);
  }
};
const editar = (id, body) => api(`/api/templates/${id}`, { method: "PATCH", body });

console.log("\n== Editar ==");
const e = await crear(`editar_${stamp}`);
const enRevision = await editar(e.id, { category: "UTILITY", body: "Hola {{1}}, ¿seguimos?", examples: ["Ana"] });
ok("en revisión no se edita → 409 not_editable", enRevision.status === 409 && enRevision.json?.error?.code === "not_editable", `status ${enRevision.status}`);
await metaMarca(e.name, "APPROVED");
ok("Meta la aprueba (sync)", (await local(e.id))?.status === "approved");
const cat = await editar(e.id, { category: "MARKETING", body: "Hola {{1}}, ¿seguimos?", examples: ["Ana"] });
ok("aprobada no cambia de categoría → 422", cat.status === 422, `status ${cat.status}`);
const igual = await editar(e.id, { category: "UTILITY", body: (await local(e.id)).body });
ok("sin cambios → 422", igual.status === 422, `status ${igual.status}`);
const nuevoTexto = `Hola {{1}}, te escribe Clínica Sol sobre tu cotización ${stamp}.`;
const ed = await editar(e.id, { category: "UTILITY", body: nuevoTexto, examples: ["Ana"] });
ok("editar aprobada → 200 y vuelve a revisión", ed.status === 200 && ed.json?.template?.status === "pending", `status ${ed.status} ${JSON.stringify(ed.json)}`);
const r1 = await remota(e.name);
ok("en Meta: texto nuevo y PENDING", r1?.status === "PENDING" && r1?.components?.[0]?.text === nuevoTexto, JSON.stringify(r1));
ok("aquí: texto nuevo", (await local(e.id))?.body === nuevoTexto);

await metaMarca(e.name, "REJECTED");
ok("Meta la rechaza (sync)", (await local(e.id))?.status === "rejected");
const corr = await editar(e.id, { category: "MARKETING", body: "Hola {{1}}, esta semana tenemos lugares en Clínica Sol.", examples: ["Ana"] });
ok("rechazada sí cambia de categoría → 200", corr.status === 200 && corr.json?.template?.category === "MARKETING", `status ${corr.status}`);
ok("en Meta: categoría MARKETING", (await remota(e.name))?.category === "MARKETING");

console.log("\n== Editar una plantilla en uso ==");
const u = await crear(`uso_edit_${stamp}`);
const flow2 = (await api("/api/automations", { method: "POST", body: { name: `Edita plantilla ${stamp}`, triggerType: "lead_created" } })).json?.flow;
await api(`/api/automations/${flow2?.id}/steps`, { method: "POST", body: { stepType: "send_whatsapp", config: { templateId: u?.id, variables: ["{{name}}"] } } });
await metaMarca(u.name, "APPROVED");
const masVars = await editar(u.id, { category: "UTILITY", body: "Hola {{1}}, tu cita es el {{2}}.", examples: ["Ana", "martes"] });
ok("cambiar el número de variables → 409 in_use", masVars.status === 409 && masVars.json?.error?.code === "in_use", `status ${masVars.status}`);
const mismas = await editar(u.id, { category: "UTILITY", body: "Hola {{1}}, ¿retomamos tu cotización esta semana?", examples: ["Ana"] });
ok("mismas variables → 200", mismas.status === 200, `status ${mismas.status} ${JSON.stringify(mismas.json)}`);

console.log("\n== Sincronizar más de una página (Meta da 25 por defecto) ==");
let ultima = null;
for (let i = 0; i < 27; i++) ultima = await crear(`pag_${stamp}_${i}`);
await metaMarca(ultima.name, "APPROVED");
ok("la plantilla 27+ también se sincroniza", (await local(ultima.id))?.status === "approved");

console.log("\n== En el navegador: lápiz → editar → guardar ==");
await metaMarca(ultima.name, "APPROVED");
await page.goto(`${BASE}/ajustes/plantillas`);
const filaE = page.locator("li", { hasText: ultima.name });
await filaE.waitFor({ timeout: 20000 });
await filaE.getByRole("button", { name: `Editar la plantilla ${ultima.name}` }).click();
const texto = `Hola {{1}}, retomamos tu cotización desde la pantalla ${stamp}.`;
await page.locator("#tpl-body").fill(texto);
ok("nombre fijo al editar", await page.locator("#tpl-name").isDisabled());
await page.getByRole("button", { name: "Guardar y enviar a revisión" }).click();
const aviso = page.getByText(`Plantilla «${ultima.name}» editada y enviada otra vez a revisión`);
await aviso.waitFor({ timeout: 15000 }).catch(() => {});
ok("aviso de editada en pantalla", await aviso.isVisible());
const tras = await local(ultima.id);
ok("guardada con el texto nuevo y en revisión", tras?.body === texto && tras?.status === "pending", JSON.stringify(tras));

// Limpieza: flujos y plantillas de esta corrida.
await api(`/api/automations/${flow.id}`, { method: "DELETE" });
await api(`/api/automations/${flow2.id}`, { method: "DELETE" });
for (const t of (await api("/api/templates")).json?.templates ?? []) {
  if (t.name.includes(stamp)) await api(`/api/templates/${t.id}`, { method: "DELETE" });
}
await browser.close();
console.log(failures ? `\n✗ ${failures} fallo(s)` : "\n✓ Todo verde");
process.exit(failures ? 1 : 0);
