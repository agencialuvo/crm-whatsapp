import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { getAuth } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

/**
 * 045 — Acceso del Super Admin: el operador de la PLATAFORMA (no de un negocio).
 *
 * Diferencias deliberadas con `requireSession`:
 *  - NO exige membresía: un Super Admin puede no pertenecer a ninguna organización.
 *  - La bandera `user.is_super_admin` se lee de la BASE en cada petición, jamás de la cookie ni de la sesión:
 *    revocarla surte efecto en la siguiente petición.
 *  - Quien está autenticado pero NO es Super Admin recibe 404 (en páginas `notFound()`, en la API un 404): el
 *    panel no revela que existe. Sin sesión: 401 en la API y a iniciar sesión en las páginas.
 *  - Exige segundo factor (2FA) activo: un Super Admin sin él es el eslabón más débil de toda la plataforma.
 */

export type SuperAdminContext = { userId: string; email: string; name: string; hasOrganization: boolean };

export class SuperAdminDenied extends Error {
  constructor(
    readonly kind: "unauthenticated" | "not_found" | "two_factor_required"
  ) {
    super(kind);
    this.name = "SuperAdminDenied";
  }
}

/** Resuelve al Super Admin de esta petición o lanza `SuperAdminDenied`. */
export async function requireSuperAdmin(): Promise<SuperAdminContext> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) throw new SuperAdminDenied("unauthenticated");
  const [row] = await getDb()
    .select({
      isSuperAdmin: schema.user.isSuperAdmin,
      twoFactorEnabled: schema.user.twoFactorEnabled,
      email: schema.user.email,
      name: schema.user.name,
    })
    .from(schema.user)
    .where(eq(schema.user.id, session.user.id))
    .limit(1);
  if (!row?.isSuperAdmin) throw new SuperAdminDenied("not_found");
  if (!row.twoFactorEnabled) throw new SuperAdminDenied("two_factor_required");
  const [member] = await getDb()
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(eq(schema.member.userId, session.user.id))
    .limit(1);
  return { userId: session.user.id, email: row.email, name: row.name, hasOrganization: Boolean(member) };
}

/**
 * ¿La persona con sesión tiene la bandera de Super Admin? Sin pedir el 2FA: solo decide a dónde mandarla (el panel
 * se encarga de explicar el segundo factor). Lee la base, no la sesión.
 */
export async function isSuperAdminUser(): Promise<boolean> {
  try {
    const session = await getAuth().api.getSession({ headers: await headers() });
    if (!session) return false;
    const [row] = await getDb()
      .select({ isSuperAdmin: schema.user.isSuperAdmin })
      .from(schema.user)
      .where(eq(schema.user.id, session.user.id))
      .limit(1);
    return Boolean(row?.isSuperAdmin);
  } catch {
    return false;
  }
}

/** Igual que `requireSuperAdmin` pero devuelve null en vez de lanzar. */
export async function getSuperAdminOrNull(): Promise<SuperAdminContext | null> {
  try {
    return await requireSuperAdmin();
  } catch {
    return null;
  }
}

/** Gate de las PÁGINAS del panel (server components). */
export async function requireSuperAdminPage(): Promise<SuperAdminContext> {
  try {
    return await requireSuperAdmin();
  } catch (err) {
    if (err instanceof SuperAdminDenied) {
      if (err.kind === "unauthenticated") redirect("/iniciar-sesion");
      if (err.kind === "two_factor_required") redirect("/super-admin/segundo-factor");
      notFound();
    }
    throw err;
  }
}

const MUTATION_LIMIT = { windowMs: 60_000, max: 30 };

/**
 * Envuelve un route handler del panel (paralelo de `withAuth`). Toda ruta bajo `/api/super-admin/` DEBE usarlo:
 * una prueba de vigilancia lo comprueba. Las mutaciones además exigen `Origin` igual a la app (defensa CSRF
 * adicional a la cookie `SameSite`) y están limitadas por usuario.
 */
export function withSuperAdmin<Args extends unknown[]>(
  handler: (admin: SuperAdminContext, req: Request, ...args: Args) => Promise<Response>
): (req: Request, ...args: Args) => Promise<Response> {
  return async (req: Request, ...args: Args) => {
    let admin: SuperAdminContext;
    try {
      admin = await requireSuperAdmin();
    } catch (err) {
      if (err instanceof SuperAdminDenied) {
        if (err.kind === "unauthenticated") return apiError(401, "unauthorized", "No autenticado");
        if (err.kind === "two_factor_required") {
          return apiError(403, "two_factor_required", "El panel exige verificación en dos pasos: actívala en Mi perfil");
        }
        return apiError(404, "not_found", "No encontrado");
      }
      throw err;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.headers.get("origin");
      const base = process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).origin : null;
      // Sin `Origin` (curl, pruebas de servidor) se acepta: el ataque CSRF viene de un navegador, que siempre lo manda.
      if (origin && base && origin !== base && origin !== new URL(req.url).origin) {
        return apiError(403, "bad_origin", "Origen no permitido");
      }
      const rate = checkRateLimit(`super-admin:${admin.userId}`, MUTATION_LIMIT);
      if (!rate.allowed) return apiError(429, "rate_limited", "Demasiadas acciones seguidas; espera un momento");
    }
    try {
      return await handler(admin, req, ...args);
    } catch (err) {
      console.error("[super-admin] error no controlado:", err);
      return apiError(500, "internal", "Error interno");
    }
  };
}

/** IP del cliente para la auditoría. */
export function auditIp(req: Request): string | null {
  const ip = clientIp(req.headers);
  return ip && ip !== "unknown" ? ip : null;
}
