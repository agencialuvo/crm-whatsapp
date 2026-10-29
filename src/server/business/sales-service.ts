import { asc, desc, eq, gte, inArray, lt, or, sql, type AnyColumn } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import type { SaleLoyaltyDto } from "@/lib/loyalty";
import { normalizeMx } from "@/lib/meta/client";
import { scoped } from "@/lib/db/tenant";
import {
  allocateAmounts,
  resolveCommissionPercentage,
  splitAmount,
  type CommissionSource,
} from "@/lib/salon/commission";
import {
  PAYMENT_METHODS,
  saleItemsOf,
  type PaymentMethod,
  type SaleEditInput,
  type SaleInput,
  type SaleItemInput,
} from "@/lib/salon/schemas";
import type {
  RegisteredSaleDto,
  SaleItemDto,
  SaleOptionsDto,
  SaleRowDto,
  SalesReportDto,
} from "@/lib/salon/types";
import { dayIsoInTz, zonedWallClockToUtc } from "@/lib/time/slots";
import { businessTimezone, type ResolvedPeriod } from "@/server/analytics/period";
import { SalonError, isPgError, UNIQUE_VIOLATION } from "@/server/business/http";
import { catalogStaffMaps, staffGivesItem } from "@/server/business/catalog-staff";
import { publish } from "@/server/events/bus";
import { reverseSaleStamp, stampSale } from "@/server/loyalty/actions";

/**
 * Módulo SALON — caja: ventas, reparto con el profesional y reporte.
 *
 * Todo en centavos enteros; el reparto lo calcula `splitAmount` (comisión
 * redondeada, neto = resto) y la base exige `comisión + neto = monto`.
 */

/** Tope de filas de la tabla del reporte. Los totales cubren todo el periodo. */
const REPORT_ROW_LIMIT = 2000;
/** Cuántos servicios y ofertas trae el ranking de demanda. */
const ITEM_RANKING_LIMIT = 50;

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
type StaffRow = typeof schema.staff.$inferSelect;

/** Un ítem de la venta ya validado, listo para guardarse. */
type Line = {
  kind: "service" | "combo";
  serviceId: string | null;
  comboId: string | null;
  name: string;
  /** Solo «Otro»: qué fue en concreto. */
  note: string | null;
  other: boolean;
  baseCents: number;
  defaultPct: number | null;
};

const lineToDto = (l: Line, amountCents: number): SaleItemDto => ({
  kind: l.kind,
  name: l.name,
  amountCents,
  serviceId: l.serviceId,
  comboId: l.comboId,
  other: l.other,
  note: l.note,
});

/**
 * Los ítems de una venta (el carrito): cada uno se valida contra la
 * organización, debe estar activo y lo debe dar el profesional elegido.
 * `keep` son los ítems que la venta YA tenía y siguen con el mismo profesional
 * (al editar): no se vuelve a exigir que estén activos ni asignados.
 */
async function resolveLines(
  tx: Tx,
  organizationId: string,
  member: StaffRow,
  rawItems: SaleItemInput[],
  keep?: Set<string>
): Promise<{ lines: Line[]; first: Line }> {
  // «Otro»: el servicio comodín de la organización (se crea con el primer cobro
  // a criterio); su monto lo escribe quien vende, no sale del catálogo.
  const ensureOtherId = async (): Promise<string> => {
    const findOther = () =>
      tx
        .select({ id: schema.service.id })
        .from(schema.service)
        .where(
          scoped(schema.service.organizationId, organizationId, eq(schema.service.isOther, true))
        )
        .limit(1);
    let [other] = await findOther();
    if (!other) {
      await tx
        .insert(schema.service)
        .values({
          id: newId("service"),
          organizationId,
          name: "Otro",
          priceCents: 0,
          isOther: true,
        })
        .onConflictDoNothing();
      [other] = await findOther();
    }
    return other!.id;
  };

  const lines: Line[] = [];
  let otherId: string | null = null;
  for (const raw of rawItems) {
    const serviceId = raw.other ? (otherId ??= await ensureOtherId()) : (raw.serviceId ?? null);
    if (serviceId) {
      const [svc] = await tx
        .select()
        .from(schema.service)
        .where(
          scoped(schema.service.organizationId, organizationId, eq(schema.service.id, serviceId))
        )
        .limit(1);
      if (!svc) throw new SalonError("service_not_found", 404, "El servicio no existe");
      const kept = !raw.other && !!keep?.has(`service:${svc.id}`);
      if (!svc.active && !kept) {
        throw new SalonError("item_inactive", 409, `«${svc.name}» está desactivado.`);
      }
      // Si el servicio detalla qué profesionales lo dan, solo ellos lo cobran. La
      // pantalla ya filtra la lista; la regla vive aquí porque la API se puede
      // llamar sin ella. «Otro» no tiene lista: lo da cualquiera.
      if (
        !raw.other &&
        !kept &&
        !(await staffGivesItem(tx, organizationId, { kind: "service", id: svc.id }, member.id))
      ) {
        throw new SalonError(
          "staff_not_assigned",
          409,
          `${member.name} no da «${svc.name}». Elige a uno de los profesionales que lo dan.`
        );
      }
      lines.push({
        kind: "service",
        serviceId: svc.id,
        comboId: null,
        name: raw.other ? otherLabel(raw.note) : svc.name,
        note: raw.other ? (raw.note?.trim() ?? null) : null,
        other: !!raw.other,
        baseCents: raw.other ? (raw.amountCents ?? 0) : svc.priceCents,
        defaultPct: svc.defaultCommissionPercentage,
      });
    } else {
      const [cmb] = await tx
        .select()
        .from(schema.combo)
        .where(
          scoped(schema.combo.organizationId, organizationId, eq(schema.combo.id, raw.comboId!))
        )
        .limit(1);
      if (!cmb) throw new SalonError("combo_not_found", 404, "La oferta no existe");
      const kept = !!keep?.has(`combo:${cmb.id}`);
      if (!cmb.active && !kept) {
        throw new SalonError("item_inactive", 409, `«${cmb.name}» está desactivado.`);
      }
      if (
        !kept &&
        !(await staffGivesItem(tx, organizationId, { kind: "combo", id: cmb.id }, member.id))
      ) {
        throw new SalonError(
          "staff_not_assigned",
          409,
          `${member.name} no da «${cmb.name}». Elige a uno de los profesionales que lo dan.`
        );
      }
      lines.push({
        kind: "combo",
        serviceId: null,
        comboId: cmb.id,
        name: cmb.name,
        note: null,
        other: false,
        baseCents: cmb.priceCents,
        defaultPct: null,
      });
    }
  }
  return { lines, first: lines[0]! };
}

