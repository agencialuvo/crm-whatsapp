import { z } from "zod";
import {
  isPersonName,
  normalizeStaffPhone,
  STAFF_PHONE_DIGITS,
  tidyPersonName,
} from "@/lib/salon/staff-fields";

/**
 * Módulo SALON — contratos de entrada (Zod).
 *
 * Los usan los route handlers (`parseBody`, el 422 lleva el detalle) y los
 * formularios del cliente: la misma regla valida en los dos lados, así lo que
 * el formulario deja pasar es lo que la API acepta.
 *
 * Dinero en CENTAVOS ENTEROS. El formulario convierte el texto del dueño con
 * `parseMoneyToCents` (lib/money.ts) antes de llegar aquí.
 */

/** Tope de un monto: S/ 100 000. Una venta mayor es casi seguro un cero de más. */
const MAX_CENTS = 10_000_000;

/** Yape y Plin son un solo método: para la caja es lo mismo (dinero digital en el celular). */
export const PAYMENT_METHODS = ["efectivo", "yape_plin", "tarjeta", "otro"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  efectivo: "Efectivo",
  yape_plin: "Yape / Plin",
  tarjeta: "Tarjeta",
  otro: "Otro",
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const percentage = z
  .number({ invalid_type_error: "Escribe un porcentaje" })
  .int("El porcentaje debe ser un número entero")
  .min(0, "El porcentaje mínimo es 0")
  .max(100, "El porcentaje máximo es 100");

const cents = z
  .number({ invalid_type_error: "Escribe un monto" })
  .int("El monto debe estar en centavos enteros")
  .min(0, "El monto no puede ser negativo")
  .max(MAX_CENTS, "El monto es demasiado grande");

const name = z
  .string({ required_error: "El nombre es obligatorio" })
  .trim()
  .min(2, "El nombre debe tener al menos 2 caracteres")
  .max(80, "El nombre admite hasta 80 caracteres");

/**
 * Texto opcional: vacío ⇒ `null` (se borra), ausente ⇒ `undefined` (no se
 * toca). La diferencia importa en PATCH: un campo que no viaja no se pisa.
 */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, `Admite hasta ${max} caracteres`)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v ? v : null));
}

/**
 * Imagen y profesionales: los dos campos que comparten servicios y ofertas.
 *
 * - `imageMediaId`: id de un medio de la biblioteca (Medios). `null` quita la
 *   imagen; ausente no la toca.
 * - `staffIds`: qué profesionales dan el servicio u oferta. `[]` = TODOS (el
 *   valor por defecto; quita cualquier restricción); ausente no lo toca.
 */
const MEDIA_ID = /^med_[a-z0-9]{20}$/;
const STAFF_ID = /^stf_[a-z0-9]{20}$/;

const imageMediaId = z
  .string()
  .regex(MEDIA_ID, "La imagen no es válida")
  .nullish();

const staffIds = z
  .array(z.string().regex(STAFF_ID, "Profesional no válido"))
  .max(200, "Demasiados profesionales")
  .refine((ids) => new Set(ids).size === ids.length, "Hay un profesional repetido")
  .optional();

/* ------------------------------ servicios ------------------------------ */

export const serviceInputSchema = z.object({
  name,
  description: optionalText(500),
  priceCents: cents,
  durationMinutes: z
    .number({ invalid_type_error: "Escribe la duración" })
    .int("La duración debe ser un número entero de minutos")
    .min(5, "La duración mínima es de 5 minutos")
    .max(600, "La duración máxima es de 600 minutos"),
  /** Qué parte del servicio se queda el profesional si nadie pacta otra. */
  defaultCommissionPercentage: percentage.optional(),
  active: z.boolean().optional(),
  imageMediaId,
  staffIds,
});
export type ServiceInput = z.infer<typeof serviceInputSchema>;

export const servicePatchSchema = serviceInputSchema
  .partial()
  .refine((o) => Object.keys(o).length > 0, "No hay nada que actualizar");

/* ------------------------------- combos -------------------------------- */

/**
 * La palabra clave de un anuncio: MAYÚSCULAS, sin acentos, espacios como `_`,
 * solo `A-Z 0-9 _ -`. "Combo fresco!" → "COMBO_FRESCO". Se guarda así para que
 * dos escrituras del mismo texto sean la MISMA clave (y el índice único la
 * proteja).
 */
export function normalizeKeyword(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Z0-9_-]/g, "");
}

const KEYWORD_MIN = 3;
const KEYWORD_MAX = 40;

