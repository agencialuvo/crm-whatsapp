import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { getEnv } from "@/lib/env";

/**
 * Mejora 3 — El enlace de 24 h para que un profesional (sin usuario en Vocero) conecte su Google Calendar.
 *
 *  - El enlace lleva 256 bits aleatorios; en la base se guarda SOLO su SHA-256 (quien lea la base no puede
 *    usarlo).
 *  - Vence a las 24 h, sirve UNA vez (`used_at`, marcado de forma condicional: dos clics no conectan dos
 *    veces) y generar otro revoca el anterior.
 *  - La búsqueda por hash es la única consulta sin `scoped()` de este módulo, a propósito: el enlace ES la
 *    credencial y es quien dice de qué negocio se trata. Todo lo que sigue usa la organización de la invitación.
 */

export const INVITE_TTL_MS = 24 * 3_600_000;

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

/** La página pública del enlace. */
export function inviteUrl(token: string): string {
  return `${getEnv().APP_BASE_URL.replace(/\/+$/, "")}/conectar-calendario/${token}`;
}

export type InviteState = "valid" | "expired" | "used" | "revoked";

/** PURA: en qué estado está una invitación. */
export function inviteState(
  invite: { expiresAt: Date; usedAt: Date | null; revokedAt: Date | null },
  now: Date
): InviteState {
  if (invite.usedAt) return "used";
  if (invite.revokedAt) return "revoked";
  if (invite.expiresAt.getTime() <= now.getTime()) return "expired";
  return "valid";
}

export class InviteError extends Error {
  constructor(
    readonly code: "staff_not_found" | "staff_inactive",
    message: string
  ) {
    super(message);
    this.name = "InviteError";
  }
}

/** Genera el enlace (revocando los anteriores sin usar del mismo profesional). Devuelve el enlace EN CLARO una sola vez. */
export async function createInvite(input: {
  organizationId: string;
  staffId: string;
  userId: string | null;
  now?: Date;
}): Promise<{ token: string; url: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const db = getDb();
  const [member] = await db
    .select({ id: schema.staff.id, active: schema.staff.active })
    .from(schema.staff)
    .where(scoped(schema.staff.organizationId, input.organizationId, eq(schema.staff.id, input.staffId)))
    .limit(1);
  if (!member) throw new InviteError("staff_not_found", "El profesional no existe.");
  if (!member.active) throw new InviteError("staff_inactive", "El profesional está inactivo: actívalo antes de conectar su calendario.");

  const token = newInviteToken();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  await db.transaction(async (tx) => {
    await revokeOpenInvites(tx, input.organizationId, input.staffId, now);
    await tx.insert(schema.staffCalendarInvite).values({
      id: newId("staffCalendarInvite"),
      organizationId: input.organizationId,
      staffId: input.staffId,
      tokenHash: hashInviteToken(token),
      expiresAt,
      createdByUserId: input.userId,
    });
  });
  return { token, url: inviteUrl(token), expiresAt };
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

async function revokeOpenInvites(db: Tx | ReturnType<typeof getDb>, organizationId: string, staffId: string, now: Date) {
  await db
    .update(schema.staffCalendarInvite)
    .set({ revokedAt: now })
    .where(
      scoped(
        schema.staffCalendarInvite.organizationId,
        organizationId,
        eq(schema.staffCalendarInvite.staffId, staffId),
        isNull(schema.staffCalendarInvite.usedAt),
        isNull(schema.staffCalendarInvite.revokedAt)
      )
    );
}

/** Anula los enlaces sin usar de un profesional (botón «Anular enlace», desconectar, desactivar). */
export async function revokeInvites(organizationId: string, staffId: string, now = new Date()): Promise<void> {
  await revokeOpenInvites(getDb(), organizationId, staffId, now);
}

export type ResolvedInvite = {
  id: string;
  organizationId: string;
  staffId: string;
  staffName: string;
  organizationName: string;
  expiresAt: Date;
};

export type InviteLookup =
  | { ok: true; invite: ResolvedInvite }
  | { ok: false; reason: InviteState | "not_found" | "inactive" };

async function lookup(where: ReturnType<typeof eq>, now: Date): Promise<InviteLookup> {
  const [row] = await getDb()
    .select({
      invite: schema.staffCalendarInvite,
      staffName: schema.staff.name,
      staffActive: schema.staff.active,
      organizationName: schema.organization.name,
    })
    .from(schema.staffCalendarInvite)
    .innerJoin(schema.staff, eq(schema.staff.id, schema.staffCalendarInvite.staffId))
    .innerJoin(schema.organization, eq(schema.organization.id, schema.staffCalendarInvite.organizationId))
    .where(and(where, eq(schema.staff.organizationId, schema.staffCalendarInvite.organizationId)))
    .limit(1);
  if (!row) return { ok: false, reason: "not_found" };
  const state = inviteState(row.invite, now);
  if (state !== "valid") return { ok: false, reason: state };
  if (!row.staffActive) return { ok: false, reason: "inactive" };
  return {
    ok: true,
    invite: {
      id: row.invite.id,
      organizationId: row.invite.organizationId,
      staffId: row.invite.staffId,
      staffName: row.staffName,
      organizationName: row.organizationName,
      expiresAt: row.invite.expiresAt,
    },
  };
}

/** Del enlace en claro a la invitación vigente (o por qué no sirve). */
export function resolveInvite(token: string, now = new Date()): Promise<InviteLookup> {
  if (!token || token.length > 200) return Promise.resolve({ ok: false, reason: "not_found" });
  return lookup(eq(schema.staffCalendarInvite.tokenHash, hashInviteToken(token)), now);
}

/** La invitación por su id (la vuelta de Google trae el id dentro del `state` firmado). */
export function resolveInviteById(inviteId: string, now = new Date()): Promise<InviteLookup> {
  return lookup(eq(schema.staffCalendarInvite.id, inviteId), now);
}

/** Uso único: solo la primera vuelta de Google gana (condicional sobre `used_at`). */
export async function markInviteUsed(invite: ResolvedInvite, now = new Date()): Promise<boolean> {
  const rows = await getDb()
    .update(schema.staffCalendarInvite)
    .set({ usedAt: now })
    .where(
      scoped(
        schema.staffCalendarInvite.organizationId,
        invite.organizationId,
        eq(schema.staffCalendarInvite.id, invite.id),
        isNull(schema.staffCalendarInvite.usedAt),
        isNull(schema.staffCalendarInvite.revokedAt)
      )
    )
    .returning({ id: schema.staffCalendarInvite.id });
  return rows.length > 0;
}

/** El enlace pendiente (sin usar, sin anular, vigente) de cada profesional, para la pantalla Equipo. */
export async function openInvites(organizationId: string, now = new Date()): Promise<Map<string, Date>> {
  const rows = await getDb()
    .select({
      staffId: schema.staffCalendarInvite.staffId,
      expiresAt: schema.staffCalendarInvite.expiresAt,
    })
    .from(schema.staffCalendarInvite)
    .where(
      scoped(
        schema.staffCalendarInvite.organizationId,
        organizationId,
        isNull(schema.staffCalendarInvite.usedAt),
        isNull(schema.staffCalendarInvite.revokedAt)
      )
    );
  const out = new Map<string, Date>();
  for (const r of rows) {
    if (r.expiresAt.getTime() > now.getTime()) out.set(r.staffId, r.expiresAt);
  }
  return out;
}