/**
 * Reparto de una venta: lo que le toca a cada ítem del total y la comisión.
 * Regla: venta → profesional × servicio → profesional → servicio → 50 %. Se
 * calcula POR ÍTEM (cada servicio puede tener su porcentaje) sobre lo que le
 * tocó del total cobrado; la comisión de la venta es la suma.
 */
async function computeSplit(
  tx: Tx,
  organizationId: string,
  member: StaffRow,
  lines: Line[],
  amountCents: number,
  customCommissionPercentage: number | null | undefined
) {
  const amounts = allocateAmounts(
    lines.map((l) => l.baseCents),
    amountCents
  );
  const itemSplits: { commission: number; pct: number; source: CommissionSource }[] = [];
  for (const [i, line] of lines.entries()) {
    let staffServicePct: number | null = null;
    if (line.serviceId) {
      const [ov] = await tx
        .select({ percentage: schema.staffServiceCommission.percentage })
        .from(schema.staffServiceCommission)
        .where(
          scoped(
            schema.staffServiceCommission.organizationId,
            organizationId,
            eq(schema.staffServiceCommission.staffId, member.id),
            eq(schema.staffServiceCommission.serviceId, line.serviceId)
          )
        )
        .limit(1);
      staffServicePct = ov?.percentage ?? null;
    }
    const { percentage, source } = resolveCommissionPercentage({
      custom: customCommissionPercentage,
      staffService: staffServicePct,
      staff: member.globalCommissionPercentage,
      service: line.defaultPct,
    });
    itemSplits.push({
      commission: splitAmount(amounts[i]!, percentage).staffCommissionCents,
      pct: percentage,
      source,
    });
  }
  const staffCommissionCents = itemSplits.reduce((a, s2) => a + s2.commission, 0);
  const businessNetCents = amountCents - staffCommissionCents;
  // Lo que se informa: el porcentaje del ítem si todos coinciden; si no, el efectivo de la venta.
  const sameRule = itemSplits.every(
    (x) => x.pct === itemSplits[0]!.pct && x.source === itemSplits[0]!.source
  );
  const percentage = sameRule
    ? itemSplits[0]!.pct
    : amountCents > 0
      ? Math.round((staffCommissionCents / amountCents) * 10000) / 100
      : 0;
  const source: CommissionSource = sameRule ? itemSplits[0]!.source : "custom";
  return { amounts, staffCommissionCents, businessNetCents, percentage, source };
}

/**
 * Registra una venta completada. Valida TODO contra la organización (el
 * profesional, el servicio o combo, el contacto y la cita), calcula la
 * comisión y, si nació de una cita, la marca como realizada — todo en una
 * transacción: no queda una venta sin su cita ni una cita cobrada sin venta.
 */