const keyword = z
  .string()
  .nullish()
  .transform((v) => (v == null ? v : normalizeKeyword(v) || null))
  .refine(
    (v) => v == null || (v.length >= KEYWORD_MIN && v.length <= KEYWORD_MAX),
    `La palabra clave lleva entre ${KEYWORD_MIN} y ${KEYWORD_MAX} caracteres (letras, números, _ o -)`
  );

export const comboInputSchema = z.object({
  name,
  description: z
    .string({ required_error: "Cuenta qué incluye la oferta" })
    .trim()
    .min(3, "Cuenta qué incluye la oferta")
    .max(500, "Admite hasta 500 caracteres"),
  priceCents: cents,
  durationMinutes: serviceInputSchema.shape.durationMinutes,
  keywordTrigger: keyword,
  active: z.boolean().optional(),
  imageMediaId,
  staffIds,
});
export type ComboInput = z.infer<typeof comboInputSchema>;

export const comboPatchSchema = comboInputSchema
  .partial()
  .refine((o) => Object.keys(o).length > 0, "No hay nada que actualizar");

/* ------------------------------- equipo -------------------------------- */

/** Solo letras (con tildes y ñ) y espacios; los espacios se ordenan solos. */
const staffName = z
  .string({ required_error: "El nombre es obligatorio" })
  .transform(tidyPersonName)
  .pipe(
    z
      .string()
      .min(2, "El nombre debe tener al menos 2 caracteres")
      .max(80, "El nombre admite hasta 80 caracteres")
      .refine(isPersonName, "El nombre solo admite letras y espacios (sin números ni signos)")
  );

/**
 * Celular: opcional, pero si se escribe son EXACTAMENTE 9 dígitos (solo números),
 * con el +51 de Perú fijo. Vacío ⇒ `null` (se borra), ausente ⇒ `undefined` (no se
 * toca). Se guarda como `+51987654321`.
 */
const phone = z
  .string()
  .nullish()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    const text = (v ?? "").trim();
    if (!text) return null;
    const normalized = normalizeStaffPhone(text);
    if (!normalized) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `El celular debe tener exactamente ${STAFF_PHONE_DIGITS} dígitos, solo números`,
      });
      return z.NEVER;
    }
    return normalized;
  });

export const staffInputSchema = z.object({
  name: staffName,
  phone,
  active: z.boolean().optional(),
  /** `null` = sin porcentaje propio: manda el del servicio o el 50 %. */
  globalCommissionPercentage: percentage.nullable().optional(),
  /** Foto de la biblioteca de Medios; `null` la quita, ausente no la toca. */
  imageMediaId,
});
export type StaffInput = z.infer<typeof staffInputSchema>;

export const staffPatchSchema = staffInputSchema
  .partial()
  .refine((o) => Object.keys(o).length > 0, "No hay nada que actualizar");

export const DAY_NAMES = [
  "Domingo",
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
] as const;

export const scheduleDaySchema = z
  .object({
    /** 0 = domingo … 6 = sábado (como `staff_schedule.day_of_week`). */
    dayOfWeek: z.number().int().min(0).max(6),
    /** Día libre: no atiende aunque el negocio abra. */
    isOff: z.boolean(),
    startTime: z.string().regex(HHMM, "Hora no válida (HH:mm)"),
    endTime: z.string().regex(HHMM, "Hora no válida (HH:mm)"),
  })
  .superRefine((d, ctx) => {
    if (!d.isOff && d.startTime >= d.endTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message: `${DAY_NAMES[d.dayOfWeek]}: la hora de salida debe ser después de la de entrada`,
      });
    }
  });
export type ScheduleDay = z.infer<typeof scheduleDaySchema>;

/**
 * El horario se REEMPLAZA completo. Un día sin fila sigue el horario del
 * negocio; solo se guardan los días libres y los de horario propio.
 */
export const scheduleInputSchema = z.object({
  days: z
    .array(scheduleDaySchema)
    .max(7)
    .refine(
      (days) => new Set(days.map((d) => d.dayOfWeek)).size === days.length,
      "Hay un día repetido en el horario"
    ),
});
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

export const commissionOverridesSchema = z.object({
  overrides: z
    .array(z.object({ serviceId: z.string().min(1), percentage }))
    .max(500)
    .refine(
      (rows) => new Set(rows.map((r) => r.serviceId)).size === rows.length,
      "Hay un servicio repetido en las comisiones"
    ),
});
export type CommissionOverridesInput = z.infer<typeof commissionOverridesSchema>;

/* -------------------------------- caja --------------------------------- */

