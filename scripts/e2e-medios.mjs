/**
 * Self-test E2E de comportamiento — módulo Medios (biblioteca de imágenes,
 * videos y PDF).
 *
 * Cubre, contra la app real: la subida desde el dispositivo, los límites de
 * peso y formato vigentes desde la spec 048 (JPG/PNG 3 MB, WEBP/AVIF 1,5 MB,
 * MP4 y PDF 16 MB, el tope de WhatsApp; subido por cuerpo directo en flujo), el archivo
 * disfrazado, la inserción por URL (y el bloqueo de direcciones internas), la
 * URL pública con Range y, en el navegador, la cuadrícula, el lightbox y
 * «Copiar URL».
 *
 * Uso: node --env-file=.env scripts/e2e-medios.mjs
 * Requiere: app corriendo (pnpm dev) y BD migrada. Usuario: E2E_EMAIL /
 * E2E_PASSWORD (por defecto e2e@vocero.test, que se registra si no existe).
 * Con WA_MOCK_ENABLED=true se prueba además la descarga real por URL contra
 * el propio servidor; sin él, se comprueba que ese destino queda bloqueado.
 *
 * Corre con R2 APAGADO (el camino local, el de siempre). La subida directa a R2
 * y el CORS se prueban contra el bucket real con `pnpm r2:smoke` (scripts/r2-smoke.ts).
 */
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? process.env.APP_BASE_URL ?? "http://localhost:3000";
const MB = 1024 * 1024;
const MOCKS = process.env.WA_MOCK_ENABLED === "true";

let failures = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
};