export async function registerServiceSale(
  organizationId: string,
  input: SaleInput
): Promise<RegisteredSaleDto> {
  const db = getDb();

  // Una venta puede registrarse con una fecha elegida (pasada, de hoy o futura).
  // Un DÍA elegido se guarda siempre al mediodía del negocio: una hora cercana a
  // la medianoche caería en otro día para quien mira desde otra zona (Lima, UTC,
  // México) y el día mostrado no sería el que se eligió. Sin fecha, es ahora.
  let soldAt: Date | undefined;
  if (input.soldOn) {
    const tz = await businessTimezone(organizationId);
    soldAt = zonedWallClockToUtc(input.soldOn, "12:00", tz) ?? undefined;
  }

  const result = await db.transaction(async (tx) => {
    const [member] = await tx
      .select()
      .from(schema.staff)
      .where(
        scoped(schema.staff.organizationId, organizationId, eq(schema.staff.id, input.staffId))
      )
      .limit(1);
    if (!member) throw new SalonError("staff_not_found", 404, "El profesional no existe");
    if (!member.active) {
      throw new SalonError(
        "staff_inactive",
        409,
        `${member.name} está inactivo. Actívalo para registrarle ventas.`
      );
    }

    const { lines, first } = await resolveLines(tx, organizationId, member, saleItemsOf(input));

    // La cita que se cobra: debe ser de esta organización, real (no del
    // Laboratorio), una sesión y no cancelada. Si trae contacto y no se pasó
    // otro, el cliente es el de la cita.
    let contactId = input.contactId ?? null;
    if (input.bookingId) {
      const [bk] = await tx
        .select()
        .from(schema.booking)
        .where(
          scoped(
            schema.booking.organizationId,
            organizationId,
            eq(schema.booking.id, input.bookingId)
          )
        )
        .limit(1);
      if (!bk) throw new SalonError("booking_not_found", 404, "La cita no existe");
      if (bk.isTest) {
        throw new SalonError("test_booking", 409, "Una cita de prueba no se cobra.");
      }
      if (bk.kind !== "session" || bk.status === "cancelada" || bk.status === "no_show") {
        throw new SalonError("booking_not_chargeable", 409, "Esa cita no se puede cobrar.");
      }
      contactId = contactId ?? bk.contactId;
    }

    let customerName = input.customerName?.trim() || "";

    // Cliente identificado por celular: si ya existe se reutiliza; si no, se
    // da de alta. La identidad se normaliza igual que la ingesta de WhatsApp,
    // así el mismo humano nunca queda en dos fichas.
    if (!contactId && input.customerPhone) {
      const phone = normalizeMx(input.customerPhone);
      const [found] = await tx
        .select({ id: schema.contact.id })
        .from(schema.contact)
        .where(
          scoped(
            schema.contact.organizationId,
            organizationId,
            eq(schema.contact.channel, "whatsapp"),
            or(eq(schema.contact.waIdentity, phone), eq(schema.contact.phone, phone))
          )
        )
        .limit(1);
      if (found) {
        contactId = found.id;
      } else {
        const [created] = await tx
          .insert(schema.contact)
          .values({
            id: newId("contact"),
            organizationId,
            name: customerName || phone,
            nameSource: "manual",
            phone,
            waIdentity: phone,
            source: "conocido",
          })
          .onConflictDoNothing({
            target: [
              schema.contact.organizationId,
              schema.contact.channel,
              schema.contact.waIdentity,
            ],
          })
          .returning({ id: schema.contact.id });
        contactId = created?.id ?? null;
        if (!contactId) {
          // Otro registro del mismo celular ganó la carrera: se reutiliza ese
          // contacto. Una venta nunca debe quedar sin persona por esta razón.
          const [winner] = await tx
            .select({ id: schema.contact.id })
            .from(schema.contact)
            .where(
              scoped(
                schema.contact.organizationId,
                organizationId,
                eq(schema.contact.channel, "whatsapp"),
                eq(schema.contact.waIdentity, phone)
              )
            )
            .limit(1);
          if (!winner) {
            throw new SalonError("contact_not_found", 409, "No se pudo registrar al cliente. Intenta de nuevo.");
          }
          contactId = winner.id;
        }
      }
    }

    if (contactId) {
      const [c] = await tx
        .select({ id: schema.contact.id, name: schema.contact.name })
        .from(schema.contact)
        .where(scoped(schema.contact.organizationId, organizationId, eq(schema.contact.id, contactId)))
        .limit(1);
      if (!c) throw new SalonError("contact_not_found", 404, "El contacto no existe");
      customerName = c.name;
      // Quien compra en Caja es cliente del salón (también si lo habían quitado de
      // Clientes). El cumpleaños se guarda solo si se indicó; nunca se borra.
      await tx
        .update(schema.contact)
        .set({
          salonClient: true,
          updatedAt: new Date(),
          ...(input.birthdayDay != null && input.birthdayMonth != null
            ? { birthdayDay: input.birthdayDay, birthdayMonth: input.birthdayMonth }
            : {}),
        })
        .where(
          scoped(schema.contact.organizationId, organizationId, eq(schema.contact.id, c.id))
        );
    }
    if (!customerName) customerName = "Cliente de mostrador";

    const { amounts, staffCommissionCents, businessNetCents, percentage, source } = await computeSplit(
      tx,
      organizationId,
      member,
      lines,
      input.amountCents,
      input.customCommissionPercentage
    );

    const id = newId("serviceSale");
    let createdAt: Date;
    try {
      const [row] = await tx
        .insert(schema.serviceSale)
        .values({
          id,
          organizationId,
          bookingId: input.bookingId ?? null,
          contactId,
          customerName,
          staffId: member.id,
          serviceId: first.serviceId,
          comboId: first.comboId,
          amountCents: input.amountCents,
          staffCommissionCents,
          businessNetCents,
          paymentMethod: input.paymentMethod,
          ...(soldAt ? { createdAt: soldAt } : {}),
        })
        .returning({ createdAt: schema.serviceSale.createdAt });
      createdAt = row!.createdAt;
    } catch (err) {
      // El índice único de `booking_id`: dos cobros de la misma cita.
      if (isPgError(err, UNIQUE_VIOLATION)) {
        throw new SalonError("already_sold", 409, "Esa cita ya fue cobrada.");
      }
      throw err;
    }
    await tx.insert(schema.serviceSaleItem).values(
      lines.map((line, i) => ({
        id: newId("serviceSaleItem"),
        organizationId,
        saleId: id,
        serviceId: line.serviceId,
        comboId: line.comboId,
        amountCents: amounts[i]!,
        position: i,
        note: line.note,
      }))
    );

    // Fidelización: +1 sello, o constancia sin sello si hubo descuento de cumpleaños.
    // Va en esta transacción (cobro y sello juntos) y nunca bloquea el cobro.
    let loyalty: SaleLoyaltyDto | null = null;
    if (contactId) {
      const stamped = await stampSale(tx, {
        organizationId,
        contactId,
        saleId: id,
        staffId: member.id,
        birthdayDiscount: input.birthdayDiscount === true,
      });
      if (stamped) {
        loyalty = {
          type: input.birthdayDiscount === true ? "birthday_excluded" : "earned",
          currentStamps: stamped.card.currentStamps,
          stampsRequired: stamped.stampsRequired,
          rewardReady: stamped.rewardReady,
          rewardJustUnlocked: stamped.rewardJustUnlocked,
          unlockedTitle: stamped.unlocked[stamped.unlocked.length - 1]?.title ?? null,
        };
      }
    }

    if (input.bookingId) {
      await tx
        .update(schema.booking)
        .set({ status: "realizada", updatedAt: new Date() })
        .where(
          scoped(
            schema.booking.organizationId,
            organizationId,
            eq(schema.booking.id, input.bookingId),
            eq(schema.booking.status, "agendada")
          )
        );
    }

    const sale: SaleRowDto = {
      id,
      createdAt: createdAt.toISOString(),
      customerName,
      contactId,
      staffId: member.id,
      staffName: member.name,
      itemKind: first.kind,
      itemName: lines.map((l) => l.name).join(" + "),
      items: lines.map((l, i) => lineToDto(l, amounts[i]!)),
      paymentMethod: input.paymentMethod,
      amountCents: input.amountCents,
      staffCommissionCents,
      businessNetCents,
      bookingId: input.bookingId ?? null,
    };
    return { sale, commissionPercentage: percentage, commissionSource: source, loyalty };
  });

  // Después del commit (contrato del bus): la agenda abierta se refresca sola.
  if (input.bookingId) {
    publish(organizationId, { type: "booking.updated", data: { bookingId: input.bookingId } });
  }
  return result;
}