const birthdayDay = z.number().int().min(1, "Día no válido").max(31, "Día no válido");
const birthdayMonth = z.number().int().min(1, "Mes no válido").max(12, "Mes no válido");

/** Cumpleaños: día y mes juntos (o ninguno) y una fecha que exista. */
function checkBirthday(
  v: { birthdayDay?: number | null; birthdayMonth?: number | null },
  ctx: z.RefinementCtx
): void {
  const { birthdayDay: day, birthdayMonth: month } = v;
  if ((day == null) !== (month == null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [day == null ? "birthdayDay" : "birthdayMonth"],
      message: "Indica el día y el mes del cumpleaños",
    });
  } else if (day != null && month != null && day > daysInMonth(month)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["birthdayDay"],
      message: "Ese día no existe en ese mes",
    });
  }
}

/** Días de un mes en año bisiesto (el 29 de febrero es un cumpleaños válido). */
function daysInMonth(month: number): number {
  return new Date(Date.UTC(2000, month, 0)).getUTCDate();
}

/** Qué fue en concreto un cobro «Otro» (se ve en Caja y en el historial del cliente). */
export const OTHER_NOTE_MAX = 80;
const otherNote = z
  .string()
  .trim()
  .max(OTHER_NOTE_MAX, `Máximo ${OTHER_NOTE_MAX} caracteres`)
  .nullish();
const OTHER_NOTE_REQUIRED = "Escribe qué servicio u oferta es";

/** Un ítem del carrito de una venta: un servicio, una oferta o «Otro» con su precio. */
export const saleItemSchema = z
  .object({
    serviceId: z.string().min(1).nullish(),
    comboId: z.string().min(1).nullish(),
    other: z.boolean().optional(),
    /** Solo «Otro»: lo que se cobra por ese ítem; el resto sale del catálogo. */
    amountCents: cents.optional(),
    /** Solo «Otro»: obligatoria, dice qué se vendió. */
    note: otherNote,
  })
  .superRefine((v, ctx) => {
    if (v.other && !v.note?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["note"], message: OTHER_NOTE_REQUIRED });
    }
    if ([v.serviceId, v.comboId, v.other].filter(Boolean).length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["serviceId"],
        message: "Elige un servicio o una oferta (uno solo)",
      });
    }
    if (v.other && !(typeof v.amountCents === "number" && v.amountCents > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountCents"],
        message: "Escribe el precio cobrado",
      });
    }
  });
export type SaleItemInput = z.infer<typeof saleItemSchema>;

export const saleInputSchema = z
  .object({
    /** Un contacto del CRM… */
    contactId: z.string().min(1).nullish(),
    /** …o un nombre suelto (cliente de mostrador). */
    customerName: z
      .string()
      .trim()
      .max(80)
      .refine((v) => v === "" || isPersonName(tidyPersonName(v)), "El nombre solo admite letras y espacios (sin números ni signos)")
      .nullish(),
    /** Celular del cliente, en dígitos y con código de país. Opcional. */
    customerPhone: z
      .string()
      .trim()
      .regex(/^\d{7,15}$/, "Celular en dígitos, con código de país (ej. 51987654321)")
      .nullish(),
    /** Cumpleaños (día y mes, sin año). Se piden juntos o ninguno. */
    birthdayDay: birthdayDay.nullish(),
    birthdayMonth: birthdayMonth.nullish(),
    staffId: z.string({ required_error: "Elige quién atendió" }).min(1, "Elige quién atendió"),
    /**
     * Lo vendido: uno o varios servicios u ofertas (el carrito). Sin `items`, vale la
     * forma de un solo ítem (`serviceId` / `comboId` / `other`), que sigue funcionando.
     */
    items: z.array(saleItemSchema).min(1, "Agrega al menos un servicio u oferta").max(20, "Máximo 20 ítems por venta").optional(),
    serviceId: z.string().min(1).nullish(),
    comboId: z.string().min(1).nullish(),
    /** «Otro»: un cobro a criterio; el monto lo escribe quien vende. */
    other: z.boolean().optional(),
    /** «Otro» en la forma de un solo ítem: qué se vendió. */
    otherNote,
    /** Día de la venta (AAAA-MM-DD, del negocio); sin él, ahora. Puede ser pasado o futuro. */
    soldOn: z.string().regex(ISO_DATE, "Fecha no válida").nullish(),
    /** La cita que se está cobrando, si nació de una. */
    bookingId: z.string().min(1).nullish(),
    /** El total REALMENTE cobrado de toda la venta (puede diferir de la suma de los precios de lista). */
    amountCents: cents,
    paymentMethod: z.enum(PAYMENT_METHODS, {
      errorMap: () => ({ message: "Elige el método de pago" }),
    }),
    /** Porcentaje puntual para esta venta; sin él manda la regla de siempre. */
    customCommissionPercentage: percentage.nullish(),
    /** Se aplicó el descuento de cumpleaños (20%): la venta no suma sello de fidelidad. */
    birthdayDiscount: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    const legacy = [v.serviceId, v.comboId, v.other].filter(Boolean).length;
    if (v.items) {
      if (legacy > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items"],
          message: "Usa los ítems o un solo servicio, no los dos",
        });
      }
    } else {
      if (v.other && !v.otherNote?.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["otherNote"], message: OTHER_NOTE_REQUIRED });
      }
      if (v.other && !(v.amountCents > 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["amountCents"],
          message: "Escribe el precio cobrado",
        });
      }
      if (legacy !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["serviceId"],
          message: "Elige un servicio o una oferta (uno solo)",
        });
      }
    }
    checkBirthday(v, ctx);
  });
