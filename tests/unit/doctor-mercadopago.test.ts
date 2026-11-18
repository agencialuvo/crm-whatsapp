import { describe, expect, it, vi } from "vitest";
import { checkMercadoPago } from "@/server/doctor/checks";

describe("pnpm doctor — Mercado Pago", () => {
  it("apagado: se omite y no llama a nadie", async () => {
    const whoAmI = vi.fn();
    const r = await checkMercadoPago({}, { whoAmI });
    expect(r[0]).toMatchObject({ status: "skip" });
    expect(whoAmI).not.toHaveBeenCalled();
  });
  it("encendido sin token ni secreto: dos ✗ y no llama a la API", async () => {
    const whoAmI = vi.fn();
    const r = await checkMercadoPago({ MERCADOPAGO: "on" }, { whoAmI });
    expect(r.filter((x) => x.status === "fail")).toHaveLength(2);
    expect(whoAmI).not.toHaveBeenCalled();
  });
  it("un REEMPLAZA_ cuenta como no definido", async () => {
    const r = await checkMercadoPago({ MERCADOPAGO: "on", MP_ACCESS_TOKEN: "REEMPLAZA_X", MP_WEBHOOK_SECRET: "s" }, { whoAmI: vi.fn() });
    expect(r.find((x) => x.label === "MP_ACCESS_TOKEN")?.status).toBe("fail");
  });
  it("con todo definido valida el token y NUNCA lo imprime", async () => {
    const r = await checkMercadoPago({ MERCADOPAGO: "on", MP_ACCESS_TOKEN: "APP_USR-secreto", MP_WEBHOOK_SECRET: "clave" }, { whoAmI: async () => ({ id: 42, site_id: "MPE" }) });
    expect(r.every((x) => x.status === "ok")).toBe(true);
    expect(JSON.stringify(r)).not.toContain("APP_USR-secreto");
    expect(JSON.stringify(r)).not.toContain("clave");
  });
  it("un token inválido es ✗ con el arreglo", async () => {
    const r = await checkMercadoPago(
      { MERCADOPAGO: "on", MP_ACCESS_TOKEN: "malo", MP_WEBHOOK_SECRET: "c" },
      {
        whoAmI: async () => {
          throw new Error("Mercado Pago rechazó las credenciales");
        },
      }
    );
    expect(r.at(-1)).toMatchObject({ status: "fail" });
    expect(r.at(-1)?.fix).toBeTruthy();
  });
});