/** Cómo se ve un cobro «Otro» en Caja y en el historial: «Otro: Peinado para evento». */
const otherLabel = (note: string | null | undefined): string =>
  note?.trim() ? `Otro: ${note.trim()}` : "Otro";

/**
 * Los ítems de cada venta, en el orden en que se agregaron, con el nombre del
 * servicio u oferta y lo que le tocó del total cobrado.
 */
export async function loadSaleItems(
  organizationId: string,
  saleIds: string[]
): Promise<Map<string, SaleRowDto["items"]>> {
  const by = new Map<string, SaleRowDto["items"]>();
  if (saleIds.length === 0) return by;
  const item = schema.serviceSaleItem;
  const rows = await getDb()
    .select({
      saleId: item.saleId,
      serviceId: item.serviceId,
      comboId: item.comboId,
      note: item.note,
      isOther: schema.service.isOther,
      serviceName: schema.service.name,
      comboName: schema.combo.name,
      amountCents: item.amountCents,
    })
    .from(item)
    .leftJoin(schema.service, eq(schema.service.id, item.serviceId))
    .leftJoin(schema.combo, eq(schema.combo.id, item.comboId))
    .where(scoped(item.organizationId, organizationId, inArray(item.saleId, saleIds)))
    .orderBy(asc(item.saleId), asc(item.position));
  for (const r of rows) {
    const list = by.get(r.saleId) ?? [];
    list.push({
      kind: r.comboId ? "combo" : "service",
      name: r.note ? otherLabel(r.note) : (r.comboName ?? r.serviceName ?? "—"),
      amountCents: r.amountCents,
      serviceId: r.serviceId,
      comboId: r.comboId,
      other: !!r.isOther,
      note: r.note,
    });
    by.set(r.saleId, list);
  }
  return by;
}

