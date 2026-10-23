import {
  clientInputSchema,
  comboInputSchema,
  normalizeKeyword,
  serviceInputSchema,
  staffInputSchema,
  type ComboInput,
  type ServiceInput,
  type StaffInput,
} from "@/lib/salon/schemas";
import { parseMoneyToCents } from "@/lib/money";

/**
 * Módulo SALON — carga masiva desde Excel: qué columnas tiene cada plantilla y
 * cómo se valida una fila. Sin dependencias del servidor ni de `exceljs`, para
 * que el cliente muestre las columnas y las pruebas validen filas sin tocar
 * archivos ni base de datos.
 *
 * Cada fila se valida con el MISMO esquema Zod que el formulario del módulo, así
 * lo que entra por Excel cumple exactamente las reglas de lo que se escribe a mano.
 */

export const BULK_MODULES = ["servicios", "equipo", "clientes"] as const;
export type BulkModule = (typeof BULK_MODULES)[number];

/** Tope de filas de datos por archivo, y de peso del archivo. */
export const BULK_MAX_ROWS = 500;
export const BULK_MAX_BYTES = 2 * 1024 * 1024;

export type BulkColumn = {
  /** Clave interna (y encabezado de la plantilla, ya sin acentos). */
  key: string;
  required: boolean;
  /** Qué escribir en la columna. */
  help: string;
  /** Un ejemplo por fila de ejemplo de la plantilla. */
  examples: string[];
};

export const BULK_TITLES: Record<BulkModule, string> = {
  servicios: "Servicios y ofertas",
  equipo: "Equipo",
  clientes: "Clientes",
};

/** El nombre del archivo de la plantilla de cada módulo. */
export const BULK_FILENAMES: Record<BulkModule, string> = {
  servicios: "plantilla-servicios-y-ofertas.xlsx",
  equipo: "plantilla-equipo.xlsx",
  clientes: "plantilla-clientes.xlsx",
};

export const BULK_COLUMNS: Record<BulkModule, BulkColumn[]> = {
  servicios: [
    { key: "tipo", required: true, help: "servicio u oferta", examples: ["servicio", "oferta"] },
    { key: "nombre", required: true, help: "2 a 80 caracteres", examples: ["Corte clásico", "Combo Fresh"] },
    {
      key: "descripcion",
      required: false,
      help: "Obligatoria en las ofertas (qué incluye); opcional en servicios",
      examples: ["Corte con máquina y tijera", "Corte + barba + mascarilla"],
    },
    { key: "precio", required: true, help: "En soles, ej. 25 o 25.50", examples: ["25", "60"] },
    { key: "duracion_min", required: true, help: "Minutos, de 5 a 600", examples: ["30", "75"] },
    {
      key: "comision_pct",
      required: false,
      help: "Solo servicios: % para el profesional (0 a 100). Vacío: 50",
      examples: ["50", ""],
    },
    {
      key: "palabra_clave",
      required: false,
      help: "Solo ofertas: la palabra del anuncio (3 a 40 letras, sin espacios)",
      examples: ["", "COMBO_FRESH"],
    },
    { key: "activo", required: false, help: "si o no. Vacío: si", examples: ["si", "si"] },
    {
      key: "imagen_url",
      required: false,
      help: "Pega aquí la URL copiada desde Medios (opcional)",
      examples: ["", ""],
    },
  ],
  equipo: [
    { key: "nombre", required: true, help: "Solo letras y espacios", examples: ["Carlos Mendoza", "Ana Torres"] },
    { key: "celular", required: false, help: "9 dígitos, sin el +51", examples: ["912345678", ""] },
    {
      key: "comision_pct",
      required: false,
      help: "% de comisión del profesional (0 a 100). Vacío: manda el del servicio",
      examples: ["50", ""],
    },
    { key: "activo", required: false, help: "si o no. Vacío: si", examples: ["si", "si"] },
    {
      key: "foto_url",
      required: false,
      help: "Pega aquí la URL copiada desde Medios (opcional)",
      examples: ["", ""],
    },
  ],
  clientes: [
    { key: "nombre", required: true, help: "Solo letras y espacios", examples: ["María Pérez", "Luis Ramos"] },
    { key: "celular", required: true, help: "9 dígitos, sin el +51", examples: ["987654321", "955123456"] },
    { key: "cumple_dia", required: false, help: "Día del cumpleaños, 1 a 31 (con el mes)", examples: ["15", ""] },
    { key: "cumple_mes", required: false, help: "Mes del cumpleaños, 1 a 12 (con el día)", examples: ["8", ""] },
    { key: "notas", required: false, help: "Hasta 500 caracteres", examples: ["Prefiere corte bajo", ""] },
  ],
};

