import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  BULK_COLUMNS,
  BULK_MAX_ROWS,
  BULK_MODULES,
  mediaIdFromUrl,
  normalizeHeader,
  parseClientRow,
  parseServiceRow,
  parseStaffRow,
} from "@/lib/salon/bulk";
import { buildTemplate, readSheet } from "@/server/business/bulk-import";

/** Carga masiva desde Excel: cada fila se valida con el esquema del módulo, y la plantilla se lee a sí misma. */

const MED = "med_abcdefghij0123456789";

describe("encabezados y URLs de Medios", () => {
  it("normaliza encabezados con acentos, mayúsculas y signos", () => {
    expect(normalizeHeader("Duración (min)")).toBe("duracion_min");
    expect(normalizeHeader("  CELULAR ")).toBe("celular");
    expect(normalizeHeader("imagen_url")).toBe("imagen_url");
  });

  it("saca el id del medio de una URL absoluta, de una ruta o del id solo", () => {
    for (const raw of [`https://crm.test/api/medios/${MED}/archivo`, `/api/medios/${MED}/archivo`, MED]) {
      expect(mediaIdFromUrl(raw), raw).toBe(MED);
    }
    expect(mediaIdFromUrl("https://otro.com/foto.png")).toBeNull();
    expect(mediaIdFromUrl("med_corto")).toBeNull();
  });
});

describe("filas de servicios y ofertas", () => {
  const servicio = { tipo: "servicio", nombre: "Corte clásico", precio: "25", duracion_min: "30" };

  it("un servicio válido: precio en soles a centavos, comisión por defecto y activo", () => {
    const r = parseServiceRow(2, { ...servicio, comision_pct: "40", imagen_url: `/api/medios/${MED}/archivo` });
    expect(r.ok && r.data.kind).toBe("servicio");
    expect(r.ok && r.data.input).toMatchObject({ name: "Corte clásico", priceCents: 2500, durationMinutes: 30, defaultCommissionPercentage: 40, active: true });
    expect(r.ok && r.data.imageRef).toBe(MED);
  });

  it("una oferta exige descripción y normaliza su palabra clave", () => {
    const base = { tipo: "Oferta", nombre: "Combo Fresh", precio: "60.50", duracion_min: "75", palabra_clave: "combo fresco!" };
    expect(parseServiceRow(3, base).ok).toBe(false);
    const ok = parseServiceRow(3, { ...base, descripcion: "Corte + barba" });
    expect(ok.ok && ok.data.kind === "oferta" && ok.data.input.keywordTrigger).toBe("COMBO_FRESCO");
    expect(ok.ok && ok.data.input.priceCents).toBe(6050);
  });

  it("reporta fila y columna de cada problema", () => {
    const r = parseServiceRow(7, { tipo: "otro", nombre: "x", precio: "abc", duracion_min: "2", activo: "quizá", imagen_url: "https://x.com/a.png" });
    expect(!r.ok && r.errors.every((e) => e.row === 7)).toBe(true);
    expect(!r.ok && r.errors.map((e) => e.column).sort()).toEqual(["activo", "imagen_url", "precio", "tipo"].sort());
    const duracion = parseServiceRow(8, { ...servicio, duracion_min: "2" });
    expect(!duracion.ok && duracion.errors[0]).toMatchObject({ row: 8, column: "duracion_min" });
  });
});

describe("filas de equipo", () => {
  it("acepta el celular con espacios o con +51 y lo guarda con +51", () => {
    for (const celular of ["912345678", "912 345 678", "+51 912345678", "51912345678"]) {
      const r = parseStaffRow(2, { nombre: "Carlos Mendoza", celular });
      expect(r.ok && r.data.input.phone, celular).toBe("+51912345678");
    }
  });

  it("rechaza números en el nombre, celular corto y porcentaje fuera de rango", () => {
    expect(parseStaffRow(2, { nombre: "Carlos2" }).ok).toBe(false);
    expect(parseStaffRow(2, { nombre: "Carlos", celular: "9123" }).ok).toBe(false);
    expect(parseStaffRow(2, { nombre: "Carlos", comision_pct: "120" }).ok).toBe(false);
    expect(parseStaffRow(2, { nombre: "Carlos", comision_pct: "abc" }).ok).toBe(false);
  });
});

