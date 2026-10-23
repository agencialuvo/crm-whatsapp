import ExcelJS from "exceljs";
import { and, eq, inArray, or } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { normalizeMx } from "@/lib/meta/client";
import { DEFAULT_COMMISSION_PERCENTAGE } from "@/lib/salon/commission";
import {
  BULK_COLUMNS,
  BULK_MAX_BYTES,
  BULK_MAX_ROWS,
  normalizeHeader,
  parseClientRow,
  parseServiceRow,
  parseStaffRow,
  type BulkModule,
  type BulkResult,
  type BulkRowError,
} from "@/lib/salon/bulk";
import { SalonError } from "@/server/business/http";

/**
 * Módulo SALON — carga masiva desde Excel (.xlsx).
 *
 * Tres pasos, siempre en este orden: (1) leer el archivo (peso, formato y filas
 * acotados), (2) validar CADA fila con el esquema Zod del módulo, (3) insertar las
 * filas válidas en lotes dentro de UNA transacción. Una fila mala no frena a las
 * buenas: se reporta con su número de fila y su columna. Todo acotado a la
 * organización; las imágenes solo valen si están en la biblioteca de ESA organización.
 */

const BATCH = 200;

type Cells = Record<string, string>;
type SheetRow = { row: number; cells: Cells };

/* ------------------------------ lectura ------------------------------ */

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
    if ("result" in v) return cellText(v.result as ExcelJS.CellValue);
    if ("text" in v) return String(v.text);
    return "";
  }
  return String(v);
}

/** Lee la primera hoja: encabezados normalizados en la fila 1 y las filas de datos con su número. */
export async function readSheet(buffer: Buffer, module: BulkModule): Promise<SheetRow[]> {
  if (buffer.byteLength === 0) throw new SalonError("empty_file", 422, "El archivo está vacío.");
  if (buffer.byteLength > BULK_MAX_BYTES) {
    throw new SalonError("file_too_large", 422, "El archivo pesa más de 2 MB. Divídelo en partes.");
  }
  // Un .xlsx es un zip: empieza con «PK». Evita procesar otra cosa con extensión cambiada.
  if (buffer.subarray(0, 2).toString("latin1") !== "PK") {
    throw new SalonError("not_xlsx", 422, "El archivo no es un Excel (.xlsx) válido.");
  }
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    throw new SalonError("not_xlsx", 422, "No se pudo leer el archivo. Usa la plantilla en formato .xlsx.");
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new SalonError("empty_file", 422, "El archivo no tiene hojas.");

  const headers: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    headers[col] = normalizeHeader(cellText(cell.value));
  });
  const missing = BULK_COLUMNS[module].filter((c) => c.required && !headers.includes(c.key)).map((c) => c.key);
  if (missing.length > 0) {
    throw new SalonError(
      "missing_columns",
      422,
      `Faltan columnas obligatorias: ${missing.join(", ")}. Descarga la plantilla y no cambies los encabezados.`
    );
  }

  const rows: SheetRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const cells: Cells = {};
    let any = false;
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
      const key = headers[col];
      if (!key) return;
      const text = cellText(cell.value).trim();
      if (text) any = true;
      cells[key] = text;
    });
    if (!any) continue;
    rows.push({ row: r, cells });
    if (rows.length > BULK_MAX_ROWS) {
      throw new SalonError("too_many_rows", 422, `El archivo tiene más de ${BULK_MAX_ROWS} filas. Divídelo en partes.`);
    }
  }
  if (rows.length === 0) {
    throw new SalonError("empty_file", 422, "El archivo no tiene filas con datos debajo de los encabezados.");
  }
  return rows;
}

/* ------------------------------ plantilla ------------------------------ */

const TEXT_COLUMNS = new Set(["celular", "cumple_dia", "cumple_mes", "palabra_clave", "imagen_url", "foto_url"]);

