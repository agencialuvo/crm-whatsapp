import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import type {
  CommissionOverridesInput,
  ScheduleDay,
  ScheduleInput,
  StaffInput,
} from "@/lib/salon/schemas";
import type { StaffDto } from "@/lib/salon/types";
import { existingServiceIds } from "@/server/business/catalog";
import { assertImageOwned } from "@/server/business/refs";
import { FOREIGN_KEY_VIOLATION, isPgError, SalonError } from "@/server/business/http";

/**
 * Módulo SALON — equipo: profesionales, su horario semanal (días libres
 * incluidos) y las comisiones pactadas por servicio.
 *
 * Un profesional con ventas no se borra (son historia financiera): se
 * DESACTIVA. Sus citas pendientes no se pierden: pasan a "sin asignar".
 */

type StaffRow = typeof schema.staff.$inferSelect;

function toDto(
  r: StaffRow,
  schedule: ScheduleDay[],
  commissions: StaffDto["commissions"]
): StaffDto {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    active: r.active,
    acceptsBookings: r.acceptsBookings,
    globalCommissionPercentage: r.globalCommissionPercentage,
    schedule,
    commissions,
    imageMediaId: r.imageMediaId,
    imageUrl: r.imageMediaId ? `/api/medios/${r.imageMediaId}/archivo` : null,
  };
}

export async function listStaff(organizationId: string): Promise<StaffDto[]> {
  const db = getDb();
  const [members, schedules, overrides] = await Promise.all([
    db
      .select()
      .from(schema.staff)
      .where(scoped(schema.staff.organizationId, organizationId))
      .orderBy(asc(schema.staff.createdAt), asc(schema.staff.name)),
    db
      .select()
      .from(schema.staffSchedule)
      .where(scoped(schema.staffSchedule.organizationId, organizationId)),
    db
      .select()
      .from(schema.staffServiceCommission)
      .where(scoped(schema.staffServiceCommission.organizationId, organizationId)),
  ]);

  const scheduleBy = new Map<string, ScheduleDay[]>();
  for (const s of schedules) {
    const list = scheduleBy.get(s.staffId) ?? [];
    list.push({
      dayOfWeek: s.dayOfWeek,
      isOff: s.isOff,
      startTime: s.startTime,
      endTime: s.endTime,
    });
    scheduleBy.set(s.staffId, list);
  }
  const commissionBy = new Map<string, StaffDto["commissions"]>();
  for (const o of overrides) {
    const list = commissionBy.get(o.staffId) ?? [];
    list.push({ serviceId: o.serviceId, percentage: o.percentage });
    commissionBy.set(o.staffId, list);
  }

  return members.map((m) =>
    toDto(
      m,
      (scheduleBy.get(m.id) ?? []).sort((a, b) => a.dayOfWeek - b.dayOfWeek),
      commissionBy.get(m.id) ?? []
    )
  );
}

async function getStaffDto(organizationId: string, id: string): Promise<StaffDto> {
  const found = (await listStaff(organizationId)).find((s) => s.id === id);
  if (!found) throw new SalonError("not_found", 404, "El profesional no existe");
  return found;
}

export async function createStaff(
  organizationId: string,
  input: StaffInput
): Promise<StaffDto> {
  const id = await getDb().transaction(async (tx) => {
    await assertImageOwned(tx, organizationId, input.imageMediaId);
    const [row] = await tx
      .insert(schema.staff)
      .values({
        id: newId("staff"),
        organizationId,
        name: input.name,
        phone: input.phone ?? null,
        active: input.active ?? true,
        acceptsBookings: input.acceptsBookings ?? true,
        globalCommissionPercentage: input.globalCommissionPercentage ?? null,
        imageMediaId: input.imageMediaId ?? null,
      })
      .returning({ id: schema.staff.id });
    return row!.id;
  });
  return getStaffDto(organizationId, id);
}