export type SaleInput = z.infer<typeof saleInputSchema>;

/** Los ítems de una venta, venga con carrito o en la forma de un solo ítem. */
export function saleItemsOf(input: SaleInput): SaleItemInput[] {
  if (input.items) return input.items;
  return [
    {
      serviceId: input.serviceId ?? null,
      comboId: input.comboId ?? null,
      other: input.other ?? false,
      amountCents: input.other ? input.amountCents : undefined,
      note: input.other ? input.otherNote : undefined,
    },
  ];
}

/** Nombre opcional: vacío ⇒ `null`; si se escribe, las mismas reglas que el de un profesional. */
const optionalPersonName = z
  .string()
  .nullish()
  .transform((v) => (v?.trim() ? v : null))
  .pipe(staffName.nullable());

/** Celular de Perú opcional: vacío ⇒ `null`; si se escribe, 51 + exactamente 9 dígitos. */
const optionalPeruPhone = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null))
  .pipe(
    z
      .string()
      .regex(/^51\d{9}$/, "El celular debe tener exactamente 9 dígitos, solo números")
      .nullable()
  );

const clientFields = {
    // Solo letras y espacios (mismas reglas que el nombre de un profesional).
    name: staffName,
    // Celular de Perú: 51 + exactamente 9 dígitos. Opcional: sin él, el cliente no tiene WhatsApp.
    phone: optionalPeruPhone,
    birthdayDay: birthdayDay.nullish().transform((v) => v ?? null),
    birthdayMonth: birthdayMonth.nullish().transform((v) => v ?? null),
    notes: z
      .string()
      .trim()
      .max(500, "Máximo 500 caracteres")
      .nullish()
      .transform((v) => (v ? v : null)),
};

/**
 * Edición de un cliente del salón (reemplaza todos los campos). El celular va
 * con el código de país de Perú (`51987654321`).
 */
export const clientInputSchema = z
  .object(clientFields)
  .superRefine((v, ctx) => checkBirthday(v, ctx));
/** Lo que llega a la API (los opcionales pueden faltar; el esquema los vuelve `null`). */
export type ClientInput = z.input<typeof clientInputSchema>;

/**
 * Alta de un cliente. Regla: un cliente siempre ha adquirido un servicio, así
 * que el alta trae su primera compra con la misma forma que una venta de Caja:
 * el carrito de servicios y ofertas (con «Otro» y su detalle), quién atendió, el
 * total cobrado, cómo pagó y, si quien la registra lo decide, una comisión puntual.
 */
export const clientCreateSchema = z
  .object({
    ...clientFields,
    // En el alta, el nombre también es opcional: sin nombre ni celular es una venta de mostrador.
    name: optionalPersonName,
    items: z
      .array(saleItemSchema, { required_error: "Agrega al menos un servicio u oferta" })
      .min(1, "Agrega al menos un servicio u oferta")
      .max(20, "Máximo 20 ítems por venta"),
    /** El total REALMENTE cobrado (suma de los ítems o lo que se editó a mano). */
    amountCents: cents,
    /** Día de la atención (AAAA-MM-DD, del negocio); sin él, hoy. */
    soldOn: z.string().regex(ISO_DATE, "Fecha no válida").nullish(),
    staffId: z.string({ required_error: "Elige quién atendió" }).min(1, "Elige quién atendió"),
    paymentMethod: z.enum(PAYMENT_METHODS, {
      errorMap: () => ({ message: "Elige el método de pago" }),
    }),
    /** Porcentaje puntual para esta venta; sin él manda la regla de siempre. */
    customCommissionPercentage: percentage.nullish(),
  })
  .superRefine((v, ctx) => checkBirthday(v, ctx));