/** La plantilla del módulo: hoja de datos con encabezados exactos y ejemplos, y una hoja de instrucciones. */
export async function buildTemplate(module: BulkModule): Promise<Buffer> {
  const columns = BULK_COLUMNS[module];
  const wb = new ExcelJS.Workbook();
  wb.creator = "CRM";

  const ws = wb.addWorksheet("Datos", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map((c) => ({
    header: c.key,
    key: c.key,
    width: Math.max(14, c.key.length + 4, c.key === "descripcion" ? 36 : 0),
    style: TEXT_COLUMNS.has(c.key) ? { numFmt: "@" } : {},
  }));
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.eachCell((cell, col) => {
    const required = columns[col - 1]?.required;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: required ? "FF0328BA" : "FF64748B" } };
  });
  const exampleCount = columns[0]?.examples.length ?? 0;
  for (let i = 0; i < exampleCount; i++) {
    ws.addRow(Object.fromEntries(columns.map((c) => [c.key, c.examples[i] ?? ""])));
  }
  // Listas desplegables donde el valor es de un conjunto cerrado.
  const listFor = (key: string): string | null =>
    key === "tipo" ? '"servicio,oferta"' : key === "activo" ? '"si,no"' : null;
  columns.forEach((c, idx) => {
    const list = listFor(c.key);
    if (!list) return;
    for (let r = 2; r <= BULK_MAX_ROWS + 1; r++) {
      ws.getCell(r, idx + 1).dataValidation = { type: "list", allowBlank: true, formulae: [list] };
    }
  });

  const help = wb.addWorksheet("Instrucciones");
  help.columns = [
    { header: "Columna", key: "col", width: 18 },
    { header: "Obligatoria", key: "req", width: 13 },
    { header: "Qué escribir", key: "help", width: 70 },
  ];
  help.getRow(1).font = { bold: true };
  for (const c of columns) help.addRow({ col: c.key, req: c.required ? "Sí" : "No", help: c.help });
  help.addRow({});
  help.addRow({ col: "Importante", help: "No cambies los encabezados de la hoja «Datos». Borra las filas de ejemplo antes de subir el archivo." });
  help.addRow({ help: `Máximo ${BULK_MAX_ROWS} filas por archivo.` });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ------------------------------ importación ------------------------------ */

