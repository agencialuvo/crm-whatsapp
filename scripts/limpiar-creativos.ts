/**
 * `pnpm limpiar-creativos` — libera el disco de las miniaturas de anuncios copiadas por el catálogo (spec 040).
 *
 * Con `AD_CREATIVE_LOCAL_COPY` apagado ya no se crean copias nuevas; esto limpia las que quedaron:
 *   1. `meta_ad.creative_asset_id = null` donde apunte a una de esas copias,
 *   2. borra las filas `media_asset` con `payload->>'origen' = 'catalogo'`,
 *   3. borra su archivo en `MEDIA_DIR/<org>/<asset>` si existe.
 * NO toca las imágenes del anuncio de origen (`origen = 'anuncio'`, ligadas a `ad_attribution`), ni nada más.
 *
 * Por defecto SOLO SIMULA (cuenta y suma bytes; no cambia nada). Para borrar de verdad hacen falta DOS banderas:
 *   pnpm limpiar-creativos -- --aplicar --confirmo-borrar
 * Opcional: `--org <organization_id>` limita a una organización.
 *
 * Hazlo con AD_CREATIVE_LOCAL_COPY apagado: encendido, el siguiente sync volvería a descargarlas.
 * Lee `.env` solo si existe y no pisa lo que ya traiga el entorno.
 */
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { adCreativeLocalCopy } from "@/server/attribution/creativo";
import { deleteMediaFile, mediaFilePath } from "@/server/whatsapp/media";

const envPath = path.join(process.cwd(), ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const args = process.argv.slice(2);
const aplicar = args.includes("--aplicar");
const confirmo = args.includes("--confirmo-borrar");
const iOrg = args.indexOf("--org");
const orgFiltro = iOrg >= 0 ? args[iOrg + 1] : undefined;
if (iOrg >= 0 && (!orgFiltro || orgFiltro.startsWith("--"))) {
  console.error("--org necesita un organization_id");
  process.exit(1);
}
if (aplicar && !confirmo) {
  console.error("Borrar exige --aplicar Y --confirmo-borrar. Sin ambas, solo se simula.");
  process.exit(1);
}
const BORRAR = aplicar && confirmo;
const LOTE = 200;

console.log(`Vocero CRM — limpiar-creativos (${BORRAR ? "BORRADO REAL" : "simulación, no cambia nada"})`);
if (adCreativeLocalCopy()) {
  console.log("  ⚠ AD_CREATIVE_LOCAL_COPY está ENCENDIDA: el próximo sync volvería a copiar las miniaturas.");
}

const db = getDb();
const A = schema.mediaAsset;
const filas = await db
  .select({ id: A.id, organizationId: A.organizationId, fileSize: A.fileSize })
  .from(A)
  .where(and(sql`${A.payload}->>'origen' = 'catalogo'`, orgFiltro ? eq(A.organizationId, orgFiltro) : undefined));

let bytes = 0;
let archivos = 0;
const porOrg = new Map<string, number>();
for (const f of filas) {
  porOrg.set(f.organizationId, (porOrg.get(f.organizationId) ?? 0) + 1);
  try {
    const s = await stat(mediaFilePath(f.organizationId, f.id));
    archivos += 1;
    bytes += s.size;
  } catch {
    /* sin archivo en el volumen: solo hay fila */
  }
}

const enAnuncios = filas.length
  ? await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.metaAd)
      .where(inArray(schema.metaAd.creativeAssetId, filas.map((f) => f.id)))
  : [{ n: 0 }];

console.log(`\n  media_asset de catálogo: ${filas.length} fila(s) en ${porOrg.size} organización(es)`);
console.log(`  archivos presentes en MEDIA_DIR: ${archivos} (${(bytes / 1_048_576).toFixed(1)} MB)`);
console.log(`  meta_ad con creative_asset_id a poner en null: ${enAnuncios[0]?.n ?? 0}`);
for (const [org, n] of porOrg) console.log(`    - ${org}: ${n}`);

if (!BORRAR) {
  console.log("\n  Simulación terminada. Para borrar: pnpm limpiar-creativos -- --aplicar --confirmo-borrar");
  process.exit(0);
}

let borradas = 0;
let archivosBorrados = 0;
for (let i = 0; i < filas.length; i += LOTE) {
  const lote = filas.slice(i, i + LOTE);
  const ids = lote.map((f) => f.id);
  // Primero la base (fila y referencia), después el archivo: un archivo huérfano es inofensivo, una fila sin archivo no.
  await db.transaction(async (tx) => {
    await tx.update(schema.metaAd).set({ creativeAssetId: null, updatedAt: new Date() }).where(inArray(schema.metaAd.creativeAssetId, ids));
    await tx.delete(A).where(inArray(A.id, ids));
  });
  borradas += lote.length;
  for (const f of lote) {
    try {
      await deleteMediaFile(f.organizationId, f.id);
      archivosBorrados += 1;
    } catch (e) {
      console.warn(`  ✗ archivo ${f.organizationId}/${f.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
}
console.log(`\n  ✓ ${borradas} fila(s) borradas; ${archivosBorrados} archivo(s) procesados (los que no existían se ignoran).`);
process.exit(0);