export type ClientCreateInput = z.input<typeof clientCreateSchema>;

/** Eliminar varios clientes a la vez (la barra de acciones masivas). */
export const clientBulkDeleteSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1, "Elige al menos un cliente")
    .max(200, "Máximo 200 clientes a la vez")
    .refine((ids) => new Set(ids).size === ids.length, "Hay un cliente repetido"),
});

/** Eliminar varios servicios u ofertas a la vez (la barra de acciones masivas del catálogo). */
export const catalogBulkDeleteSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1, "Elige al menos un elemento")
    .max(200, "Máximo 200 a la vez")
    .refine((ids) => new Set(ids).size === ids.length, "Hay un elemento repetido"),
});

/**
 * Corregir una venta ya registrada: los ítems vendidos, quién atendió, el monto
 * cobrado y, si hace falta, el cliente y la fecha y hora. El método de pago no
 * se edita aquí. `contactId`, `soldOn` y `soldTime` son opcionales: sin ellos, el
 * cliente y el momento de la venta quedan como estaban.
 */
export const saleEditSchema = z
  .object({
    items: z
      .array(saleItemSchema, { required_error: "Agrega al menos un servicio u oferta" })
      .min(1, "Agrega al menos un servicio u oferta")
      .max(20, "Máximo 20 ítems por venta"),
    staffId: z.string({ required_error: "Elige quién atendió" }).min(1, "Elige quién atendió"),
    amountCents: cents,
    /** Porcentaje puntual para esta venta; sin él manda la regla de siempre. */
    customCommissionPercentage: percentage.nullish(),
    /** Otro cliente (contacto de la organización); sin él, el de siempre. */
    contactId: z.string().min(1, "Elige al cliente").nullish(),
    /** Día de la venta (AAAA-MM-DD, del negocio); va junto con `soldTime`. */
    soldOn: z.string().regex(ISO_DATE, "Fecha no válida").nullish(),
    /** Hora de la venta (HH:MM, del negocio). */
    soldTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Hora no válida (HH:MM)")
      .nullish(),
  })
  .superRefine((v, ctx) => {
    if (!v.soldOn !== !v.soldTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [v.soldOn ? "soldTime" : "soldOn"],
        message: "Indica la fecha y la hora",
      });
    }
  });
export type SaleEditInput = z.infer<typeof saleEditSchema>;

/** Corregir el día de una venta registrada con fecha equivocada. */
export const saleDatePatchSchema = z.object({
  soldOn: z
    .string({ required_error: "Elige la fecha" })
    .regex(ISO_DATE, "Fecha no válida (AAAA-MM-DD)"),
});
export type SaleDatePatch = z.infer<typeof saleDatePatchSchema>;

/* ------------------------------- agenda -------------------------------- */

export const boardQuerySchema = z.object({
  date: z.string().regex(ISO_DATE, "Fecha no válida (AAAA-MM-DD)").optional(),
});

/** Asignar (o quitar con `null`) el profesional de una cita. */
/** Agendar una cita desde la agenda por sillas: cliente + hora + profesional. */
export const newBoardBookingSchema = z
  .object({
  contactId: z.string({ required_error: "Elige al cliente" }).min(1, "Elige al cliente"),
  /** El servicio u oferta (uno solo): de él salen la duración y quién puede atender. */
  serviceId: z.string().min(1).nullish(),
  comboId: z.string().min(1).nullish(),
  startUtc: z
    .string({ required_error: "Elige la hora" })
    .refine((v) => !Number.isNaN(Date.parse(v)), "La hora no es válida"),
  staffId: z.string().min(1).nullable().default(null),
  notes: z
    .string()
    .trim()
    .max(500, "Admite hasta 500 caracteres")
    .nullish()
    .transform((v) => (v ? v : null)),
  })
  .superRefine((v, ctx) => {
    if (!v.serviceId === !v.comboId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["serviceId"],
        message: "Elige el servicio u oferta",
      });
    }
  });

/** «Crear cliente rápido» desde Citas: solo nombre y celular. */
export const quickContactSchema = z.object({
  name: staffName,
  phone: z
    .string({ required_error: "Escribe el celular" })
    .trim()
    .regex(/^51\d{9}$/, "El celular debe tener exactamente 9 dígitos, solo números"),
});
export type QuickContactInput = z.infer<typeof quickContactSchema>;
export type NewBoardBookingInput = z.infer<typeof newBoardBookingSchema>;

export const assignStaffSchema = z.object({
  staffId: z.string().min(1).nullable(),
});
