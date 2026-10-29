import type { SaleLoyaltyDto } from "@/lib/loyalty";
import type { CommissionSource } from "@/lib/salon/commission";
import type { PaymentMethod, ScheduleDay } from "@/lib/salon/schemas";

/**
 * Módulo SALON — lo que viaja entre la API y las pantallas.
 *
 * Vive en `lib/` (no en `server/`) para que el cliente tipe sus respuestas sin
 * arrastrar la base de datos al bundle. Dinero en centavos; instantes en ISO
 * UTC; las horas "de pared" ya vienen resueltas en la zona del negocio.
 */

export type ServiceDto = {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  durationMinutes: number;
  defaultCommissionPercentage: number;
  active: boolean;
  /** Imagen de la biblioteca de Medios (id y su URL), o `null`. */
  imageMediaId: string | null;
  imageUrl: string | null;
  /** Profesionales que lo dan. Vacío = TODO el equipo. */
  staffIds: string[];
};

export type ComboDto = {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  durationMinutes: number;
  keywordTrigger: string | null;
  active: boolean;
  imageMediaId: string | null;
  imageUrl: string | null;
  /** Profesionales que la dan. Vacío = TODO el equipo. */
  staffIds: string[];
};

export type StaffDto = {
  id: string;
  name: string;
  phone: string | null;
  active: boolean;
  globalCommissionPercentage: number | null;
  /** Solo los días con horario propio o libres; los demás siguen al negocio. */
  schedule: ScheduleDay[];
  /** Porcentajes pactados por servicio (pisan el global). */
  commissions: { serviceId: string; percentage: number }[];
  /** Foto de la biblioteca de Medios (id y su URL), o `null`. */
  imageMediaId: string | null;
  imageUrl: string | null;
};

/** Lo mínimo para armar una venta: SIN comisiones (lo ve todo el equipo). */
export type SaleOptionsDto = {
  /** `staffIds` vacío = lo da todo el equipo. */
  services: { id: string; name: string; priceCents: number; durationMinutes: number; staffIds: string[] }[];
  combos: { id: string; name: string; priceCents: number; durationMinutes: number; staffIds: string[] }[];
  staff: { id: string; name: string }[];
};

/** Un ítem de una venta: qué fue, lo que le tocó del total y, si es «Otro», su detalle. */
export type SaleItemDto = {
  kind: "service" | "combo";
  name: string;
  amountCents: number;
  serviceId: string | null;
  comboId: string | null;
  /** «Otro»: el cobro a criterio, con su detalle en `note`. */
  other: boolean;
  note: string | null;
};

export type SaleRowDto = {
  id: string;
  /** Instante UTC (ISO). */
  createdAt: string;
  customerName: string;
  /** El contacto de la venta (puede no haber, o haberse borrado). */
  contactId: string | null;
  staffId: string;
  staffName: string;
  /** El primer ítem de la venta. */
  itemKind: "service" | "combo";
  /** Los nombres de todos los ítems, unidos con « + » (una venta puede llevar varios). */
  itemName: string;
  /** Cada ítem de la venta con lo que le tocó del total cobrado. */
  items: SaleItemDto[];
  paymentMethod: PaymentMethod;
  amountCents: number;
  staffCommissionCents: number;
  businessNetCents: number;
  bookingId: string | null;
};

/** Respuesta de cobrar: la venta y con qué regla se repartió. */
export type RegisteredSaleDto = {
  sale: SaleRowDto;
  commissionPercentage: number;
  commissionSource: CommissionSource;
  /** El sello de fidelidad de esta venta; `null` si no hubo cliente identificado o no se pudo sellar. */
  loyalty: SaleLoyaltyDto | null;
};

export type SalesReportDto = {
  /** Si el reporte se acotó a un profesional (auditoría rápida). */
  staffId: string | null;
  period: { from: string; to: string; timezone: string; days: number };
  totals: {
    count: number;
    revenueCents: number;
    commissionsCents: number;
    netCents: number;
  };
  /** Lo que se le debe a cada profesional en el periodo (cierre / pago). */
  byStaff: {
    staffId: string;
    staffName: string;
    count: number;
    revenueCents: number;
    commissionCents: number;
    /** Lo que le queda al negocio de lo que vendió: ingresos − comisión. */
    netCents: number;
  }[];
  /** Demanda: servicios y ofertas del periodo, de los más vendidos a los menos. */
  byItem: {
    kind: "service" | "combo";
    itemId: string;
    name: string;
    count: number;
    revenueCents: number;
  }[];
  /** Cuánto entró por cada método (para cuadrar la caja). */
  byPayment: { method: PaymentMethod; count: number; amountCents: number }[];
  rows: SaleRowDto[];
  /** Se alcanzó el tope de filas: los totales cubren TODO, la tabla no. */
  truncated: boolean;
};