/** Suma en SQL como `float8`: exacto hasta 2^53 centavos y llega como número, no como texto. */
const num = (col: AnyColumn) => sql<number>`coalesce(sum(${col}), 0)::float8`;

/**
 * El reporte de caja de un periodo ya resuelto en la zona del negocio (rango
 * `[start, end)`). Los totales y los desgloses se agregan en SQL sobre TODO el
 * periodo; la tabla trae las `REPORT_ROW_LIMIT` ventas más recientes.
 */
export async function getSalesReport(
  organizationId: string,
  period: ResolvedPeriod,
  staffId?: string | null,
  /** `false`: solo agregados (el Panel no pinta la tabla de ventas). */
  withRows = true
): Promise<SalesReportDto> {
  const db = getDb();
  const sale = schema.serviceSale;
  // `staffId` acota TODO el reporte (filas, totales y desgloses) a un profesional.
  const inRange = scoped(
    sale.organizationId,
    organizationId,
    gte(sale.createdAt, period.start),
    lt(sale.createdAt, period.end),
    staffId ? eq(sale.staffId, staffId) : undefined
  );

  const [rows, totals, byStaff, byPayment, byItem] = await Promise.all([
    db
      .select({
        id: sale.id,
        createdAt: sale.createdAt,
        customerName: sale.customerName,
        contactId: sale.contactId,
        staffId: sale.staffId,
        staffName: schema.staff.name,
        serviceName: schema.service.name,
        comboName: schema.combo.name,
        paymentMethod: sale.paymentMethod,
        amountCents: sale.amountCents,
        staffCommissionCents: sale.staffCommissionCents,
        businessNetCents: sale.businessNetCents,
        bookingId: sale.bookingId,
      })
      .from(sale)
      .innerJoin(schema.staff, eq(schema.staff.id, sale.staffId))
      .leftJoin(schema.service, eq(schema.service.id, sale.serviceId))
      .leftJoin(schema.combo, eq(schema.combo.id, sale.comboId))
      .where(inRange)
      .orderBy(desc(sale.createdAt))
      .limit(withRows ? REPORT_ROW_LIMIT + 1 : 0),
    db
      .select({
        count: sql<number>`count(*)::int`,
        revenue: num(sale.amountCents),
        commissions: num(sale.staffCommissionCents),
        net: num(sale.businessNetCents),
      })
      .from(sale)
      .where(inRange),
    db
      .select({
        staffId: sale.staffId,
        staffName: schema.staff.name,
        count: sql<number>`count(*)::int`,
        revenue: num(sale.amountCents),
        commission: num(sale.staffCommissionCents),
      })
      .from(sale)
      .innerJoin(schema.staff, eq(schema.staff.id, sale.staffId))
      .where(inRange)
      .groupBy(sale.staffId, schema.staff.name)
      .orderBy(desc(sql`sum(${sale.staffCommissionCents})`), asc(schema.staff.name)),
    db
      .select({
        method: sale.paymentMethod,
        count: sql<number>`count(*)::int`,
        amount: num(sale.amountCents),
      })
      .from(sale)
      .where(inRange)
      .groupBy(sale.paymentMethod),
    db
      // Por ÍTEM, no por venta: un carrito con tres servicios cuenta tres veces, y
      // cada uno con lo que le tocó del total (la suma de los ítems es el monto).
      .select({
        serviceId: schema.serviceSaleItem.serviceId,
        comboId: schema.serviceSaleItem.comboId,
        serviceName: schema.service.name,
        comboName: schema.combo.name,
        count: sql<number>`count(*)::int`,
        revenue: num(schema.serviceSaleItem.amountCents),
      })
      .from(schema.serviceSaleItem)
      .innerJoin(sale, eq(sale.id, schema.serviceSaleItem.saleId))
      .leftJoin(schema.service, eq(schema.service.id, schema.serviceSaleItem.serviceId))
      .leftJoin(schema.combo, eq(schema.combo.id, schema.serviceSaleItem.comboId))
      .where(inRange)
      .groupBy(
        schema.serviceSaleItem.serviceId,
        schema.serviceSaleItem.comboId,
        schema.service.name,
        schema.combo.name
      )
      .orderBy(desc(sql`count(*)`), desc(sql`sum(${schema.serviceSaleItem.amountCents})`))
      .limit(ITEM_RANKING_LIMIT),
  ]);

  const truncated = rows.length > REPORT_ROW_LIMIT;
  const shown = rows.slice(0, REPORT_ROW_LIMIT);
  const itemsBySale = await loadSaleItems(
    organizationId,
    shown.map((r) => r.id)
  );
  const t = totals[0];
  const methodOrder = new Map(PAYMENT_METHODS.map((m, i) => [m, i]));

  return {
    staffId: staffId ?? null,
    period: {
      from: period.dto.from,
      to: period.dto.to,
      timezone: period.timezone,
      days: period.dto.days,
    },
    totals: {
      count: t?.count ?? 0,
      revenueCents: t?.revenue ?? 0,
      commissionsCents: t?.commissions ?? 0,
      netCents: t?.net ?? 0,
    },
    byStaff: byStaff.map((r) => ({
      staffId: r.staffId,
      staffName: r.staffName,
      count: r.count,
      revenueCents: r.revenue,
      commissionCents: r.commission,
      netCents: r.revenue - r.commission,
    })),
    byItem: byItem.map((r) => ({
      kind: r.comboId ? ("combo" as const) : ("service" as const),
      itemId: (r.comboId ?? r.serviceId)!,
      name: r.comboName ?? r.serviceName ?? "—",
      count: r.count,
      revenueCents: r.revenue,
    })),
    byPayment: byPayment
      .map((r) => ({
        method: r.method as PaymentMethod,
        count: r.count,
        amountCents: r.amount,
      }))
      .sort((a, b) => (methodOrder.get(a.method) ?? 0) - (methodOrder.get(b.method) ?? 0)),
    rows: shown.map((r): SaleRowDto => {
      const items = itemsBySale.get(r.id) ?? [
        {
          kind: r.comboName ? ("combo" as const) : ("service" as const),
          name: r.comboName ?? r.serviceName ?? "—",
          amountCents: r.amountCents,
          serviceId: null,
          comboId: null,
          other: false,
          note: null,
        },
      ];
      return {
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        customerName: r.customerName,
        contactId: r.contactId,
        staffId: r.staffId,
        staffName: r.staffName,
        itemKind: items[0]!.kind,
        itemName: items.map((i) => i.name).join(" + "),
        items,
        paymentMethod: r.paymentMethod,
        amountCents: r.amountCents,
        staffCommissionCents: r.staffCommissionCents,
        businessNetCents: r.businessNetCents,
        bookingId: r.bookingId,
      };
    }),
    truncated,
  };
}

