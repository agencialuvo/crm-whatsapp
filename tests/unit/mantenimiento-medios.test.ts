import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hallazgos H y J — el cableado del mantenimiento: la reconciliación es solo informe salvo `MEDIA_RECONCILE_AUTO=on`, corre
 * a lo sumo una vez al día, y el reintento de adjuntos pendientes corre cada 10 minutos sin solaparse.
 */

const m = vi.hoisted(() => ({
  reconciliar: vi.fn(),
  reintentar: vi.fn(),
  limpiar: vi.fn(),
  podar: vi.fn(),
}));

vi.mock("@/server/medios/reconciliar", () => ({ reconciliarMedios: m.reconciliar }));
vi.mock("@/server/medios/reintentar-adjuntos", () => ({ reintentarAdjuntosPendientes: m.reintentar }));
vi.mock("@/server/medios/store", () => ({ limpiarSubidasPendientes: m.limpiar }));
vi.mock("@/server/whatsapp/media-cache", () => ({ pruneWaMediaCache: m.podar }));

const RES_VACIO = { huerfanos: [], borrados: 0, fallidos: 0, bytes: 0, truncado: false, siguienteCursorR2: null, abortado: null };
const ENV_ORIGINAL = { ...process.env };
const DIA = 24 * 3600_000;