export type BoardBooking = {
  id: string;
  kind: "session" | "block";
  status: "agendada" | "realizada" | "no_show" | "cancelada";
  source: "manual" | "ai";
  startUtc: string;
  endUtc: string;
  /** Hora de pared del negocio, `HH:mm`. */
  time: string;
  durationMinutes: number;
  contact: { id: string; name: string } | null;
  staffId: string | null;
  notes: string | null;
  /** El servicio u oferta para el que se agendó (si se indicó). */
  itemName: string | null;
  /** Ya se cobró: no se vuelve a cobrar. */
  sold: boolean;
};

export type BoardSlot = {
  startUtc: string;
  endUtc: string;
  time: string;
  /** Profesionales que atienden en esta franja (activos, de turno). */
  workingStaffIds: string[];
  /**
   * Cupos de la franja: los profesionales de turno. Sin ningún profesional
   * dado de alta vale 1, igual que el motor de disponibilidad.
   */
  capacity: number;
  /** Citas (no bloqueos) que ocupan la franja, asignadas o no. */
  booked: number;
  /** Cupos libres = capacity − booked. 0 si hay un bloqueo. */
  free: number;
  blocked: boolean;
  past: boolean;
};

export type BoardDto = {
  date: string;
  timezone: string;
  slotMinutes: number;
  /** El negocio abre este día. */
  open: boolean;
  chairs: { id: string; name: string }[];
  slots: BoardSlot[];
  bookings: BoardBooking[];
  /** Hora local actual `HH:mm` si el día mostrado es hoy; si no, null. */
  nowTime: string | null;
};

/** Un cliente del salón: un contacto con al menos una venta en Caja. */
export type SalonClientDto = {
  id: string;
  name: string;
  phone: string | null;
  birthdayDay: number | null;
  birthdayMonth: number | null;
  notes: string | null;
  visits: number;
  /** Instante UTC (ISO) de la última venta; `null` si aún no compra. */
  lastVisitAt: string | null;
  totalCents: number;
  /** Instante UTC (ISO) en que se creó el registro; solo se muestra la fecha. */
  registeredAt: string;
};

/**
 * Una coincidencia al escribir el celular o el nombre en Caja o en el alta de un
 * cliente: cualquier contacto de WhatsApp con teléfono, sea ya cliente o no.
 */
export type ContactMatchDto = {
  id: string;
  name: string;
  phone: string;
  birthdayDay: number | null;
  birthdayMonth: number | null;
  /** `true` = ya es cliente; `false` = solo era un contacto (pasará a cliente al cobrarle). */
  salonClient: boolean;
  visits: number;
};

export type ClientHistoryRowDto = {
  id: string;
  /** Instante UTC (ISO). */
  createdAt: string;
  itemKind: "service" | "combo";
  itemName: string;
  staffName: string;
  paymentMethod: PaymentMethod;
  amountCents: number;
};

export type SalonClientDetailDto = {
  client: SalonClientDto;
  /** De la más reciente a la más antigua. */
  history: ClientHistoryRowDto[];
};

/** Un cliente que cumple años este mes. */
export type BirthdayClientDto = {
  id: string;
  name: string;
  phone: string | null;
  day: number;
  visits: number;
  totalCents: number;
};

/** Un punto de la serie de ingresos del Panel. */
export type RevenuePointDto = {
  /** `AAAA-MM-DD` (día o inicio de semana) o `AAAA-MM` (mes), en la zona del negocio. */
  bucket: string;
  revenueCents: number;
  count: number;
};

/** Clientes atendidos en un periodo y cuántos de ellos ya van en 2 o más visitas. */
export type RetentionDto = {
  /** Porcentaje (0-100); `null` si en el periodo no se atendió a ningún cliente identificado. */
  rate: number | null;
  clients: number;
  returning: number;
};

/** El periodo con que se compara el actual, y sus números. */
export type DashboardComparisonDto = {
  /** `month`: el mismo tramo del mes anterior; `previous`: el periodo de igual duración justo antes. */
  kind: "month" | "previous";
  from: string;
  to: string;
  revenueCents: number;
  count: number;
  retentionRate: number | null;
};

/** El panel ejecutivo: reporte del periodo, citas y cumpleaños del mes. */
export type SalonDashboardDto = {
  /** Retención del periodo: clientes atendidos con 2 o más visitas en total. */
  retention: RetentionDto;
  comparison: DashboardComparisonDto;
  /** Ingresos en el tiempo: por día (hasta 31 días), por semana (hasta 92) o por mes. */
  series: { granularity: "day" | "week" | "month"; points: RevenuePointDto[] };
  /** Sin la tabla de ventas (`rows` vacío): el panel solo muestra agregados. */
  report: SalesReportDto;
  /** Citas del periodo; `null` si esta instancia no tiene la agenda. */
  appointments: number | null;
  birthdays: {
    /** Mes actual del negocio (1-12). */
    month: number;
    /** Día de hoy en la zona del negocio, para marcar «hoy». */
    today: number;
    clients: BirthdayClientDto[];
  };
};