/**
 * Corrige el DÍA de una venta (se registró con una fecha equivocada). Solo
 * cambia cuándo ocurrió: el monto y el reparto no se tocan, y como los reportes
 * de Caja y de comisiones se arman con esa fecha, la venta pasa sola al periodo
 * correcto. Si el día no cambia, queda igual; el día elegido se guarda al
 * mediodía del negocio.
 *
 * Cada cambio real deja una fila de auditoría (quién, cuándo, fecha anterior y
 * nueva) en la misma transacción: no puede haber cambio sin rastro.
 */
export async function updateSaleDate(
  organizationId: string,
  id: string,
  soldOn: string,
  actorUserId: string
): Promise<{ id: string; createdAt: string }> {
  const db = getDb();
  const tz = await businessTimezone(organizationId);

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ createdAt: schema.serviceSale.createdAt })
      .from(schema.serviceSale)
      .where(
        scoped(schema.serviceSale.organizationId, organizationId, eq(schema.serviceSale.id, id))
      )
      .limit(1)
      .for("update");
    if (!current) throw new SalonError("not_found", 404, "La venta no existe");

    if (dayIsoInTz(current.createdAt, tz) === soldOn) {
      return { id, createdAt: current.createdAt.toISOString() };
    }
    const next = zonedWallClockToUtc(soldOn, "12:00", tz);
    if (!next) throw new SalonError("invalid_date", 400, "Fecha no válida");

    const [actor] = await tx
      .select({ name: schema.user.name, email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, actorUserId))
      .limit(1);

    await tx
      .update(schema.serviceSale)
      .set({ createdAt: next })
      .where(
        scoped(schema.serviceSale.organizationId, organizationId, eq(schema.serviceSale.id, id))
      );
    await tx.insert(schema.serviceSaleDateChange).values({
      id: newId("serviceSaleDateChange"),
      organizationId,
      saleId: id,
      previousAt: current.createdAt,
      newAt: next,
      changedByUserId: actorUserId,
      changedByLabel: actor ? `${actor.name} <${actor.email}>` : actorUserId,
    });
    return { id, createdAt: next.toISOString() };
  });
}

/** La venta como quedó (o como era), en la forma que guarda la auditoría. */
type SaleSnapshot = {
  customerName: string;
  /** Cuándo ocurrió la venta (ISO). */
  soldAt: string;
  staffId: string;
  staffName: string;
  amountCents: number;
  staffCommissionCents: number;
  businessNetCents: number;
  items: {
    serviceId: string | null;
    comboId: string | null;
    name: string;
    other: boolean;
    note: string | null;
    amountCents: number;
  }[];
};

