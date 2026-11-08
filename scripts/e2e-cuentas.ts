/**
 * Cuentas de prueba para los E2E de HTTP: `pnpm e2e:cuentas crear` y `pnpm e2e:cuentas borrar`.
 *
 * El registro público ya no abre sesión (hay que verificar el correo con un código que llega por
 * email) y `pnpm crear-usuario` une las cuentas nuevas a la organización existente. Un E2E que prueba el
 * aislamiento entre negocios necesita dos PROPIETARIOS de negocios distintos con contraseña conocida:
 * esto los crea por backend, con las mismas piezas que el alta real (`completeSignup` → negocio propio).
 *
 *   crear   Crea las dos cuentas de prueba (idempotente: las que ya existen no se tocan).
 *   borrar  Borra esas cuentas, sus negocios y las cuentas de equipo que el E2E creó. El borrado en
 *           cascada se lleva todo lo del negocio.
 *
 * Solo toca correos `automations-…@vocero.test`: no puede borrar cuentas reales.
 * Se bundlea con esbuild (alias @ → ./src), igual que `crear-usuario`.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { hashPassword } from "better-auth/crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { PG_CONNECTION_OPTIONS } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { completeSignup } from "@/server/auth/signup-verification";

const PASSWORD = "password-e2e-123";
const OWNERS = [
  { email: "automations-e2e@vocero.test", name: "Dueño A" },
  { email: "automations-e2e-b@vocero.test", name: "Dueño B" },
];
/** Lo único que se puede borrar: los dueños de arriba y los miembros que crea el E2E. */
const SAFE_PATTERN = "automations-%@vocero.test";

function loadEnvVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    const line = readFileSync(".env", "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}

const cmd = process.argv[2];
if (cmd !== "crear" && cmd !== "borrar") {
  console.error("Uso: pnpm e2e:cuentas crear | borrar");
  process.exit(1);
}
const url = loadEnvVar("DATABASE_URL");
if (!url) {
  console.error("DATABASE_URL no está definida (ni en el entorno ni en .env).");
  process.exit(1);
}

const sql = postgres(url, { max: 1, ...PG_CONNECTION_OPTIONS });
const db = drizzle(sql, { schema });

try {
  if (cmd === "crear") {
    for (const o of OWNERS) {
      const [existing] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, o.email)).limit(1);
      if (existing) {
        console.log(`  ya existe  ${o.email}`);
        continue;
      }
      const id = randomBytes(16).toString("hex");
      await db.insert(schema.user).values({ id, name: o.name, email: o.email, emailVerified: false });
      await db.insert(schema.account).values({
        id: randomBytes(16).toString("hex"),
        accountId: id,
        providerId: "credential",
        userId: id,
        password: await hashPassword(PASSWORD),
      });
      // Verifica el correo y crea SU PROPIO negocio como propietario (lo mismo que cierra un alta real).
      await completeSignup({ id, name: o.name, email: o.email });
      console.log(`  creada     ${o.email}`);
    }
  } else {
    const users = await db.select({ id: schema.user.id, email: schema.user.email }).from(schema.user).where(like(schema.user.email, SAFE_PATTERN));
    const ids = users.map((u) => u.id);
    if (ids.length) {
      // Los negocios de los dueños (no los de miembros, que pertenecen al negocio del dueño).
      const owned = await db
        .select({ orgId: schema.member.organizationId })
        .from(schema.member)
        .where(and(inArray(schema.member.userId, ids), eq(schema.member.role, "owner")));
      const orgIds = [...new Set(owned.map((m) => m.orgId))];
      if (orgIds.length) await db.delete(schema.organization).where(inArray(schema.organization.id, orgIds));
      await db.delete(schema.user).where(inArray(schema.user.id, ids));
    }
    console.log(`  borradas ${ids.length} cuenta(s) de prueba y sus negocios`);
  }
} finally {
  await sql.end();
}
// `completeSignup` abre su propio pool (getDb) y lo deja vivo: sin esto el proceso no termina.
process.exit(0);