export async function updateStaff(
  organizationId: string,
  id: string,
  patch: Partial<StaffInput>
): Promise<StaffDto> {
  await getDb().transaction(async (tx) => {
    await assertImageOwned(tx, organizationId, patch.imageMediaId);
    const set = {
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.phone !== undefined && { phone: patch.phone }),
      ...(patch.active !== undefined && { active: patch.active }),
      ...(patch.acceptsBookings !== undefined && { acceptsBookings: patch.acceptsBookings }),
      ...(patch.globalCommissionPercentage !== undefined && {
        globalCommissionPercentage: patch.globalCommissionPercentage,
      }),
      ...(patch.imageMediaId !== undefined && { imageMediaId: patch.imageMediaId }),
    };
    const where = scoped(schema.staff.organizationId, organizationId, eq(schema.staff.id, id));
    // Un PATCH sin campos de la fila no tiene nada que poner.
    const rows =
      Object.keys(set).length > 0
        ? await tx.update(schema.staff).set(set).where(where).returning({ id: schema.staff.id })
        : await tx.select({ id: schema.staff.id }).from(schema.staff).where(where).limit(1);
    if (rows.length === 0) throw new SalonError("not_found", 404, "El profesional no existe");
  });
  return getStaffDto(organizationId, id);
}

export async function deleteStaff(organizationId: string, id: string): Promise<void> {
  try {
    const rows = await getDb()
      .delete(schema.staff)
      .where(scoped(schema.staff.organizationId, organizationId, eq(schema.staff.id, id)))
      .returning({ id: schema.staff.id });
    if (rows.length === 0) throw new SalonError("not_found", 404, "El profesional no existe");
  } catch (err) {
    if (isPgError(err, FOREIGN_KEY_VIOLATION)) {
      throw new SalonError(
        "in_use",
        409,
        "Este profesional ya tiene ventas registradas y no se puede eliminar. Desactívalo para que deje de recibir citas."
      );
    }
    throw err;
  }
}

async function assertStaffExists(organizationId: string, id: string): Promise<void> {
  const rows = await getDb()
    .select({ id: schema.staff.id })
    .from(schema.staff)
    .where(scoped(schema.staff.organizationId, organizationId, eq(schema.staff.id, id)))
    .limit(1);
  if (rows.length === 0) throw new SalonError("not_found", 404, "El profesional no existe");
}

/** Reemplaza el horario semanal. Un día sin fila sigue el horario del negocio. */
export async function setSchedule(
  organizationId: string,
  id: string,
  input: ScheduleInput
): Promise<StaffDto> {
  await assertStaffExists(organizationId, id);
  await getDb().transaction(async (tx) => {
    await tx
      .delete(schema.staffSchedule)
      .where(
        scoped(
          schema.staffSchedule.organizationId,
          organizationId,
          eq(schema.staffSchedule.staffId, id)
        )
      );
    if (input.days.length > 0) {
      await tx.insert(schema.staffSchedule).values(
        input.days.map((d) => ({
          id: newId("staffSchedule"),
          organizationId,
          staffId: id,
          dayOfWeek: d.dayOfWeek,
          // Un día libre no tiene horas: se guardan las del turno completo
          // para que la columna (NOT NULL) tenga un valor coherente.
          startTime: d.startTime,
          endTime: d.endTime,
          isOff: d.isOff,
        }))
      );
    }
  });
  return getStaffDto(organizationId, id);
}

/** Reemplaza las comisiones pactadas por servicio. */
export async function setCommissionOverrides(
  organizationId: string,
  id: string,
  input: CommissionOverridesInput
): Promise<StaffDto> {
  await assertStaffExists(organizationId, id);
  const known = await existingServiceIds(
    organizationId,
    input.overrides.map((o) => o.serviceId)
  );
  const unknown = input.overrides.find((o) => !known.has(o.serviceId));
  if (unknown) {
    throw new SalonError("service_not_found", 422, "Uno de los servicios ya no existe");
  }

  await getDb().transaction(async (tx) => {
    await tx
      .delete(schema.staffServiceCommission)
      .where(
        scoped(
          schema.staffServiceCommission.organizationId,
          organizationId,
          eq(schema.staffServiceCommission.staffId, id)
        )
      );
    if (input.overrides.length > 0) {
      await tx.insert(schema.staffServiceCommission).values(
        input.overrides.map((o) => ({
          id: newId("staffServiceCommission"),
          organizationId,
          staffId: id,
          serviceId: o.serviceId,
          percentage: o.percentage,
        }))
      );
    }
  });
  return getStaffDto(organizationId, id);
}
