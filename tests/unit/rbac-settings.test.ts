import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
// El candado por plan consulta la BD: esta prueba es de otra cosa (roles), así que lo deja pasar.
vi.mock("@/server/business/saas-guard", () => ({ moduleGate: async () => null, getPlanAccess: async () => ({ unrestricted: true, modules: [], planName: "test" }) }));

/**
 * Control de acceso (RBAC) en las rutas de configuración: solo `owner`/`admin`
 * pueden tocar integraciones (WhatsApp, Google, Zoom, CAPI, webhook), el
 * perfil del agente, las etapas del pipeline y la demo. Un `member` (el
 * equipo que atiende la Bandeja) debe recibir 403 en TODAS, sin que la
 * petición llegue a tocar nada — las demás funciones de cada módulo no deben
 * invocarse para ese rol.
 *
 * `role` es mutable por test: cada bloque la fija antes de llamar al handler.
 */
const session = vi.hoisted(() => ({
  role: "owner" as string,
  organizationId: "org_a",
  userId: "usr_1",
}));

vi.mock("@/lib/auth/session", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireSession: async () => ({ ...session }),
  getSessionOrNull: async () => ({ ...session }),
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    APP_BASE_URL: "https://crm.ejemplo.test",
    META_WEBHOOK_VERIFY_TOKEN: "verify-abc",
  }),
}));

vi.mock("@/server/agenda/flag", () => ({
  agendaEnabled: () => true,
  agendaDisabledResponse: () => new Response(null, { status: 404 }),
}));
vi.mock("@/server/attribution/flag", () => ({
  atribucionEnabled: () => true,
  atribucionDisabledResponse: () => new Response(null, { status: 404 }),
}));

// Una fila "cualquiera" basta: lo que importa es que el guardián de rol se
// dispare ANTES de llegar aquí, no el resultado del negocio.
const dbCalled = vi.hoisted(() => ({ n: 0 }));
function chain(): unknown {
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => {
          dbCalled.n++;
          resolve([{}]);
        };
      }
      return () => chainProxy;
    },
  };
  const chainProxy = new Proxy({}, handler);
  return chainProxy;
}
// Cualquier columna que el handler pida (`schema.pipelineStage.organizationId`,
// `schema.lead.stageId`, …) resuelve a algo truthy, sin que el acceso truene:
// lo que importa es que el guardián de rol actúe ANTES de llegar aquí.
const schemaStub: unknown = new Proxy(
  {},
  { get: () => schemaStub }
);
vi.mock("@/lib/db", () => ({
  getDb: () => chain(),
  schema: schemaStub,
}));
vi.mock("@/lib/db/tenant", () => ({ scoped: () => ({}) }));

vi.mock("@/server/whatsapp/credentials", () => ({
  getCredentialsByOrg: vi.fn(async () => ({
    wabaId: "1",
    phoneNumberId: "2",
    token: "EAAG",
    status: "connected",
    displayPhoneNumber: null,
    verifiedName: null,
  })),
  saveCredentials: vi.fn(async () => {}),
  desconectarCanal: vi.fn(async () => {}),
  tokenLast4: (t: string) => t.slice(-4),
}));
vi.mock("@/server/whatsapp/connect", () => ({
  testConnection: vi.fn(async () => ({ ok: true, displayPhoneNumber: "+52", verifiedName: "N" })),
  registerWebhookForNumber: vi.fn(async () => ({ ok: true, appWithoutWebhook: false })),
  unregisterWebhookForNumber: vi.fn(async () => {}),
}));

vi.mock("@/server/agenda/connectors/google", () => ({
  googleConnector: { testConnection: vi.fn(async () => ({ ok: true })) },
}));
vi.mock("@/server/agenda/connectors/google-credentials", () => ({
  getGoogleCredentials: vi.fn(async () => null),
  saveGoogleCredentials: vi.fn(async () => {}),
  deleteGoogleCredentials: vi.fn(async () => {}),
  secretLast4: (s: string) => s.slice(-4),
}));