/**
 * Corrige una venta ya registrada: los ítems, quién atendió y el monto cobrado.
 * Se recalcula el reparto (ítems y comisión) con las reglas de hoy, y TODO ocurre
 * en una transacción con la venta bloqueada: o queda corregida y con su rastro de
 * auditoría (la venta antes y después, quién y cuándo), o no cambia nada. Puede
 * cambiar también el cliente (otro contacto de la organización, que pasa a ser
 * cliente del salón) y la fecha y hora (en la zona del negocio; el cambio de
 * momento deja además su fila de auditoría de fecha). El método de pago y la
 * cita no se tocan. Como la ficha del
 * cliente y el Panel leen de las ventas, se actualizan solos. Sin cambios reales
 * no se escribe nada (ni auditoría).
 */
export async function updateSale(
  organizationId: string,
  id: string,
  input: SaleEditInput,
  actorUserId: string
): Promise<{ id: string; changed: boolean }> {
  const tz = input.soldOn ? await businessTimezone(organizationId) : null;
  const result = await getDb().transaction(async (tx) => {
    const sale = schema.serviceSale;
    const [current] = await tx
      .select()
      .from(sale)
      .where(scoped(sale.organizationId, organizationId, eq(sale.id, id)))
      .limit(1)
      .for("update");
    if (!current) throw new SalonError("not_found", 404, "La venta no existe");

    const [member] = await tx
      .select()
      .from(schema.staff)
      .where(scoped(schema.staff.organizationId, organizationId, eq(schema.staff.id, input.staffId)))
      .limit(1);
    if (!member) throw new SalonError("staff_not_found", 404, "El profesional no existe");
    const staffUnchanged = member.id === current.staffId;
    if (!member.active && !staffUnchanged) {
      throw new SalonError(
        "staff_inactive",
        409,
        `${member.name} está inactivo. Actívalo para asignarle ventas.`
      );
    }

    // Cómo era la venta (los ítems vienen con lo que le tocó a cada uno).
    const before = (await loadSaleItems(organizationId, [id])).get(id) ?? [];
    const [oldStaff] = await tx
      .select({ name: schema.staff.name })
      .from(schema.staff)
      .where(scoped(schema.staff.organizationId, organizationId, eq(schema.staff.id, current.staffId)))
      .limit(1);
    // Otro cliente: debe ser un contacto de esta organización.
    let nextContactId = current.contactId;
    let nextCustomerName = current.customerName;
    if (input.contactId && input.contactId !== current.contactId) {
      const [c] = await tx
        .select({ id: schema.contact.id, name: schema.contact.name })
        .from(schema.contact)
        .where(
          scoped(schema.contact.organizationId, organizationId, eq(schema.contact.id, input.contactId))
        )
        .limit(1);
      if (!c) throw new SalonError("contact_not_found", 404, "El cliente no existe");
      nextContactId = c.id;
      nextCustomerName = c.name;
    }

    // Nueva fecha y hora: el instante de esa hora de pared en la zona del negocio
    // (a la precisión del minuto, que es lo que se edita).
    let nextAt = current.createdAt;
    if (input.soldOn && input.soldTime && tz) {
      const at = zonedWallClockToUtc(input.soldOn, input.soldTime, tz);
      if (!at) throw new SalonError("invalid_date", 400, "Fecha u hora no válida");
      const sameMinute =
        Math.floor(at.getTime() / 60_000) === Math.floor(current.createdAt.getTime() / 60_000);
      if (!sameMinute) nextAt = at;
    }
    const dateChanged = nextAt.getTime() !== current.createdAt.getTime();

    const snapshotOf = (
      staff: { id: string; name: string },
      amountCents: number,
      commission: number,
      net: number,
      items: SaleItemDto[],
      customerName: string,
      soldAt: Date
    ): SaleSnapshot => ({
      customerName,
      soldAt: soldAt.toISOString(),
      staffId: staff.id,
      staffName: staff.name,
      amountCents,
      staffCommissionCents: commission,
      businessNetCents: net,
      items: items.map((i) => ({
        serviceId: i.serviceId,
        comboId: i.comboId,
        name: i.name,
        other: i.other,
        note: i.note,
        amountCents: i.amountCents,
      })),
    });
    const beforeSnap = snapshotOf(
      { id: current.staffId, name: oldStaff?.name ?? "—" },
      current.amountCents,
      current.staffCommissionCents,
      current.businessNetCents,
      before,
      current.customerName,
      current.createdAt
    );

    // Los ítems que ya estaban y siguen con el mismo profesional no se vuelven a exigir.
    const keep = staffUnchanged
      ? new Set(
          before.map((i) => (i.comboId ? `combo:${i.comboId}` : i.serviceId ? `service:${i.serviceId}` : ""))
        )
      : undefined;
    const { lines, first } = await resolveLines(tx, organizationId, member, input.items, keep);
    const split = await computeSplit(
      tx,
      organizationId,
      member,
      lines,
      input.amountCents,
      input.customCommissionPercentage
    );
    const afterSnap = snapshotOf(
      member,
      input.amountCents,
      split.staffCommissionCents,
      split.businessNetCents,
      lines.map((l, i) => lineToDto(l, split.amounts[i]!)),
      nextCustomerName,
      nextAt
    );
    if (JSON.stringify(beforeSnap) === JSON.stringify(afterSnap)) return { id, changed: false };

    const [actor] = await tx
      .select({ name: schema.user.name, email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, actorUserId))
      .limit(1);

    await tx
      .update(sale)
      .set({
        staffId: member.id,
        serviceId: first.serviceId,
        comboId: first.comboId,
        contactId: nextContactId,
        customerName: nextCustomerName,
        createdAt: nextAt,
        amountCents: input.amountCents,
        staffCommissionCents: split.staffCommissionCents,
        businessNetCents: split.businessNetCents,
      })
      .where(scoped(sale.organizationId, organizationId, eq(sale.id, id)));
    // Quien compra es cliente del salón (también si lo habían quitado de Clientes).
    if (nextContactId && nextContactId !== current.contactId) {
      await tx
        .update(schema.contact)
        .set({ salonClient: true, updatedAt: new Date() })
        .where(scoped(schema.contact.organizationId, organizationId, eq(schema.contact.id, nextContactId)));
    }
    if (dateChanged) {
      await tx.insert(schema.serviceSaleDateChange).values({
        id: newId("serviceSaleDateChange"),
        organizationId,
        saleId: id,
        previousAt: current.createdAt,
        newAt: nextAt,
        changedByUserId: actorUserId,
        changedByLabel: actor ? `${actor.name} <${actor.email}>` : actorUserId,
      });
    }
    await tx
      .delete(schema.serviceSaleItem)
      .where(scoped(schema.serviceSaleItem.organizationId, organizationId, eq(schema.serviceSaleItem.saleId, id)));
    await tx.insert(schema.serviceSaleItem).values(
      lines.map((line, i) => ({
        id: newId("serviceSaleItem"),
        organizationId,
        saleId: id,
        serviceId: line.serviceId,
        comboId: line.comboId,
        amountCents: split.amounts[i]!,
        position: i,
        note: line.note,
      }))
    );
    await tx.insert(schema.serviceSaleEdit).values({
      id: newId("serviceSaleEdit"),
      organizationId,
      saleId: id,
      changedByUserId: actorUserId,
      changedByLabel: actor ? `${actor.name} <${actor.email}>` : actorUserId,
      before: beforeSnap,
      after: afterSnap,
    });
    return { id, changed: true };
  });
  return result;
}

