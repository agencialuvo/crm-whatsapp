/**
 * CLI: `pnpm seed:platform`. Carga categorías de sector y el plan por defecto.
 * Idempotente. En producción lo hace solo el arranque del servidor.
 * Se bundlea con esbuild (alias @ → ./src), igual que el seed demo.
 */
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { PG_CONNECTION_OPTIONS } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { seedPlatformCatalog } from "@/server/seed/platform-catalog";

function leerVar(nombre: string): string | undefined {
  if (process.env[nombre]) return process.env[nombre];
  try {
    const linea = readFileSync(".env", "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${nombre}=`));
    return linea?.slice(nombre.length + 1).trim();
  } catch {
    return undefined;
  }
}

const url = leerVar("DATABASE_URL");
if (!url) {
  console.error("[seed] DATABASE_URL no está definida");
  process.exit(1);
}
const sql = postgres(url, { max: 1, ...PG_CONNECTION_OPTIONS });
const r = await seedPlatformCatalog(drizzle(sql, { schema }));
console.log(`[seed] categorías nuevas: ${r.categories} · planes nuevos: ${r.plans}`);
await sql.end();