function chunks<T>(items: T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Los ids de imagen (de la biblioteca de ESTA organización, solo imágenes) que existen. */
async function validImageIds(organizationId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await getDb()
    .select({ id: schema.mediaLibraryItem.id })
    .from(schema.mediaLibraryItem)
    .where(
      scoped(
        schema.mediaLibraryItem.organizationId,
        organizationId,
        inArray(schema.mediaLibraryItem.id, ids),
        eq(schema.mediaLibraryItem.kind, "image")
      )
    );
  return new Set(rows.map((r) => r.id));
}

const key = (s: string) => s.trim().toLowerCase();

export async function importServices(organizationId: string, rows: SheetRow[]): Promise<BulkResult> {
  const db = getDb();
  const errors: BulkRowError[] = [];
  const skipped: BulkRowError[] = [];
  const parsed = rows.map((r) => parseServiceRow(r.row, r.cells));
  const good = parsed.flatMap((p) => (p.ok ? [p] : []));
  for (const p of parsed) if (!p.ok) errors.push(...p.errors);

  const [services, combos] = await Promise.all([
    db
      .select({ name: schema.service.name })
      .from(schema.service)
      .where(scoped(schema.service.organizationId, organizationId)),
    db
      .select({ name: schema.combo.name, keyword: schema.combo.keywordTrigger })
      .from(schema.combo)
      .where(scoped(schema.combo.organizationId, organizationId)),
  ]);
  const seenService = new Set(services.map((s) => key(s.name)));
  const seenCombo = new Set(combos.map((c) => key(c.name)));
  const keywords = new Set(combos.flatMap((c) => (c.keyword ? [c.keyword] : [])));
  const images = await validImageIds(
    organizationId,
    good.flatMap((p) => (p.data.imageRef ? [p.data.imageRef] : []))
  );

  const serviceValues: (typeof schema.service.$inferInsert)[] = [];
  const comboValues: (typeof schema.combo.$inferInsert)[] = [];
  for (const p of good) {
    const { data, row } = p;
    if (data.imageRef && !images.has(data.imageRef)) {
      errors.push({ row, column: data.kind === "servicio" ? "imagen_url" : "imagen_url", message: "Esa imagen no está en tu biblioteca de Medios" });
      continue;
    }
    if (data.kind === "servicio") {
      const k = key(data.input.name);
      if (seenService.has(k)) {
        skipped.push({ row, column: "nombre", message: `El servicio «${data.input.name}» ya existe` });
        continue;
      }
      seenService.add(k);
      serviceValues.push({
        id: newId("service"),
        organizationId,
        name: data.input.name,
        description: data.input.description ?? null,
        priceCents: data.input.priceCents,
        durationMinutes: data.input.durationMinutes,
        defaultCommissionPercentage: data.input.defaultCommissionPercentage ?? DEFAULT_COMMISSION_PERCENTAGE,
        active: data.input.active ?? true,
        imageMediaId: data.imageRef,
      });
    } else {
      const k = key(data.input.name);
      if (seenCombo.has(k)) {
        skipped.push({ row, column: "nombre", message: `La oferta «${data.input.name}» ya existe` });
        continue;
      }
      const kw = data.input.keywordTrigger ?? null;
      if (kw && keywords.has(kw)) {
        errors.push({ row, column: "palabra_clave", message: `La palabra clave «${kw}» ya la usa otra oferta` });
        continue;
      }
      seenCombo.add(k);
      if (kw) keywords.add(kw);
      comboValues.push({
        id: newId("combo"),
        organizationId,
        name: data.input.name,
        description: data.input.description,
        priceCents: data.input.priceCents,
        durationMinutes: data.input.durationMinutes,
        keywordTrigger: kw,
        active: data.input.active ?? true,
        imageMediaId: data.imageRef,
      });
    }
  }

  await db.transaction(async (tx) => {
    for (const part of chunks(serviceValues)) await tx.insert(schema.service).values(part);
    for (const part of chunks(comboValues)) await tx.insert(schema.combo).values(part);
  });
  return finish(rows.length, serviceValues.length + comboValues.length, skipped, errors);
}

export async function importStaff(organizationId: string, rows: SheetRow[]): Promise<BulkResult> {
  const db = getDb();
  const errors: BulkRowError[] = [];
  const skipped: BulkRowError[] = [];
  const parsed = rows.map((r) => parseStaffRow(r.row, r.cells));
  const good = parsed.flatMap((p) => (p.ok ? [p] : []));
  for (const p of parsed) if (!p.ok) errors.push(...p.errors);

  const existing = await db
    .select({ name: schema.staff.name })
    .from(schema.staff)
    .where(scoped(schema.staff.organizationId, organizationId));
  const seen = new Set(existing.map((s) => key(s.name)));
  const images = await validImageIds(
    organizationId,
    good.flatMap((p) => (p.data.imageRef ? [p.data.imageRef] : []))
  );

  const values: (typeof schema.staff.$inferInsert)[] = [];
  for (const { data, row } of good) {
    if (data.imageRef && !images.has(data.imageRef)) {
      errors.push({ row, column: "foto_url", message: "Esa imagen no está en tu biblioteca de Medios" });
      continue;
    }
    const k = key(data.input.name);
    if (seen.has(k)) {
      skipped.push({ row, column: "nombre", message: `«${data.input.name}» ya está en el equipo` });
      continue;
    }
    seen.add(k);
    values.push({
      id: newId("staff"),
      organizationId,
      name: data.input.name,
      phone: data.input.phone ?? null,
      active: data.input.active ?? true,
      globalCommissionPercentage: data.input.globalCommissionPercentage ?? null,
      imageMediaId: data.imageRef,
    });
  }
  await db.transaction(async (tx) => {
    for (const part of chunks(values)) await tx.insert(schema.staff).values(part);
  });
  return finish(rows.length, values.length, skipped, errors);
}

/**
 * Clientes. Quien ya es contacto (mismo celular, normalizado) NO se duplica: se
 * marca como cliente. Quien ya es cliente se omite. No se registra una venta: son
 * clientes que el negocio ya tenía (su historial empieza con su próxima venta).
 */
export async function importClients(organizationId: string, rows: SheetRow[]): Promise<BulkResult> {
  const db = getDb();
  const c = schema.contact;
  const errors: BulkRowError[] = [];
  const skipped: BulkRowError[] = [];
  const parsed = rows.map((r) => parseClientRow(r.row, r.cells));
  const good = parsed.flatMap((p) => (p.ok ? [p] : []));
  for (const p of parsed) if (!p.ok) errors.push(...p.errors);

  const phones = good.map((p) => normalizeMx(p.data.phone));
  const found = phones.length
    ? await db
        .select({ id: c.id, waIdentity: c.waIdentity, phone: c.phone, salonClient: c.salonClient })
        .from(c)
        .where(
          scoped(
            c.organizationId,
            organizationId,
            eq(c.channel, "whatsapp"),
            or(inArray(c.waIdentity, phones), inArray(c.phone, phones))
          )
        )
    : [];
  const byPhone = new Map<string, (typeof found)[number]>();
  for (const f of found) {
    if (f.waIdentity) byPhone.set(f.waIdentity, f);
    if (f.phone) byPhone.set(f.phone, f);
  }

  const seenInFile = new Set<string>();
  const inserts: (typeof c.$inferInsert)[] = [];
  const promote: { id: string; day: number | null; month: number | null }[] = [];
  for (const { data, row } of good) {
    const phone = normalizeMx(data.phone);
    if (seenInFile.has(phone)) {
      skipped.push({ row, column: "celular", message: "Ese celular se repite en el archivo" });
      continue;
    }
    seenInFile.add(phone);
    const existing = byPhone.get(phone);
    if (existing) {
      if (existing.salonClient) {
        skipped.push({ row, column: "celular", message: "Ya es cliente" });
      } else {
        promote.push({ id: existing.id, day: data.birthdayDay, month: data.birthdayMonth });
      }
      continue;
    }
    inserts.push({
      id: newId("contact"),
      organizationId,
      name: data.name,
      nameSource: "manual",
      phone,
      waIdentity: phone,
      source: "conocido",
      salonClient: true,
      birthdayDay: data.birthdayDay,
      birthdayMonth: data.birthdayMonth,
      notes: data.notes,
    });
  }

  await db.transaction(async (tx) => {
    for (const part of chunks(inserts)) {
      await tx
        .insert(c)
        .values(part)
        .onConflictDoNothing({ target: [c.organizationId, c.channel, c.waIdentity] });
    }
    for (const p of promote) {
      await tx
        .update(c)
        .set({
          salonClient: true,
          archivedAt: null,
          updatedAt: new Date(),
          ...(p.day != null && p.month != null ? { birthdayDay: p.day, birthdayMonth: p.month } : {}),
        })
        .where(and(eq(c.organizationId, organizationId), eq(c.id, p.id)));
    }
  });
  return finish(rows.length, inserts.length + promote.length, skipped, errors);
}

function finish(total: number, created: number, skipped: BulkRowError[], errors: BulkRowError[]): BulkResult {
  const byRow = (a: BulkRowError, b: BulkRowError) => a.row - b.row;
  return { total, created, skipped: skipped.sort(byRow), errors: errors.sort(byRow) };
}

export async function runImport(organizationId: string, module: BulkModule, buffer: Buffer): Promise<BulkResult> {
  const rows = await readSheet(buffer, module);
  if (module === "servicios") return importServices(organizationId, rows);
  if (module === "equipo") return importStaff(organizationId, rows);
  return importClients(organizationId, rows);
}