/** Encabezado sin acentos, en minúsculas y con `_`: «Duración (min)» → «duracion_min». */
export function normalizeHeader(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export type BulkRowError = { row: number; column?: string; message: string };

/** Lo que responde la importación: cuántas entraron y qué pasó con las que no. */
export type BulkResult = {
  total: number;
  created: number;
  /** Filas que no se importaron porque ya existían (o se repiten en el archivo). */
  skipped: BulkRowError[];
  errors: BulkRowError[];
};

export type ParsedRow<T> =
  | { ok: true; row: number; data: T }
  | { ok: false; row: number; errors: BulkRowError[] };

/** El id de un medio de la biblioteca dentro de lo que se pegó (URL absoluta, ruta o el id solo). */
export function mediaIdFromUrl(raw: string): string | null {
  const m = raw.match(/\bmed_[a-z0-9]{20}\b/);
  return m ? m[0] : null;
}

const YES = new Set(["si", "sí", "s", "yes", "y", "1", "true", "activo", "x"]);
const NO = new Set(["no", "n", "0", "false", "inactivo"]);

/** `si`/`no` (vacío ⇒ `fallback`); `null` si no se entiende. */
function parseBool(raw: string, fallback: boolean): boolean | null {
  const v = raw.trim().toLowerCase();
  if (v === "") return fallback;
  if (YES.has(v)) return true;
  if (NO.has(v)) return false;
  return null;
}

function parseInteger(raw: string): number | null {
  const v = raw.trim().replace(",", ".");
  if (v === "" || !/^-?\d+(\.0+)?$/.test(v)) return null;
  return Number(v.replace(/\.0+$/, ""));
}

/** Los dígitos del celular: acepta «912 345 678», «+51 912345678», «51912345678». */
function phoneDigits9(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  if (d.length === 9) return d;
  if (d.length === 11 && d.startsWith("51")) return d.slice(2);
  return null;
}

type Cells = Record<string, string>;

function zodErrors(row: number, issues: { path: (string | number)[]; message: string }[], map: Record<string, string>): BulkRowError[] {
  return issues.map((i) => ({ row, column: map[String(i.path[0] ?? "")], message: i.message }));
}

/** Una fila de «Servicios y ofertas»: servicio u oferta según la columna `tipo`. */
export type ServiceRow = { kind: "servicio"; input: ServiceInput; imageRef: string | null } | { kind: "oferta"; input: ComboInput; imageRef: string | null };

export function parseServiceRow(row: number, c: Cells): ParsedRow<ServiceRow> {
  const errors: BulkRowError[] = [];
  const tipo = (c.tipo ?? "").trim().toLowerCase();
  const kind = tipo === "servicio" ? "servicio" : tipo === "oferta" ? "oferta" : null;
  if (!kind) errors.push({ row, column: "tipo", message: "Escribe «servicio» u «oferta»" });

  const priceCents = parseMoneyToCents(c.precio ?? "");
  if (priceCents === null) errors.push({ row, column: "precio", message: "Escribe el precio en soles (ej. 25 o 25.50)" });
  const duration = parseInteger(c.duracion_min ?? "");
  if (duration === null) errors.push({ row, column: "duracion_min", message: "Escribe la duración en minutos (número entero)" });
  const active = parseBool(c.activo ?? "", true);
  if (active === null) errors.push({ row, column: "activo", message: "Escribe «si» o «no»" });

  let imageRef: string | null = null;
  const imagen = (c.imagen_url ?? "").trim();
  if (imagen) {
    imageRef = mediaIdFromUrl(imagen);
    if (!imageRef) errors.push({ row, column: "imagen_url", message: "La imagen debe ser una URL copiada desde Medios" });
  }

  if (!kind || priceCents === null || duration === null || active === null) {
    return { ok: false, row, errors };
  }

  const names = { name: "nombre", description: "descripcion", priceCents: "precio", durationMinutes: "duracion_min", defaultCommissionPercentage: "comision_pct", keywordTrigger: "palabra_clave" };
  if (kind === "servicio") {
    const pctRaw = (c.comision_pct ?? "").trim();
    const pct = pctRaw === "" ? undefined : parseInteger(pctRaw);
    if (pct === null) errors.push({ row, column: "comision_pct", message: "El porcentaje debe ser un número entero de 0 a 100" });
    const parsed = serviceInputSchema.safeParse({
      name: c.nombre ?? "",
      description: (c.descripcion ?? "").trim() || null,
      priceCents,
      durationMinutes: duration,
      defaultCommissionPercentage: pct === null ? undefined : pct,
      active,
    });
    if (!parsed.success) errors.push(...zodErrors(row, parsed.error.issues, names));
    if (errors.length > 0 || !parsed.success) return { ok: false, row, errors };
    return { ok: true, row, data: { kind, input: parsed.data, imageRef } };
  }

  const kw = (c.palabra_clave ?? "").trim();
  const parsed = comboInputSchema.safeParse({
    name: c.nombre ?? "",
    description: c.descripcion ?? "",
    priceCents,
    durationMinutes: duration,
    keywordTrigger: kw ? normalizeKeyword(kw) : null,
    active,
  });
  if (!parsed.success) errors.push(...zodErrors(row, parsed.error.issues, names));
  if (errors.length > 0 || !parsed.success) return { ok: false, row, errors };
  return { ok: true, row, data: { kind, input: parsed.data, imageRef } };
}

export type StaffRowData = { input: StaffInput; imageRef: string | null };

export function parseStaffRow(row: number, c: Cells): ParsedRow<StaffRowData> {
  const errors: BulkRowError[] = [];
  const celular = (c.celular ?? "").trim();
  let phone: string | null = null;
  if (celular) {
    phone = phoneDigits9(celular);
    if (!phone) errors.push({ row, column: "celular", message: "El celular debe tener exactamente 9 dígitos" });
  }
  const pctRaw = (c.comision_pct ?? "").trim();
  const pct = pctRaw === "" ? null : parseInteger(pctRaw);
  if (pctRaw !== "" && pct === null) errors.push({ row, column: "comision_pct", message: "El porcentaje debe ser un número entero de 0 a 100" });
  const active = parseBool(c.activo ?? "", true);
  if (active === null) errors.push({ row, column: "activo", message: "Escribe «si» o «no»" });

  let imageRef: string | null = null;
  const foto = (c.foto_url ?? "").trim();
  if (foto) {
    imageRef = mediaIdFromUrl(foto);
    if (!imageRef) errors.push({ row, column: "foto_url", message: "La foto debe ser una URL copiada desde Medios" });
  }

  const parsed = staffInputSchema.safeParse({
    name: c.nombre ?? "",
    phone,
    active: active ?? true,
    globalCommissionPercentage: pct,
  });
  if (!parsed.success) errors.push(...zodErrors(row, parsed.error.issues, { name: "nombre", phone: "celular", globalCommissionPercentage: "comision_pct" }));
  if (errors.length > 0 || !parsed.success) return { ok: false, row, errors };
  return { ok: true, row, data: { input: parsed.data, imageRef } };
}

export type ClientRowData = {
  name: string;
  /** `51` + 9 dígitos. */
  phone: string;
  birthdayDay: number | null;
  birthdayMonth: number | null;
  notes: string | null;
};

export function parseClientRow(row: number, c: Cells): ParsedRow<ClientRowData> {
  const errors: BulkRowError[] = [];
  const digits = phoneDigits9(c.celular ?? "");
  if (!digits) errors.push({ row, column: "celular", message: "El celular debe tener exactamente 9 dígitos" });

  const diaRaw = (c.cumple_dia ?? "").trim();
  const mesRaw = (c.cumple_mes ?? "").trim();
  const dia = diaRaw === "" ? null : parseInteger(diaRaw);
  const mes = mesRaw === "" ? null : parseInteger(mesRaw);
  if (diaRaw !== "" && dia === null) errors.push({ row, column: "cumple_dia", message: "El día debe ser un número" });
  if (mesRaw !== "" && mes === null) errors.push({ row, column: "cumple_mes", message: "El mes debe ser un número" });

  const parsed = clientInputSchema.safeParse({
    name: c.nombre ?? "",
    phone: digits ? `51${digits}` : "",
    birthdayDay: dia,
    birthdayMonth: mes,
    notes: (c.notas ?? "").trim() || null,
  });
  if (!parsed.success) {
    // El celular ya se avisó arriba: no se repite el mismo problema con el mensaje del esquema.
    const issues = parsed.error.issues.filter((i) => !(i.path[0] === "phone" && !digits));
    errors.push(...zodErrors(row, issues, { name: "nombre", phone: "celular", birthdayDay: "cumple_dia", birthdayMonth: "cumple_mes", notes: "notas" }));
  }
  if (errors.length > 0 || !parsed.success) return { ok: false, row, errors };
  const d = parsed.data;
  // En la carga masiva el nombre y el celular siguen siendo obligatorios (una fila sin ellos no se puede identificar).
  if (!d.name || !d.phone) {
    if (!d.name) errors.push({ row, column: "nombre", message: "Escribe el nombre" });
    return { ok: false, row, errors };
  }
  return {
    ok: true,
    row,
    data: {
      name: d.name,
      phone: d.phone,
      birthdayDay: d.birthdayDay,
      birthdayMonth: d.birthdayMonth,
      notes: d.notes,
    },
  };
}