/* Archivos de prueba: la firma real de cada formato + relleno. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const relleno = (n, b = 7) => Buffer.alloc(n, b);
const jpg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), relleno(n - 4)]);
const webp = (n) => Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), relleno(n - 12)]);
const avif = (n) => Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif"), relleno(n - 12)]);
const pdf = (n) => Buffer.concat([Buffer.from("%PDF-1.4\n"), relleno(n - 9, 0x20)]);
const mp4 = (n) => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), relleno(n - 12)]);

// E2E_CHANNEL=chrome usa el Chrome instalado (sin descargar el Chromium de Playwright).
const browser = await chromium.launch(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {});
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const req = ctx.request;
const creados = [];

console.log("== Sesión ==");
const email = process.env.E2E_EMAIL ?? "e2e@vocero.test";
const password = process.env.E2E_PASSWORD ?? "password-e2e-123";
let sesion = await req.post(`${BASE}/api/auth/sign-in/email`, { data: { email, password } });
if (!sesion.ok()) {
  sesion = await req.post(`${BASE}/api/auth/sign-up/email`, { data: { email, password, name: "Operador E2E" } });
}
ok("sesión iniciada", sesion.ok(), `status ${sesion.status()}`);
if (!sesion.ok()) {
  await browser.close();
  process.exit(1);
}

const subir = (nombre, mimeType, buffer) =>
  req.post(`${BASE}/api/medios`, { multipart: { file: { name: nombre, mimeType, buffer } } });
const errorDe = async (r) => (await r.json().catch(() => ({}))).error?.code;

console.log("\n== Subida desde el dispositivo ==");
const png = await subir("logo prueba.png", "image/png", PNG_1X1);
ok("PNG válido → 201", png.status() === 201, `status ${png.status()}`);
const medioPng = (await png.json()).medio;
if (medioPng) creados.push(medioPng.id);
ok("devuelve tipo, mime, peso y ruta", medioPng?.tipo === "image" && medioPng?.mime === "image/png" && medioPng?.bytes === PNG_1X1.length && medioPng?.ruta === `/api/medios/${medioPng?.id}/archivo`);

const j3 = await subir("justo.jpg", "image/jpeg", jpg(3 * MB));
ok("JPG de exactamente 3 MB → 201", j3.status() === 201, `status ${j3.status()}`);
if (j3.ok()) creados.push((await j3.json()).medio.id);

console.log("\n== Límites de peso ==");
const r1 = await subir("grande.jpg", "image/jpeg", jpg(3 * MB + 1));
ok("JPG de 3 MB + 1 byte → 413 too_large", r1.status() === 413 && (await errorDe(r1)) === "too_large", `status ${r1.status()}`);
const r2 = await subir("grande.png", "image/png", Buffer.concat([PNG_1X1.subarray(0, 8), relleno(4 * MB)]));
ok("PNG de 4 MB → 413", r2.status() === 413);
const r3 = await subir("moderna.webp", "image/webp", webp(2 * MB));
ok("WEBP de 2 MB → 413 (el límite moderno es 1,5 MB)", r3.status() === 413, `status ${r3.status()}`);
const r4 = await subir("moderna.avif", "image/avif", avif(2 * MB));
ok("AVIF de 2 MB → 413", r4.status() === 413);
const w = await subir("ligera.webp", "image/webp", webp(1.5 * MB));
ok("WEBP de exactamente 1,5 MB → 201", w.status() === 201, `status ${w.status()}`);
if (w.ok()) creados.push((await w.json()).medio.id);
const v1 = await subir("clip.mp4", "video/mp4", mp4(16 * MB));
ok("MP4 de exactamente 16 MB → 201 (el tope de WhatsApp)", v1.status() === 201, `status ${v1.status()}`);
const medioMp4 = v1.ok() ? (await v1.json()).medio : null;
if (medioMp4) creados.push(medioMp4.id);
ok("el MP4 queda como video", medioMp4?.tipo === "video");
const v2 = await subir("pesado.mp4", "video/mp4", mp4(16 * MB + 1));
ok("MP4 de 16 MB + 1 byte → 413 too_large", v2.status() === 413 && (await errorDe(v2)) === "too_large", `status ${v2.status()}`);
const v3 = await subir("enorme.mp4", "video/mp4", mp4(51 * MB));
ok("MP4 de 51 MB por multipart → 413 (también topa el sobre multipart de 50 MB)", v3.status() === 413, `status ${v3.status()}`);

console.log("\n== PDF (documento, hasta 16 MB) ==");
const p1 = await subir("lista de precios ñ.pdf", "application/pdf", pdf(200 * 1024));
ok("PDF válido → 201", p1.status() === 201, `status ${p1.status()}`);
const medioPdf = p1.ok() ? (await p1.json()).medio : null;
if (medioPdf) creados.push(medioPdf.id);
ok("queda como documento application/pdf con su peso exacto", medioPdf?.tipo === "document" && medioPdf?.mime === "application/pdf" && medioPdf?.bytes === 200 * 1024, JSON.stringify(medioPdf));
const p2 = await subir("justo.pdf", "application/pdf", pdf(16 * MB));
ok("PDF de exactamente 16 MB → 201", p2.status() === 201, `status ${p2.status()}`);
if (p2.ok()) creados.push((await p2.json()).medio.id);
const p3 = await subir("pesado.pdf", "application/pdf", pdf(16 * MB + 1));
ok("PDF de 16 MB + 1 byte → 413 too_large", p3.status() === 413 && (await errorDe(p3)) === "too_large", `status ${p3.status()}`);
const p4 = await subir("disfraz.pdf", "application/pdf", Buffer.from("<html><script>alert(1)</script></html>".padEnd(200, " ")));
ok("HTML con nombre .pdf → 422 (se mira el contenido: debe empezar con %PDF-)", p4.status() === 422, `status ${p4.status()}`);

console.log("\n== Cuerpo directo en flujo (el que usa la pantalla; tope 16 MB) ==");
const subirDirecto = (nombre, mimeType, buffer, query = "") =>
  req.post(`${BASE}/api/medios${query}`, {
    headers: { "Content-Type": mimeType, "X-Nombre": encodeURIComponent(nombre) },
    data: buffer,
  });
const d1 = await subirDirecto("clip grande ñ.mp4", "video/mp4", mp4(10 * MB));
ok("MP4 de 10 MB por cuerpo directo → 201", d1.status() === 201, `status ${d1.status()}`);
const medioGrande = d1.ok() ? (await d1.json()).medio : null;
if (medioGrande) creados.push(medioGrande.id);
ok("conserva el peso exacto y el nombre con tilde", medioGrande?.bytes === 10 * MB && medioGrande?.nombre === "clip grande ñ", JSON.stringify(medioGrande));
if (medioGrande) {
  const rango = await req.get(`${BASE}${medioGrande.ruta}`, { headers: { Range: "bytes=0-15" } });
  ok("el archivo en disco se sirve con Range (206, 16 bytes)", rango.status() === 206 && (await rango.body()).length === 16, `status ${rango.status()}`);
}
const d1b = await subirDirecto("pesado directo.mp4", "video/mp4", mp4(16 * MB + 1));
ok("MP4 de 16 MB + 1 byte por cuerpo directo → 413 (antes se admitían hasta 5 GB)", d1b.status() === 413, `status ${d1b.status()}`);
const d1c = await subirDirecto("manual.pdf", "application/pdf", pdf(1 * MB));
ok("PDF por cuerpo directo → 201 como documento", d1c.status() === 201, `status ${d1c.status()}`);
const medioPdf2 = d1c.ok() ? (await d1c.json()).medio : null;
if (medioPdf2) creados.push(medioPdf2.id);
ok("un PDF donde solo se aceptan imágenes → 422", (await subirDirecto("manual.pdf", "application/pdf", pdf(1 * MB), "?tipo=image")).status() === 422);
const d2 = await subirDirecto("grande.jpg", "image/jpeg", jpg(3 * MB + 1));
ok("JPG de 3 MB + 1 byte por cuerpo directo → 413", d2.status() === 413, `status ${d2.status()}`);
const d3 = await subirDirecto("disfraz.mp4", "video/mp4", Buffer.from("<html>".padEnd(200, " ")));
ok("HTML con nombre .mp4 por cuerpo directo → 422", d3.status() === 422, `status ${d3.status()}`);
const d4 = await subirDirecto("clip.mp4", "video/mp4", mp4(1 * MB), "?tipo=image");
ok("un video donde solo se aceptan imágenes → 422", d4.status() === 422, `status ${d4.status()}`);
const d5 = await subirDirecto("vacio.mp4", "video/mp4", Buffer.alloc(0));
ok("cuerpo vacío → 422", d5.status() === 422, `status ${d5.status()}`);

console.log("\n== Formatos y archivos disfrazados ==");
const f1 = await subir("dibujo.svg", "image/svg+xml", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"));
ok("SVG → 422 unsupported_type", f1.status() === 422 && (await errorDe(f1)) === "unsupported_type", `status ${f1.status()}`);
const f2 = await subir("animado.gif", "image/gif", Buffer.concat([Buffer.from("GIF89a"), relleno(100)]));
ok("GIF → 422", f2.status() === 422);
const f3 = await subir("disfraz.jpg", "image/jpeg", Buffer.from("<html><script>alert(document.cookie)</script></html>".padEnd(200, " ")));
ok("HTML con nombre .jpg y Content-Type image/jpeg → 422 (se mira el contenido)", f3.status() === 422, `status ${f3.status()}`);
const f4 = await subir("vacio.jpg", "image/jpeg", Buffer.alloc(0));
ok("archivo vacío → 422", f4.status() === 422);
const f5 = await req.post(`${BASE}/api/medios`, { multipart: { otro: "x" } });
ok("sin archivo → 422", f5.status() === 422);

console.log("\n== Por URL ==");
const u0 = await req.post(`${BASE}/api/medios/url`, { data: { url: "esto no es un enlace" } });
ok("texto que no es enlace → 422 invalid_url", u0.status() === 422 && (await errorDe(u0)) === "invalid_url");
const u1 = await req.post(`${BASE}/api/medios/url`, { data: { url: "file:///etc/passwd" } });
ok("file:// → 422", u1.status() === 422);
const u2 = await req.post(`${BASE}/api/medios/url`, { data: { url: "http://169.254.169.254/latest/meta-data/" } });
ok("metadatos de la nube (169.254.169.254) → bloqueado", u2.status() === 422 && (await errorDe(u2)) === "blocked", `status ${u2.status()} ${await errorDe(u2)}`);
const u3 = await req.post(`${BASE}/api/medios/url`, { data: { url: "http://[::1]/x.png" } });
ok("::1 → bloqueado", u3.status() === 422 && (await errorDe(u3)) === "blocked");
if (medioPng && MOCKS) {
  const u4 = await req.post(`${BASE}/api/medios/url`, { data: { url: `${BASE}${medioPng.ruta}` } });
  ok("(mocks) descarga real por URL → 201", u4.status() === 201, `status ${u4.status()}`);
  const m = u4.ok() ? (await u4.json()).medio : null;
  if (m) creados.push(m.id);
  ok("(mocks) queda como origen «url» con el enlace guardado", m?.origen === "url" && m?.urlOrigen === `${BASE}${medioPng.ruta}`);
} else if (medioPng) {
  const u4 = await req.post(`${BASE}/api/medios/url`, { data: { url: `${BASE}${medioPng.ruta}` } });
  ok("el propio servidor (localhost) queda bloqueado sin mocks (SSRF)", u4.status() === 422 && (await errorDe(u4)) === "blocked", `status ${u4.status()}`);
}

console.log("\n== Archivo público (lo que entrega «Copiar URL») ==");
if (medioMp4) {
  // Sin cookies: es lo que verá quien reciba el enlace.
  const r = await fetch(`${BASE}${medioMp4.ruta}`);
  ok("sin sesión se puede abrir → 200", r.status === 200, `status ${r.status}`);
  ok("Content-Type video/mp4 y nosniff", r.headers.get("content-type") === "video/mp4" && r.headers.get("x-content-type-options") === "nosniff");
  ok("CSP restrictiva y Accept-Ranges", /default-src 'none'/.test(r.headers.get("content-security-policy") ?? "") && r.headers.get("accept-ranges") === "bytes");
  ok("el peso coincide", (await r.arrayBuffer()).byteLength === medioMp4.bytes);
  const rg = await fetch(`${BASE}${medioMp4.ruta}`, { headers: { range: "bytes=0-99" } });
  ok("Range → 206 con 100 bytes", rg.status === 206 && (await rg.arrayBuffer()).byteLength === 100 && rg.headers.get("content-range") === `bytes 0-99/${medioMp4.bytes}`);
  const rf = await fetch(`${BASE}${medioMp4.ruta}`, { headers: { range: "bytes=-10" } });
  ok("Range de cola (bytes=-10) → 206", rf.status === 206 && (await rf.arrayBuffer()).byteLength === 10);
  const rx = await fetch(`${BASE}${medioMp4.ruta}`, { headers: { range: `bytes=${medioMp4.bytes + 5}-` } });
  ok("Range fuera del archivo → 416", rx.status === 416);
}
if (medioPdf) {
  const r = await fetch(`${BASE}${medioPdf.ruta}`);
  ok("el PDF sin sesión → 200 con Content-Type application/pdf y nosniff", r.status === 200 && r.headers.get("content-type") === "application/pdf" && r.headers.get("x-content-type-options") === "nosniff", `status ${r.status} ${r.headers.get("content-type")}`);
  ok("el peso del PDF coincide", (await r.arrayBuffer()).byteLength === medioPdf.bytes);
}
const inex = await fetch(`${BASE}/api/medios/med_aaaaaaaaaaaaaaaaaaaa/archivo`);
ok("id que no existe → 404", inex.status === 404);
const malo = await fetch(`${BASE}/api/medios/..%2F..%2Fetc/archivo`);
ok("id con forma inválida → 404", malo.status === 404);
const lista = await fetch(`${BASE}/api/medios`);
ok("listar medios SIN sesión → 401", lista.status === 401);
const sinSesionSube = await fetch(`${BASE}/api/medios`, { method: "POST", body: new FormData() });
ok("subir SIN sesión → 401", sinSesionSube.status === 401);

console.log("\n== Listado y filtros ==");
const todos = (await (await req.get(`${BASE}/api/medios`)).json()).medios ?? [];
ok("lo subido aparece en el listado, lo más nuevo primero", todos.length >= creados.length && creados.every((id) => todos.some((m) => m.id === id)));
const imgs = (await (await req.get(`${BASE}/api/medios?tipo=image`)).json()).medios ?? [];
const vids = (await (await req.get(`${BASE}/api/medios?tipo=video`)).json()).medios ?? [];
ok("?tipo=image solo trae imágenes y ?tipo=video solo videos", imgs.length > 0 && imgs.every((m) => m.tipo === "image") && vids.every((m) => m.tipo === "video") && vids.some((m) => m.id === medioMp4?.id));
const docs = (await (await req.get(`${BASE}/api/medios?tipo=document`)).json()).medios ?? [];
ok("?tipo=document solo trae PDF", docs.length > 0 && docs.every((m) => m.tipo === "document") && docs.some((m) => m.id === medioPdf?.id));
ok("?tipo inválido → 422", (await req.get(`${BASE}/api/medios?tipo=audio`)).status() === 422);

console.log("\n== Interfaz (navegador) ==");
const page = await ctx.newPage();
const errores = [];
page.on("pageerror", (e) => errores.push(e.message));
await page.goto(`${BASE}/medios`);
await page.getByRole("heading", { name: "Medios" }).waitFor({ timeout: 60000 });
ok("la página abre y el menú tiene «Medios»", (await page.getByRole("link", { name: "Medios" }).count()) > 0);
await page.getByRole("button", { name: /^Ver logo prueba/ }).first().waitFor({ timeout: 20000 });
ok("la cuadrícula muestra los archivos subidos", (await page.getByRole("button", { name: /^Ver / }).count()) >= 3);
const peso = await page.getByRole("button", { name: /^Ver logo prueba/ }).first().textContent();
ok("cada tarjeta dice su formato y peso", /PNG/.test(peso ?? ""), peso ?? "");

await page.getByRole("button", { name: "Videos", exact: true }).click();
ok("el filtro «Videos» deja solo los videos", (await page.getByRole("button", { name: /^Ver logo prueba/ }).count()) === 0 && (await page.getByRole("button", { name: /^Ver clip/ }).count()) > 0);
await page.getByRole("button", { name: "Todos", exact: true }).click();
await page.getByLabel("Buscar por nombre").fill("logo prueba");
ok("la búsqueda filtra por nombre", (await page.getByRole("button", { name: /^Ver clip/ }).count()) === 0);
await page.getByLabel("Buscar por nombre").fill("zzz-nada");
ok("sin coincidencias se explica", await page.getByText("Nada coincide").isVisible());
await page.getByLabel("Buscar por nombre").fill("");

// Lightbox
await page.getByRole("button", { name: /^Ver logo prueba/ }).first().click();
const caja = page.getByRole("dialog", { name: /Vista ampliada/ });
await caja.waitFor();
ok("clic en la imagen abre la vista ampliada", await caja.isVisible());
ok("muestra la imagen a tamaño completo", await caja.locator("img").first().isVisible());
const urlCampo = await caja.getByLabel("URL del archivo").inputValue();
ok("la URL del campo es absoluta y apunta al archivo", urlCampo === `${new URL(page.url()).origin}${medioPng.ruta}`, urlCampo);
await caja.getByRole("button", { name: "Copiar URL" }).click();
await caja.getByText("¡Copiada!").waitFor({ timeout: 5000 }).catch(() => {});
ok("«Copiar URL» da confirmación", await caja.getByText("¡Copiada!").isVisible());
const portapapeles = await page.evaluate(() => navigator.clipboard.readText());
ok("la URL quedó en el portapapeles", portapapeles === urlCampo, portapapeles);
// Lo más nuevo va primero y «logo prueba» fue lo primero que se subió: está al
// final de la lista, así que el vecino es el ANTERIOR (←).
await page.keyboard.press("ArrowLeft");
await page.waitForFunction((u) => document.querySelector('input[aria-label="URL del archivo"]')?.value !== u, urlCampo, { timeout: 5000 }).catch(() => {});
ok("la flecha ← pasa al archivo vecino", (await caja.getByLabel("URL del archivo").inputValue()) !== urlCampo);
await page.keyboard.press("ArrowRight");
await page.waitForFunction((u) => document.querySelector('input[aria-label="URL del archivo"]')?.value === u, urlCampo, { timeout: 5000 }).catch(() => {});
ok("la flecha → vuelve", (await caja.getByLabel("URL del archivo").inputValue()) === urlCampo);
await page.keyboard.press("Escape");
ok("Escape cierra la vista", (await page.getByRole("dialog", { name: /Vista ampliada/ }).count()) === 0);

// Lightbox de video
await page.getByRole("button", { name: /^Ver clip/ }).first().click();
const caja2 = page.getByRole("dialog", { name: /Vista ampliada/ });
await caja2.waitFor();
ok("un video se abre con su reproductor", (await caja2.locator("video[controls]").count()) === 1);
await caja2.getByRole("button", { name: "Cerrar" }).click();
ok("la X cierra la vista", (await page.getByRole("dialog", { name: /Vista ampliada/ }).count()) === 0);

// Copiar desde la tarjeta
await page.getByRole("button", { name: /^Copiar URL de logo prueba/ }).first().click();
ok("«Copiar URL» desde la tarjeta también copia", (await page.evaluate(() => navigator.clipboard.readText())) === urlCampo);

// Avisos de subida
const grande = { name: "demasiado-pesada.jpg", mimeType: "image/jpeg", buffer: jpg(3 * MB + 1) };
const raro = { name: "notas.txt", mimeType: "text/plain", buffer: Buffer.from("hola") };
await page.locator('input[type="file"]').setInputFiles([grande, raro]);
const alertas = page.getByRole("alert");
await alertas.first().waitFor();
const textos = (await alertas.allTextContents()).join(" | ");
ok("un archivo pesado se rechaza en pantalla, con su peso y el máximo", /demasiado-pesada\.jpg.*3,0 MB.*JPG/.test(textos) || /demasiado-pesada\.jpg.*pesa/.test(textos), textos);
ok("un formato no válido se rechaza en pantalla", /notas\.txt.*no es un formato válido/.test(textos), textos);
const antes = (await (await req.get(`${BASE}/api/medios`)).json()).medios.length;
ok("lo rechazado en pantalla ni siquiera se envía", antes === todos.length);

// Un PDF es un formato válido: se sube por la pantalla y aparece como documento
await page.getByLabel("Descartar aviso").first().click();
await page.locator('input[type="file"]').setInputFiles({ name: "catalogo-ui.pdf", mimeType: "application/pdf", buffer: pdf(100 * 1024) });
await page.getByRole("button", { name: /^Ver catalogo-ui/ }).waitFor({ timeout: 15000 });
ok("subir un PDF desde la interfaz agrega su tarjeta", true);
await page.getByRole("button", { name: "PDF", exact: true }).click();
ok("el filtro «PDF» deja solo los documentos", (await page.getByRole("button", { name: /^Ver clip/ }).count()) === 0 && (await page.getByRole("button", { name: /^Ver catalogo-ui/ }).count()) > 0);
await page.getByRole("button", { name: "Todos", exact: true }).click();
const docsUi = (await (await req.get(`${BASE}/api/medios?tipo=document`)).json()).medios ?? [];
creados.push(...docsUi.filter((m) => m.nombre === "catalogo-ui").map((m) => m.id));

// Subida válida por la UI
await page.getByLabel("Descartar aviso").first().click();
await page.locator('input[type="file"]').setInputFiles({ name: "desde-la-interfaz.png", mimeType: "image/png", buffer: PNG_1X1 });
await page.getByRole("button", { name: /^Ver desde-la-interfaz/ }).waitFor({ timeout: 15000 });
ok("subir desde la interfaz agrega la tarjeta sin recargar", true);

// URL por la UI: bloqueada
await page.getByRole("button", { name: "Insertar desde URL" }).click();
await page.getByLabel("Enlace del archivo").fill("http://169.254.169.254/latest/meta-data/");
await page.getByRole("button", { name: "Insertar", exact: true }).click();
await page.getByRole("dialog").getByRole("alert").waitFor();
ok("un enlace interno se rechaza con un aviso en el diálogo", /dirección interna/.test(await page.getByRole("dialog").getByRole("alert").textContent()));
await page.getByRole("dialog").getByRole("button", { name: "Cerrar" }).click();

// Borrar desde el lightbox
await page.getByRole("button", { name: /^Ver desde-la-interfaz/ }).click();
await page.getByRole("dialog", { name: /Vista ampliada/ }).getByRole("button", { name: "Borrar" }).click();
await page.getByRole("dialog", { name: "Borrar archivo" }).getByRole("button", { name: "Borrar" }).click();
await page.getByRole("button", { name: /^Ver desde-la-interfaz/ }).waitFor({ state: "detached", timeout: 10000 });
ok("borrar desde la vista ampliada quita la tarjeta", true);
ok("sin errores de JavaScript en la página", errores.length === 0, errores.join("; "));

console.log("\n== Borrado ==");
const idsUi = ((await (await req.get(`${BASE}/api/medios`)).json()).medios ?? []).filter((m) => m.nombre === "desde-la-interfaz").map((m) => m.id);
ok("lo borrado por la UI ya no está en el servidor", idsUi.length === 0);
for (const id of creados) {
  const d = await req.delete(`${BASE}/api/medios/${id}`);
  if (!d.ok()) ok(`borrar ${id}`, false, `status ${d.status()}`);
}
if (medioPng) {
  const despues = await fetch(`${BASE}${medioPng.ruta}`);
  ok("borrado el medio, su URL pública deja de funcionar → 404", despues.status === 404, `status ${despues.status}`);
  const otra = await req.delete(`${BASE}/api/medios/${medioPng.id}`);
  ok("borrar dos veces → 404", otra.status() === 404);
}
ok("borrar un id con forma inválida → 404", (await req.delete(`${BASE}/api/medios/xyz`)).status() === 404);

await browser.close();
console.log(failures === 0 ? "\n✅ Medios: todo en verde" : `\n❌ Medios: ${failures} comprobación(es) fallaron`);
process.exit(failures === 0 ? 0 : 1);