async function cargar() {
  vi.resetModules();
  delete (globalThis as { __voceroMediaMaintenance?: unknown }).__voceroMediaMaintenance;
  return import("@/server/medios/mantenimiento");
}

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.reconciliar.mockResolvedValue(RES_VACIO);
  m.reintentar.mockResolvedValue({ revisados: 0, reintentados: 0, recuperados: 0, fallidos: 0, detenido: false });
  m.limpiar.mockResolvedValue(0);
  m.podar.mockResolvedValue(undefined);
  delete process.env.MEDIA_RECONCILE_AUTO;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ENV_ORIGINAL };
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("reconciliación (H)", () => {
  it("por defecto SOLO INFORMA: aplicar=false, y avisa en el log si hay huérfanos", async () => {
    const mt = await cargar();
    m.reconciliar.mockResolvedValue({ ...RES_VACIO, huerfanos: [{ origen: "r2" }, { origen: "disco" }], bytes: 3 * 1_048_576 });
    await mt.tickReconciliacion(new Date());
    expect(m.reconciliar).toHaveBeenCalledTimes(1);
    expect(m.reconciliar.mock.calls[0]![0]).toMatchObject({ aplicar: false });
    expect(m.reconciliar.mock.calls[0]![0]).not.toHaveProperty("maxBorrar");
    const log = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join("\n");
    expect(log).toContain("solo informe");
    expect(log).toContain("2 archivo(s)");
    expect(log).toContain("MEDIA_RECONCILE_AUTO=on");
  });

  it("con MEDIA_RECONCILE_AUTO=on borra, con tope de 100 y solo lo de más de 72 h", async () => {
    process.env.MEDIA_RECONCILE_AUTO = "on";
    const mt = await cargar();
    m.reconciliar.mockResolvedValue({ ...RES_VACIO, borrados: 4, bytes: 2 * 1_048_576 });
    await mt.tickReconciliacion(new Date());
    expect(m.reconciliar.mock.calls[0]![0]).toMatchObject({ aplicar: true, maxBorrar: 100, edadMinimaMs: 72 * 3600_000 });
    expect((console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join("\n")).toContain("4 huérfano(s) borrado(s)");
  });

  it("si la reconciliación se frena por seguridad, lo dice con un aviso (no un error) y no explota", async () => {
    process.env.MEDIA_RECONCILE_AUTO = "on";
    const mt = await cargar();
    m.reconciliar.mockResolvedValue({ ...RES_VACIO, abortado: "las tablas de medios están vacías" });
    await mt.tickReconciliacion(new Date());
    expect((console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join("\n")).toContain("frenada");
  });

  it("si falla (listado o base), se registra y NO lanza", async () => {
    const mt = await cargar();
    m.reconciliar.mockRejectedValue(new Error("R2 caído"));
    await expect(mt.tickReconciliacion(new Date())).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("retoma el listado de R2 donde se quedó la corrida anterior", async () => {
    const mt = await cargar();
    m.reconciliar.mockResolvedValueOnce({ ...RES_VACIO, siguienteCursorR2: "org/x/medios/zzz" });
    await mt.tickReconciliacion(new Date());
    await mt.tickReconciliacion(new Date());
    expect(m.reconciliar.mock.calls[0]![0].cursorR2).toBeNull();
    expect(m.reconciliar.mock.calls[1]![0].cursorR2).toBe("org/x/medios/zzz");
  });

  it("el tick horario NO reconcilia al arrancar: la primera es a las 24 h; después, una por día", async () => {
    const mt = await cargar();
    const ahora = new Date();
    await mt.tickMediaMaintenance(ahora);
    expect(m.reconciliar).not.toHaveBeenCalled();
    expect(m.limpiar).toHaveBeenCalledTimes(1); // lo de siempre sigue corriendo
    await mt.tickMediaMaintenance(new Date(ahora.getTime() + 23 * 3600_000));
    expect(m.reconciliar).not.toHaveBeenCalled();
    await mt.tickMediaMaintenance(new Date(ahora.getTime() + DIA + 1000));
    expect(m.reconciliar).toHaveBeenCalledTimes(1);
    await mt.tickMediaMaintenance(new Date(ahora.getTime() + DIA + 3600_000));
    expect(m.reconciliar).toHaveBeenCalledTimes(1);
  });
});

describe("reintento de adjuntos pendientes (J)", () => {
  it("cada tanda llama al barrido y registra lo recuperado", async () => {
    const mt = await cargar();
    m.reintentar.mockResolvedValue({ revisados: 5, reintentados: 3, recuperados: 2, fallidos: 1, detenido: false });
    await mt.tickAdjuntosPendientes(new Date());
    expect(m.reintentar).toHaveBeenCalledTimes(1);
    expect((console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join("\n")).toContain("2 recuperado(s) de 3");
  });

  it("no se solapa: una tanda en curso hace que otra pasada se salte", async () => {
    const mt = await cargar();
    let soltar!: () => void;
    m.reintentar.mockImplementationOnce(() => new Promise((ok) => (soltar = () => ok({ revisados: 0, reintentados: 0, recuperados: 0, fallidos: 0, detenido: false }))));
    const a = mt.tickAdjuntosPendientes(new Date());
    await mt.tickAdjuntosPendientes(new Date()); // se salta
    expect(m.reintentar).toHaveBeenCalledTimes(1);
    soltar();
    await a;
    await mt.tickAdjuntosPendientes(new Date());
    expect(m.reintentar).toHaveBeenCalledTimes(2);
  });

  it("si falla, se registra y NO lanza (y la siguiente tanda corre)", async () => {
    const mt = await cargar();
    m.reintentar.mockRejectedValueOnce(new Error("BD caída"));
    await expect(mt.tickAdjuntosPendientes(new Date())).resolves.toBeUndefined();
    await mt.tickAdjuntosPendientes(new Date());
    expect(m.reintentar).toHaveBeenCalledTimes(2);
  });

  it("avisa cuando el cortacircuitos detuvo la tanda", async () => {
    const mt = await cargar();
    m.reintentar.mockResolvedValue({ revisados: 9, reintentados: 3, recuperados: 0, fallidos: 3, detenido: true });
    await mt.tickAdjuntosPendientes(new Date());
    expect((console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join("\n")).toContain("se detuvo la tanda");
  });
});

describe("temporizadores", () => {
  it("arranca dos: el horario y el de reintento cada 10 min; arrancar dos veces no duplica", async () => {
    vi.useFakeTimers();
    const mt = await cargar();
    mt.startMediaMaintenance();
    mt.startMediaMaintenance();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(m.reintentar).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(m.reintentar).toHaveBeenCalledTimes(3);
    expect(m.limpiar).not.toHaveBeenCalled(); // el horario aún no (60 min)
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(m.limpiar).toHaveBeenCalledTimes(1);
  });
});
