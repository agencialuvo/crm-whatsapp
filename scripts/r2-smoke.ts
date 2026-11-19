/**
 * `pnpm r2:smoke` — prueba de humo de Cloudflare R2 (spec 048) contra el bucket REAL.
 *
 * Comprueba, en orden: put → head (tamaño y tipo) → signRead + fetch → signUpload + PUT por fetch (tipo y tamaño
 * firmados) → rechazo de un cuerpo de otro tamaño → preflight CORS con `Origin` del CRM → delete → head = null.
 * `pnpm doctor` solo hace un HEAD de lectura; esto prueba ESCRITURA, firmas y CORS.
 *
 * Todo vive bajo `__smoke__/<timestamp>/` y se borra al final aunque algo falle a mitad (bloque `finally`). Jamás
 * imprime secretos. Sale con 0 si todo pasó, 1 si algo falló y 2 si R2 no está configurado.
 *
 * Cómo correrlo SIN pasar credenciales por ningún chat:
 *   - En local: pon R2_STORAGE=on, R2_ENDPOINT, R2_BUCKET_NAME, R2_ACCESS_KEY_ID y R2_SECRET_ACCESS_KEY en tu `.env`
 *     (no se commitea) y corre `pnpm r2:smoke`. Lee `.env` solo si existe y no pisa lo que ya traiga el entorno.
 *   - En Render: Shell del servicio con las variables de producción, si la imagen trae pnpm; si no, usa el `.env` local.
 *   - Otro origen para el CORS: `pnpm r2:smoke -- https://otro.dominio` o `R2_SMOKE_ORIGIN=https://otro.dominio`.
 *     Por defecto usa `APP_BASE_URL` y, si no hay, https://app.sistemalia.com.
 *
 * Se bundlea con esbuild (alias @ → ./src), igual que `pnpm doctor`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { r2Config } from "@/server/storage/config";
import { objectStore } from "@/server/storage";

const envPath = path.join(process.cwd(), ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

let fallos = 0;
const ok = (nombre: string, cond: boolean, extra = ""): boolean => {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${extra ? ` — ${extra}` : ""}`);
  }
  return cond;
};
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

console.log("Vocero CRM — r2:smoke");

const cfg = r2Config();
const store = objectStore();
if (!cfg || !store) {
  console.log(
    "\n  R2 no está configurado: faltan R2_STORAGE=on o alguna de R2_ENDPOINT, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (o siguen en REEMPLAZA_...).\n  Guía: docs/almacenamiento-r2.md"
  );
  process.exit(2);
}

const origen = (process.argv.slice(2).find((a) => a.startsWith("http")) ?? process.env.R2_SMOKE_ORIGIN ?? process.env.APP_BASE_URL ?? "https://app.sistemalia.com")
  .trim()
  .replace(/\/+$/, "");
const prefijo = `__smoke__/${new Date().toISOString().replace(/[:.]/g, "-")}/`;
const claves: string[] = [];
const clave = (nombre: string): string => {
  const k = `${prefijo}${nombre}`;
  claves.push(k);
  return k;
};

console.log(`  bucket: ${cfg.bucket} · prefijo temporal: ${prefijo} · origen CORS: ${origen}`);

try {
  console.log("\nEscritura y lectura");
  const cuerpo = Buffer.from("vocero r2 smoke ".repeat(8));
  const kA = clave("a.txt");
  try {
    await store.put(kA, cuerpo, "text/plain");
    ok("put (escribe un objeto: el token tiene permiso de escritura)", true);
  } catch (e) {
    ok("put (escribe un objeto: el token tiene permiso de escritura)", false, msg(e));
  }

  const h = await store.head(kA).catch((e: unknown) => {
    ok("head", false, msg(e));
    return undefined;
  });
  if (h !== undefined) {
    ok("head devuelve el tamaño exacto y el tipo", h !== null && h.size === cuerpo.length && (h.contentType ?? "").startsWith("text/plain"), JSON.stringify(h));
  }

  try {
    const url = await store.signRead(kA);
    const r = await fetch(url);
    const leido = Buffer.from(await r.arrayBuffer());
    ok("signRead + fetch → 200 con los mismos bytes", r.status === 200 && leido.equals(cuerpo), `status ${r.status}`);
  } catch (e) {
    ok("signRead + fetch", false, msg(e));
  }

  console.log("\nSubida directa firmada (lo que hace el navegador)");
  const kB = clave("b.png");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  let urlSubida: string | null = null;
  try {
    const firmada = await store.signUpload(kB, { contentType: "image/png", contentLength: png.length });
    urlSubida = firmada.url;
    const r = await fetch(firmada.url, { method: "PUT", headers: firmada.headers, body: png });
    ok("signUpload + PUT por fetch → 200", r.ok, `status ${r.status}`);
    const hb = await store.head(kB);
    ok("el objeto subido existe con su tamaño y tipo", hb !== null && hb.size === png.length && hb.contentType === "image/png", JSON.stringify(hb));
  } catch (e) {
    ok("signUpload + PUT por fetch", false, msg(e));
  }

  if (urlSubida) {
    try {
      const kC = clave("c.png");
      const otra = await store.signUpload(kC, { contentType: "image/png", contentLength: png.length });
      const r = await fetch(otra.url, { method: "PUT", headers: otra.headers, body: Buffer.concat([png, Buffer.from("extra")]) });
      ok("un cuerpo de OTRO tamaño que el firmado se rechaza (4xx)", r.status >= 400 && r.status < 500, `status ${r.status}`);
    } catch (e) {
      ok("un cuerpo de otro tamaño se rechaza", false, msg(e));
    }

    console.log("\nCORS (preflight del navegador)");
    try {
      const r = await fetch(urlSubida, {
        method: "OPTIONS",
        headers: {
          Origin: origen,
          "Access-Control-Request-Method": "PUT",
          "Access-Control-Request-Headers": "content-type",
        },
      });
      const permitido = r.headers.get("access-control-allow-origin");
      const metodos = r.headers.get("access-control-allow-methods") ?? "";
      ok(`preflight desde ${origen} → ${r.status} con Access-Control-Allow-Origin`, r.status >= 200 && r.status < 300 && (permitido === origen || permitido === "*"), `status ${r.status}, allow-origin: ${permitido ?? "(ausente)"}`);
      ok("el CORS permite el método PUT", /\bPUT\b/i.test(metodos) || permitido === "*", `allow-methods: ${metodos || "(ausente)"}`);
      if (permitido === "*") console.log("  ⚠ el CORS usa «*»: funciona, pero conviene limitarlo a tu dominio (docs/almacenamiento-r2.md)");
    } catch (e) {
      ok("preflight CORS", false, msg(e));
    }
  }
} catch (e) {
  ok("la prueba no debía lanzar", false, msg(e));
} finally {
  console.log("\nLimpieza");
  let limpio = true;
  for (const k of claves) {
    try {
      await store.delete(k);
    } catch (e) {
      limpio = false;
      console.log(`  ⚠ no se pudo borrar ${k}: ${msg(e)} (bórralo a mano en Cloudflare: prefijo ${prefijo})`);
    }
  }
  let restos = 0;
  for (const k of claves) {
    try {
      if ((await store.head(k)) !== null) restos++;
    } catch {
      /* sin lectura no se puede confirmar */
    }
  }
  ok("delete → head devuelve null para todo lo creado", limpio && restos === 0, restos ? `${restos} objeto(s) siguen ahí` : "");
}

console.log(fallos === 0 ? "\n✅ R2: put, firmas, subida directa y CORS en verde" : `\n❌ R2: ${fallos} comprobación(es) fallaron`);
process.exit(fallos === 0 ? 0 : 1);