/** Anular una venta (un cobro mal registrado). La cita, si la hubo, queda como estaba. */
export async function deleteSale(organizationId: string, id: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    // Su sello de fidelidad se retira en la misma transacción (antes de borrar la venta).
    await reverseSaleStamp(tx, organizationId, id);
    const rows = await tx
      .delete(schema.serviceSale)
      .where(
        scoped(schema.serviceSale.organizationId, organizationId, eq(schema.serviceSale.id, id))
      )
      .returning({ id: schema.serviceSale.id });
    if (rows.length === 0) throw new SalonError("not_found", 404, "La venta no existe");
  });
}

/**
 * Lo que necesita el formulario de cobro: lo ACTIVO y sin comisiones, para
 * poder darse a todo el equipo (quien cobra en el mostrador no ve los
 * porcentajes de nadie).
 */
export async function getSaleOptions(organizationId: string): Promise<SaleOptionsDto> {
  const db = getDb();
  const [services, combos, members] = await Promise.all([
    db
      .select({
        id: schema.service.id,
        name: schema.service.name,
        priceCents: schema.service.priceCents,
        durationMinutes: schema.service.durationMinutes,
      })
      .from(schema.service)
      .where(
        scoped(
          schema.service.organizationId,
          organizationId,
          eq(schema.service.active, true),
          eq(schema.service.isOther, false)
        )
      )
      .orderBy(asc(schema.service.name)),
    db
      .select({
        id: schema.combo.id,
        name: schema.combo.name,
        priceCents: schema.combo.priceCents,
        durationMinutes: schema.combo.durationMinutes,
      })
      .from(schema.combo)
      .where(scoped(schema.combo.organizationId, organizationId, eq(schema.combo.active, true)))
      .orderBy(asc(schema.combo.name)),
    db
      .select({ id: schema.staff.id, name: schema.staff.name })
      .from(schema.staff)
      .where(scoped(schema.staff.organizationId, organizationId, eq(schema.staff.active, true)))
      .orderBy(asc(schema.staff.createdAt), asc(schema.staff.name)),
  ]);
  const staffBy = await catalogStaffMaps(organizationId);
  return {
    services: services.map((x) => ({ ...x, staffIds: staffBy.services.get(x.id) ?? [] })),
    combos: combos.map((x) => ({ ...x, staffIds: staffBy.combos.get(x.id) ?? [] })),
    staff: members,
  };
}