describe("filas de clientes", () => {
  it("un cliente válido, con cumpleaños opcional", () => {
    const r = parseClientRow(2, { nombre: "María Pérez", celular: "987 654 321", cumple_dia: "15", cumple_mes: "8" });
    expect(r.ok && r.data).toMatchObject({ name: "María Pérez", phone: "51987654321", birthdayDay: 15, birthdayMonth: 8 });
  });

  it("celular obligatorio de 9 dígitos, nombre solo letras y cumpleaños completo y real", () => {
    expect(parseClientRow(2, { nombre: "María" }).ok).toBe(false);
    expect(parseClientRow(2, { nombre: "María", celular: "12345" }).ok).toBe(false);
    expect(parseClientRow(2, { nombre: "Ma1ia", celular: "987654321" }).ok).toBe(false);
    expect(parseClientRow(2, { nombre: "María", celular: "987654321", cumple_dia: "15" }).ok).toBe(false);
    expect(parseClientRow(2, { nombre: "María", celular: "987654321", cumple_dia: "31", cumple_mes: "2" }).ok).toBe(false);
  });
});

describe("plantillas .xlsx", () => {
  for (const modulo of BULK_MODULES) {
    it(`${modulo}: la plantilla tiene los encabezados exactos y sus filas de ejemplo son válidas`, async () => {
      const rows = await readSheet(await buildTemplate(modulo), modulo);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const parse = { servicios: parseServiceRow, equipo: parseStaffRow, clientes: parseClientRow }[modulo];
      for (const { row, cells } of rows) {
        const r = parse(row, cells);
        expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
      }
    });
  }

  it("la plantilla trae todas las columnas del módulo en la primera fila", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildTemplate("servicios")) as unknown as ExcelJS.Buffer);
    const headers = (wb.worksheets[0]!.getRow(1).values as ExcelJS.CellValue[]).slice(1);
    expect(headers).toEqual(BULK_COLUMNS.servicios.map((c) => c.key));
    expect(wb.worksheets[1]!.name).toBe("Instrucciones");
  });
});

describe("lectura del archivo", () => {
  async function xlsx(headers: string[], rows: string[][]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Datos");
    ws.addRow(headers);
    for (const r of rows) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it("rechaza lo que no es un .xlsx, vacío o sin filas", async () => {
    await expect(readSheet(Buffer.from("nombre,celular\nAna,987654321"), "clientes")).rejects.toMatchObject({ code: "not_xlsx" });
    await expect(readSheet(Buffer.alloc(0), "clientes")).rejects.toMatchObject({ code: "empty_file" });
    await expect(readSheet(await xlsx(["nombre", "celular"], []), "clientes")).rejects.toMatchObject({ code: "empty_file" });
  });

  it("avisa de las columnas obligatorias que faltan", async () => {
    await expect(readSheet(await xlsx(["nombre"], [["Ana"]]), "clientes")).rejects.toMatchObject({
      code: "missing_columns",
      message: expect.stringContaining("celular"),
    });
  });

  it("acepta encabezados con otras mayúsculas y salta filas vacías", async () => {
    const rows = await readSheet(await xlsx(["Nombre", "CELULAR"], [["Ana", "987654321"], ["", ""], ["Luis", "955123456"]]), "clientes");
    expect(rows.map((r) => r.row)).toEqual([2, 4]);
    expect(rows[0]!.cells).toEqual({ nombre: "Ana", celular: "987654321" });
  });

  it(`tope de ${BULK_MAX_ROWS} filas por archivo`, async () => {
    const many = Array.from({ length: BULK_MAX_ROWS + 1 }, (_, i) => [`Ana${i}`, "987654321"]);
    await expect(readSheet(await xlsx(["nombre", "celular"], many), "clientes")).rejects.toMatchObject({ code: "too_many_rows" });
  });
});