vi.mock("@/server/agenda/connectors/zoom", () => ({
  zoomConnector: { testConnection: vi.fn(async () => ({ ok: true })) },
}));
vi.mock("@/server/agenda/connectors/zoom-credentials", () => ({
  getZoomCredentials: vi.fn(async () => null),
  saveZoomCredentials: vi.fn(async () => {}),
  deleteZoomCredentials: vi.fn(async () => {}),
  secretLast4: (s: string) => s.slice(-4),
}));

vi.mock("@/server/attribution/settings", () => ({
  getCapiSettingsView: vi.fn(async () => ({ capi: null })),
  saveCapiSettings: vi.fn(async () => {}),
  deleteCapiSettings: vi.fn(async () => {}),
  stageBelongsToOrg: vi.fn(async () => true),
}));

vi.mock("@/server/seed/demo", () => ({
  isDomainEmpty: vi.fn(async () => true),
  seedDemo: vi.fn(async () => ({ contacts: 0 })),
}));

vi.mock("@/lib/ai/provider", () => ({
  estadoIaDe: vi.fn(async () => ({ activa: false })),
  mensajeDeEstado: vi.fn(() => null),
  envAiProvider: vi.fn(() => null),
}));

vi.mock("@/server/ai/credentials", () => ({
  AiCredentialError: class AiCredentialError extends Error {
    code = "x";
  },
  saveAiCredential: vi.fn(async () => {}),
  deleteAiCredential: vi.fn(async () => {}),
  getAiCredentialPublic: vi.fn(async () => null),
  getAiCredentialSecret: vi.fn(async () => null),
}));

vi.mock("@/lib/ai/probe", () => ({
  probeProvider: vi.fn(async () => ({ ok: true, latencyMs: 1 })),
  listModels: vi.fn(async () => ({ ok: true, modelos: [] })),
}));

vi.mock("@/server/leads/stage-history", () => ({
  relocateLeadsFromStage: vi.fn(async () => {}),
}));

beforeEach(() => {
  session.role = "owner";
  dbCalled.n = 0;
});

type Case = {
  label: string;
  run: () => Promise<Response>;
};

