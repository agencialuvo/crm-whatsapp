import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 047 — Guardarraíles del selector de anuncios de las automatizaciones. Lo que se rompería sin avisar: una consulta
 * que cruza organizaciones, una URL de Meta (que caduca y filtra un tercero) llegando al navegador, o un nombre
 * guardado en el flujo (que se desactualiza). No los relajes: enruta tu cambio por el camino correcto.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const leer = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("el endpoint de opciones", () => {
  const route = leer("src/app/api/automations/ad-options/route.ts");

  it("exige sesión, el mismo permiso que editar automatizaciones y la bandera de atribución (404 sin ella)", () => {
    expect(route).toMatch(/export const GET = withAuth\(/);
    expect(route).toContain("automationGate(session)");
    expect(route).toContain("atribucionEnabled()");
    expect(route.indexOf("automationGate(session)")).toBeLessThan(route.indexOf("atribucionEnabled()"));
  });

  it("la organización sale SIEMPRE de la sesión, nunca de un parámetro", () => {
    expect(route).toContain("session.organizationId");
    expect(route).not.toMatch(/searchParams\.get\(["']organization/i);
    expect(route).not.toMatch(/organizationId:\s*url/);
  });

  it("valida `resolve` (nivel:id) en vez de confiar en él", () => {
    expect(route).toMatch(/\(ad\|adset\|campaign\)/);
  });
});

describe("las consultas del catálogo", () => {
  const code = leer("src/server/automation/ad-options.ts");

  it("toda consulta a meta_ad / ad_attribution está acotada a UNA organización", () => {
    const froms = [...code.matchAll(/from\s+(meta_ad|ad_attribution)\b[\s\S]*?(?=`\)|\n\s*`)/g)];
    expect(froms.length).toBeGreaterThanOrEqual(8);
    for (const f of froms) expect(f[0], f[0].slice(0, 80)).toMatch(/organization_id\s*=\s*\$\{organizationId\}/);
  });

  it("la miniatura es la copia local: nunca se leen las URLs de Meta ni el enlace de vista previa", () => {
    expect(code).toContain("adThumbUrl(");
    expect(code).toContain("creative_asset_id");
    for (const prohibido of ["creative_thumb_url", "creative_image_url", "preview_link", "creative_body", "creative_title"]) {
      expect(code, prohibido).not.toContain(prohibido);
    }
  });

  it("los comodines de LIKE tecleados se escapan y nada llama a Meta", () => {
    expect(code).toContain("replace(/[\\\\%_]/g");
    expect(code).not.toMatch(/graphRequest|fetch\(/);
  });
});

describe("lo que se guarda en el flujo", () => {
  it("el contrato del disparador solo admite IDs (claves cerradas, sin nombres)", () => {
    const schemas = leer("src/lib/automation-schemas.ts");
    const bloque = schemas.slice(schemas.indexOf("ad_referral: z"), schemas.indexOf("} as const satisfies"));
    expect(bloque).toContain(".strict()");
    for (const clave of ["sourceId", "adsetId", "campaignId"]) expect(bloque).toContain(clave);
    expect(bloque).not.toMatch(/(campaignName|adsetName|adName|name)\s*:/);
  });

  it("el selector no guarda nombres: solo `configFor` (IDs) llega al flujo", () => {
    const picker = leer("src/lib/ad-picker.ts");
    expect(picker).toMatch(/export function configFor/);
    const cfgFor = picker.slice(picker.indexOf("export function configFor"), picker.indexOf("export function nodeMatchesConfig"));
    expect(cfgFor).not.toMatch(/name/i);
  });
});

describe("el componente del selector", () => {
  const ui = leer("src/components/automatizaciones/ad-trigger-picker.tsx");

  it("no usa <select> nativo (regla de los desplegables) y tiene su buscador", () => {
    expect(ui).not.toMatch(/<select[\s>]/);
    expect(ui).toContain('aria-label="Buscar campaña, conjunto o anuncio"');
  });

  it("solo pinta miniaturas locales y no menciona hosts de Meta", () => {
    expect(ui).toContain("isLocalThumb(");
    expect(ui).not.toMatch(/fbcdn|scontent|facebook\.com|graph\.facebook/);
  });

  it("es un árbol accesible", () => {
    for (const a of ['role="tree"', 'role="treeitem"', "aria-expanded", "aria-level"]) expect(ui).toContain(a);
  });
});

describe("el gancho del catálogo", () => {
  const catalog = leer("src/server/attribution/meta-ads/catalog.ts");

  it("markSynced y upsertAccountAds re-evalúan los flujos que esperaban a la jerarquía", () => {
    expect(catalog).toContain("emitDeferredAdReferrals(");
    const markSynced = catalog.slice(catalog.indexOf("export async function markSynced"), catalog.indexOf("async function markSyncedRows"));
    expect(markSynced).toContain("emitDeferredAdReferrals(");
    const upsert = catalog.slice(catalog.indexOf("export async function upsertAccountAds"));
    expect(upsert).toContain("emitDeferredAdReferrals(");
  });

  it("la re-evaluación nunca lanza y solo toca flujos de conjunto/campaña", () => {
    const d = leer("src/server/automation/ad-referral-deferred.ts");
    expect(d).toMatch(/catch \(err\)/);
    expect(d).toMatch(/level === "adset" \|\| level === "campaign"/);
    expect(d).toContain("DEFERRED_WINDOW_MS = 48 * 60 * 60 * 1000");
  });
});
