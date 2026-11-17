/**
 * Quién es Super Admin (operador de la PLATAFORMA): `pnpm superadmin grant|revoke|list`.
 *
 * La bandera `user.is_super_admin` se concede SOLO por backend, con este comando: no existe pantalla para
 * otorgarla y Better Auth no la expone, así que nadie puede auto-promoverse por HTTP. Cada concesión o
 * revocación deja una fila en `super_admin_audit`.
 *
 *   pnpm superadmin grant correo@ejemplo.com    Da la bandera a una cuenta que ya existe.
 *   pnpm superadmin revoke correo@ejemplo.com   La quita (surte efecto en la siguiente petición).
 *   pnpm superadmin list                        Lista a los Super Admin y si tienen 2FA.
 *
 * El panel exige además verificación en dos pasos: activa el 2FA de la cuenta en Mi perfil ANTES de concederla
 * (una cuenta sin organización no puede activarlo desde la app).
 *
 * Se bundlea con esbuild (alias @ → ./src), igual que `crear-usuario`.
 */
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { PG_CONNECTION_OPTIONS } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import * as schema from "@/lib/db/schema";

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

function fail(message: string): never {
  console.error(`[superadmin] ${message}`);
  process.exit(1);
}

const [command, emailArg] = process.argv.slice(2);
if (!command || !["grant", "revoke", "list"].includes(command)) {
  fail("Uso: pnpm superadmin grant|revoke <correo>  ·  pnpm superadmin list");
}
if (command !== "list" && !emailArg) fail(`Falta el correo: pnpm superadmin ${command} correo@ejemplo.com`);

const url = loadEnvVar("DATABASE_URL");
if (!url) fail("DATABASE_URL no está definida (ni en el entorno ni en .env).");

const sql = postgres(url, { max: 1, ...PG_CONNECTION_OPTIONS });
const db = drizzle(sql, { schema });

try {
  if (command === "list") {
    const rows = await db
      .select({ email: schema.user.email, name: schema.user.name, twoFactor: schema.user.twoFactorEnabled })
      .from(schema.user)
      .where(eq(schema.user.isSuperAdmin, true));
    if (rows.length === 0) console.log("[superadmin] No hay Super Admin.");
    for (const r of rows) console.log(`  ${r.email}  (${r.name})  2FA: ${r.twoFactor ? "sí" : "NO — el panel no abrirá hasta activarlo"}`);
  } else {
    const email = emailArg!.trim().toLowerCase();
    const [user] = await db
      .select({ id: schema.user.id, isSuperAdmin: schema.user.isSuperAdmin, twoFactor: schema.user.twoFactorEnabled })
      .from(schema.user)
      .where(eq(schema.user.email, email))
      .limit(1);
    if (!user) fail("No existe una cuenta con ese correo. Créala primero (pnpm crear-usuario).");
    const grant = command === "grant";
    if (user.isSuperAdmin === grant) {
      console.log(`[superadmin] ${email} ya ${grant ? "es" : "no es"} Super Admin. Nada que hacer.`);
    } else {
      await db.transaction(async (tx) => {
        await tx.update(schema.user).set({ isSuperAdmin: grant, updatedAt: new Date() }).where(eq(schema.user.id, user.id));
        await tx.insert(schema.superAdminAudit).values({
          id: newId("superAdminAudit"),
          actorUserId: null,
          actorEmail: null,
          action: grant ? "grant" : "revoke",
          targetUserId: user.id,
          before: { isSuperAdmin: user.isSuperAdmin },
          after: { isSuperAdmin: grant, email },
          reason: "línea de comandos del servidor",
        });
      });
      console.log(`[superadmin] ${email}: ${grant ? "ahora es Super Admin" : "ya no es Super Admin"}.`);
      if (grant && !user.twoFactor) {
        console.warn("[superadmin] AVISO: esta cuenta no tiene verificación en dos pasos. El panel la exige: actívala en Mi perfil.");
      }
    }
  }
} finally {
  await sql.end();
}