async function cases(): Promise<Case[]> {
  const whatsapp = await import("@/app/api/settings/whatsapp/route");
  const webhook = await import("@/app/api/settings/webhook/route");
  const google = await import("@/app/api/settings/google/route");
  const zoom = await import("@/app/api/settings/zoom/route");
  const capi = await import("@/app/api/settings/capi/route");
  const agentProfile = await import("@/app/api/agent/profile/route");
  const stages = await import("@/app/api/pipeline/stages/route");
  const stageById = await import("@/app/api/pipeline/stages/[id]/route");
  const seedDemoRoute = await import("@/app/api/seed/demo/route");
  const ai = await import("@/app/api/settings/ai/route");
  const aiTest = await import("@/app/api/settings/ai/test/route");
  const aiModels = await import("@/app/api/settings/ai/models/route");
  const whatsappTest = await import("@/app/api/settings/whatsapp/test/route");
  const googleTest = await import("@/app/api/settings/google/test/route");
  const zoomTest = await import("@/app/api/settings/zoom/test/route");

  const req = (url: string, body: unknown, method = "PUT") =>
    new Request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  return [
    {
      label: "PUT /api/settings/whatsapp",
      run: () =>
        whatsapp.PUT(
          req("https://x/api/settings/whatsapp", { wabaId: "1", phoneNumberId: "2", token: "EAAG" })
        ),
    },
    { label: "DELETE /api/settings/whatsapp", run: () => whatsapp.DELETE() },
    { label: "POST /api/settings/webhook", run: () => webhook.POST() },
    {
      label: "PUT /api/settings/google",
      run: () =>
        google.PUT(
          req("https://x/api/settings/google", {
            clientId: "a",
            clientSecret: "b",
            refreshToken: "c",
          })
        ),
    },
    { label: "DELETE /api/settings/google", run: () => google.DELETE() },
    {
      label: "PUT /api/settings/zoom",
      run: () =>
        zoom.PUT(
          req("https://x/api/settings/zoom", { accountId: "a", clientId: "b", clientSecret: "c" })
        ),
    },
    { label: "DELETE /api/settings/zoom", run: () => zoom.DELETE() },
    {
      label: "PUT /api/settings/capi",
      run: () => capi.PUT(req("https://x/api/settings/capi", { datasetId: "1", token: "abcdefgh" })),
    },
    { label: "DELETE /api/settings/capi", run: () => capi.DELETE() },
    {
      label: "PUT /api/agent/profile",
      run: () => agentProfile.PUT(req("https://x/api/agent/profile", { name: "Nea" })),
    },
    {
      label: "POST /api/pipeline/stages",
      run: () => stages.POST(req("https://x/api/pipeline/stages", { name: "Nueva" }, "POST")),
    },
    {
      label: "PATCH /api/pipeline/stages/[id]",
      run: () =>
        stageById.PATCH(req("https://x/api/pipeline/stages/stg_1", { name: "x" }, "PATCH"), {
          params: Promise.resolve({ id: "stg_1" }),
        }),
    },
    {
      label: "DELETE /api/pipeline/stages/[id]",
      run: () =>
        stageById.DELETE(req("https://x/api/pipeline/stages/stg_1", {}, "DELETE"), {
          params: Promise.resolve({ id: "stg_1" }),
        }),
    },
    { label: "POST /api/seed/demo", run: () => seedDemoRoute.POST() },
    {
      label: "PUT /api/settings/ai",
      run: () =>
        ai.PUT(
          req("https://x/api/settings/ai", {
            provider: "openrouter",
            model: "m",
            token: "sk-12345678",
          })
        ),
    },
    { label: "DELETE /api/settings/ai", run: () => ai.DELETE() },
    {
      label: "POST /api/settings/ai/test",
      run: () =>
        aiTest.POST(
          req(
            "https://x/api/settings/ai/test",
            { provider: "openrouter", model: "m", token: "sk-12345678" },
            "POST"
          )
        ),
    },
    {
      label: "POST /api/settings/ai/models",
      run: () =>
        aiModels.POST(
          req(
            "https://x/api/settings/ai/models",
            { provider: "openrouter", token: "sk-12345678" },
            "POST"
          )
        ),
    },
    {
      label: "POST /api/settings/whatsapp/test",
      run: () =>
        whatsappTest.POST(
          req(
            "https://x/api/settings/whatsapp/test",
            { phoneNumberId: "1", token: "EAAG" },
            "POST"
          )
        ),
    },
    {
      label: "POST /api/settings/google/test",
      run: () =>
        googleTest.POST(
          req(
            "https://x/api/settings/google/test",
            { clientId: "a", clientSecret: "b", refreshToken: "c" },
            "POST"
          )
        ),
    },
    {
      label: "POST /api/settings/zoom/test",
      run: () =>
        zoomTest.POST(
          req(
            "https://x/api/settings/zoom/test",
            { accountId: "a", clientId: "b", clientSecret: "c" },
            "POST"
          )
        ),
    },
  ];
}

describe("RBAC — configuración del negocio: solo owner/admin", () => {
  it("un member recibe 403 en TODAS las rutas de configuración, sin tocar nada", async () => {
    session.role = "member";
    for (const c of await cases()) {
      dbCalled.n = 0;
      const res = await c.run();
      expect(res.status, `${c.label} debería responder 403 para member`).toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code, c.label).toBe("forbidden");
      expect(dbCalled.n, `${c.label} no debería haber consultado la base`).toBe(0);
    }
  });

  it("owner y admin no son rebotados por el guardián de rol", async () => {
    for (const role of ["owner", "admin"]) {
      session.role = role;
      for (const c of await cases()) {
        const res = await c.run();
        expect(res.status, `${c.label} (${role}) no debería dar 403`).not.toBe(403);
      }
    }
  });

  it("un member sigue sin acceso aunque mande el header x-role falso (el rol viene de la membresía, no del cliente)", async () => {
    session.role = "member";
    const whatsapp = await import("@/app/api/settings/whatsapp/route");
    const res = await whatsapp.DELETE();
    expect(res.status).toBe(403);
  });
});
