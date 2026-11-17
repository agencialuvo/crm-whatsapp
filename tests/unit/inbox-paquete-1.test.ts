import { describe, expect, it } from "vitest";
import { fillQuickTemplate, unresolvedVariables } from "@/components/inbox/helpers";
import { SEND_ERROR_STATUS } from "@/server/inbox/send-status";

describe("plantillas rápidas", () => {
  it("sustituye {{1}} en todas sus apariciones y deja las demás visibles", () => {
    expect(fillQuickTemplate("Hola {{1}}, {{ 1 }} tu cita es {{2}} a las {{3}}", "Ana")).toBe(
      "Hola Ana, Ana tu cita es {{2}} a las {{3}}"
    );
  });
  it("sin nombre deja {{1}} para completar", () => {
    expect(fillQuickTemplate("Hola {{1}}", "")).toBe("Hola {{1}}");
  });
  it("detecta variables sin resolver, sin repetir", () => {
    expect(unresolvedVariables("Hola Ana {{2}} {{ 2 }} {{3}}")).toEqual(["{{2}}", "{{3}}"]);
    expect(unresolvedVariables("Hola Ana")).toEqual([]);
  });
});

describe("códigos HTTP de envío", () => {
  it("fallos operativos del canal son 409; el sandbox sigue siendo 403", () => {
    for (const c of ["not_connected", "reconnect_required", "window_closed", "message_limit"] as const) {
      expect(SEND_ERROR_STATUS[c]).toBe(409);
    }
    expect(SEND_ERROR_STATUS.sandbox_violation).toBe(403);
  });
});
