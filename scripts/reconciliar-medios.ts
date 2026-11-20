/**
 * `pnpm reconciliar-medios` — busca (y, si se pide, borra) los archivos HUÉRFANOS de Medios en R2 y en `MEDIA_DIR`
 * (Hallazgo H). Un huérfano es un archivo cuyo id no existe en `media_asset` ni en `media_library_item`, o un temporal
 * `.part` / `.dedup` abandonado. Detalle del criterio y de las garantías: `src/server/medios/reconciliar.ts`.
 *
 * Por defecto SOLO INFORMA (no cambia nada). Para borrar de verdad hacen falta DOS banderas:
 *   pnpm reconciliar-medios -- --aplicar --confirmo-borrar
 *
 * Opciones:
 *   --edad-horas N     solo se consideran archivos de más de N horas (por defecto 24; nunca menos de 1)
 *   --max-borrar N     tope de huérfanos por corrida (por defecto 200)
 *   --max-escaneo N    objetos / archivos que se miran como máximo (por defecto 20000)
 *   --filas [N]        además, lista (sin tocar nada) las filas que apuntan a un archivo que ya no está; revisa hasta N (200)
 *
 * Seguridad: lo reciente (por defecto < 24 h) no se toca; la base se consulta después de listar y otra vez antes de
 * borrar; nunca borra filas ni el icono de la marca; y si la base parece no ser la de este bucket, se frena.
 * Lee `.env` solo si existe y no pisa lo que ya traiga el entorno. Sale con 0 si terminó bien y 1 si hubo errores.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { filasSinArchivo, reconciliarMedios } from "@/server/medios/reconciliar";

const envPath = path.join(process.cwd(), ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const args = process.argv.slice(2);
const valor = (nombre: string): string | undefined => {
  const i = args.indexOf(nombre);
  return i >= 0 ? args[i + 1] : undefined;
};
const numero = (nombre: string, def: number, min = 1): number => {
  const v = valor(nombre);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) {
    console.error(`${nombre} necesita un número ≥ ${min}`);
    process.exit(1);
  }
  return n;
};

const aplicar = args.includes("--aplicar");
const confirmo = args.includes("--confirmo-borrar");
if (aplicar && !confirmo) {
  console.error("Borrar exige --aplicar Y --confirmo-borrar. Sin ambas, solo se informa.");
  process.exit(1);
}
const BORRAR = aplicar && confirmo;
const edadHoras = numero("--edad-horas", 24, 1);
const maxBorrar = numero("--max-borrar", 200);
const maxEscaneo = numero("--max-escaneo", 20_000);

const mb = (b: number) => `${(b / 1_048_576).toFixed(1)} MB`;
const horas = (ms: number) => `${Math.round(ms / 3_600_000)} h`;

console.log(`Vocero CRM — reconciliar-medios (${BORRAR ? "BORRADO REAL" : "informe, no cambia nada"})`);
const r = await reconciliarMedios({ aplicar: BORRAR, edadMinimaMs: edadHoras * 3_600_000, maxBorrar, maxEscaneo });

console.log(`\n  escaneados: ${r.escaneados.r2} objeto(s) en R2, ${r.escaneados.disco} archivo(s) en disco`);
console.log(`  protegidos: ${r.protegidos.recientes} reciente(s) (< ${edadHoras} h), ${r.protegidos.favicon} icono(s) de marca${r.protegidos.reaparecidos ? `, ${r.protegidos.reaparecidos} que reaparecieron en la base` : ""}`);
console.log(`  huérfanos ${BORRAR ? "a borrar" : "encontrados"}: ${r.huerfanos.length}${r.truncado ? " (hay más: tope o límite de escaneo alcanzado; vuelve a correrlo)" : ""} — ${mb(r.bytes)}`);
for (const h of r.huerfanos.slice(0, 50)) console.log(`    - [${h.origen}] ${h.ubicacion}  (${mb(h.bytes)}, ${horas(h.edadMs)}${h.motivo === "temporal" ? ", temporal abandonado" : ""})`);
if (r.huerfanos.length > 50) console.log(`    … y ${r.huerfanos.length - 50} más`);

let codigo = 0;
if (r.abortado) {
  console.error(`\n  ✗ FRENADO: ${r.abortado}`);
  codigo = 1;
} else if (BORRAR) {
  console.log(`\n  ✓ ${r.borrados} borrado(s)${r.fallidos ? `; ✗ ${r.fallidos} no se pudieron borrar` : ""}`);
  if (r.fallidos) codigo = 1;
} else if (r.huerfanos.length > 0) {
  console.log("\n  Informe terminado. Para borrar: pnpm reconciliar-medios -- --aplicar --confirmo-borrar");
}

if (args.includes("--filas")) {
  const n = Number(valor("--filas"));
  const sin = await filasSinArchivo({ limite: Number.isFinite(n) && n > 0 ? n : 200 });
  console.log(`\n  filas cuyo archivo ya no está (solo se informa, no se borra nada): ${sin.length}`);
  for (const f of sin.slice(0, 50)) console.log(`    - ${f.tipo} ${f.id} (${f.organizationId}, ${f.donde})`);
}
process.exit(codigo);
