import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Monedas — guardarraíles. Lo que se rompería sin avisar: un saldo que se escribe desde otro lado (y deja de
 * cuadrar con el libro), un libro que se edita, un cobro que se cuela en el flujo antes de tiempo o una migración
 * que toca lo que ya existía. No los relajes: enruta tu cambio por `src/server/credits/`.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SRC = path.join(ROOT, "src");

function archivos(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...archivos(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
const leer = (f: string) => readFileSync(f, "utf8");
const todos = archivos(SRC);

const TABLAS = ["creditAccount", "creditLedger", "creditUsage", "creditRate", "creditPack", "creditTopup", "creditAlert"] as const;

/** ¿Este código escribe (insert/update/delete) la tabla? Mira `db.insert(schema.x)`, `tx.update(schema.x)`, etc. */
const escribe = (code: string, tabla: string) => new RegExp(`\\.(insert|update|delete)\\(\\s*schema\\.${tabla}\\b`).test(code);

/** Sin comentarios: lo que cuenta es el código. */
const sinComentarios = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("las tablas credit_* entran por la puerta única", () => {
  it("nadie fuera de src/server/credits/ escribe una tabla credit_*", () => {
    const infractores: string[] = [];
    for (const f of todos) {
      const r = rel(f);
      if (r.startsWith("server/credits/")) continue;
      const code = leer(f);
      for (const t of TABLAS) if (escribe(code, t)) infractores.push(`${r} escribe ${t}`);
    }
    expect(infractores, "Las tablas credit_* se escriben SOLO en server/credits/").toEqual([]);
  });

  it("el libro es inmutable: ni siquiera la puerta edita o borra `credit_ledger` (solo agrega filas)", () => {
    for (const f of todos) {
      const code = sinComentarios(leer(f));
      expect(new RegExp(`\\.(update|delete)\\(\\s*schema\\.creditLedger\\b`).test(code), rel(f)).toBe(false);
    }
  });

  it("toda fila del libro entra por UNA función con ON CONFLICT (organización, clave de idempotencia)", () => {
    const insertores = todos.filter((f) => /\.insert\(\s*schema\.creditLedger\b/.test(sinComentarios(leer(f))));
    expect(insertores.map(rel)).toEqual(["server/credits/internal.ts"]);
    const code = leer(path.join(SRC, "server/credits/internal.ts"));
    expect(code).toMatch(/onConflictDoNothing\(\{\s*target:\s*\[schema\.creditLedger\.organizationId,\s*schema\.creditLedger\.idempotencyKey\]/);
  });

  it("toda operación que mueve saldo bloquea la cuenta (FOR UPDATE) dentro de una transacción", () => {
    const internal = leer(path.join(SRC, "server/credits/internal.ts"));
    expect(internal).toContain('.for("update")');
    const ledger = sinComentarios(leer(path.join(SRC, "server/credits/ledger.ts")));
    const operaciones = ledger.match(/export async function (grantPeriodQuota|adjustPeriodQuota|expirePeriodQuota|spendCredits|applyTopup|refundTopup|adjustCredits|configureCut)\b/g) ?? [];
    expect(operaciones).toHaveLength(8);
    // Cada una abre su transacción y toma la cuenta con `lockAccount`.
    expect((ledger.match(/getDb\(\)\.transaction\(/g) ?? []).length).toBe(8);
    expect((ledger.match(/await lockAccount\(/g) ?? []).length).toBe(8);
  });

  it("toda consulta de una organización lleva scoped()", () => {
    for (const nombre of ["ledger.ts", "queries.ts", "usage.ts", "catalog.ts", "internal.ts"]) {
      const code = sinComentarios(leer(path.join(SRC, "server/credits", nombre)));
      // `.where(` sobre una tabla de organización (cuenta, libro, uso, recarga) debe usar scoped(...).
      for (const m of code.matchAll(/\.where\(([^;]*?)\)\s*(?:\.limit|\.for|\.returning|\.groupBy|\.orderBy|;|\))/g)) {
        const cond = m[1] ?? "";
        if (/schema\.credit(Account|Ledger|Usage|Topup|Alert)\b/.test(cond)) {
          expect(cond, `${nombre}: ${cond.slice(0, 80)}`).toMatch(/scoped\(|and\(\s*scoped|gte\(|lt\(/);
        }
      }
    }
  });
});

describe("las monedas se conectan al flujo SOLO por los puntos acordados (Paso 3)", () => {
  /**
   * Quién puede importar la puerta. Cada uno es un punto de conexión deliberado: medir la IA, cobrar un turno,
   * medir/cobrar un envío y mantener la cuota al día. Ampliarlo es una decisión, no un descuido: el cobro del
   * Paso 4+ (recargas, webhooks, interfaz) se suma aquí a propósito.
   */
  const PUNTOS_DE_CONEXION = [
    "lib/ai/index.ts", // mide cada llamada a la IA (credit_usage)
    "server/ai/metering.ts", // el turno del agente: pre-chequeo, medición y cobro
    "server/inbox/metering.ts", // los envíos: pre-chequeo de plantillas, medición y cobro
    "server/saas/credits-sync.ts", // la cuota del periodo sigue a la suscripción
    "server/notifications/credit-alerts.ts", // los avisos de saldo (campanita y correo)
    "server/super-admin/credits.ts", // lo que ve y hace el Super Admin (reporte, ajuste manual, corte)
  ];

  it("nadie fuera de server/credits/ y de los puntos de conexión importa la puerta", () => {
    // `import type` no cuenta: no trae código (la pantalla del panel solo lee los tipos del reporte).
    const sinTipos = (code: string) => code.replace(/^import type [^;]*;/gm, "");
    const importadores = todos.filter((f) => !rel(f).startsWith("server/credits/") && /from "@\/server\/credits(\/[^"]*)?"/.test(sinTipos(leer(f))));
    expect(importadores.map(rel).sort(), "Un archivo nuevo que usa la puerta debe agregarse a PUNTOS_DE_CONEXION a propósito").toEqual([...PUNTOS_DE_CONEXION].sort());
  });

  it("pipeline, outbox y el barrido no hablan con la puerta directo: pasan por su módulo de medición", () => {
    for (const f of ["server/ai/pipeline.ts", "server/inbox/outbox.ts", "server/saas/subscription-sweeper.ts", "server/whatsapp/templates.ts"]) {
      expect(leer(path.join(SRC, f)), f).not.toMatch(/from "@\/server\/credits/);
    }
    expect(leer(path.join(SRC, "server/ai/pipeline.ts"))).toContain("beginAiTurnMeter");
    expect(leer(path.join(SRC, "server/inbox/outbox.ts"))).toContain("medirEnvio");
    expect(leer(path.join(SRC, "server/saas/subscription-sweeper.ts"))).toContain("syncAllQuotas");
  });

  it("la suscripción solo avisa a credits-sync DESPUÉS de confirmar, nunca dentro de su transacción ni hablando con la puerta", () => {
    const code = sinComentarios(leer(path.join(SRC, "server/saas/subscription.ts")));
    // No importa la puerta de monedas: solo el módulo que sigue a la suscripción.
    expect(code).not.toMatch(/from "@\/server\/credits"/);
    expect(code).toContain('from "@/server/saas/credits-sync"');
    // Tres caminos cambian plan o periodo (acción del panel, cobro, cambio del dueño) y los tres avisan al terminar.
    const llamadas = code.match(/^ {2}afterSubscriptionCommit\(/gm) ?? [];
    expect(llamadas).toHaveLength(3);
    // Y ninguna aparece más adentro (indentación mayor = dentro de la transacción).
    expect((code.match(/afterSubscriptionCommit\(/g) ?? []).length).toBe(3);
  });

  it("el módulo que sigue a la suscripción solo LEE subscription/plan", () => {
    const code = sinComentarios(leer(path.join(SRC, "server/saas/credits-sync.ts")));
    expect(code).not.toMatch(/\.(insert|update|delete)\(\s*schema\.(subscription|plan)\b/);
  });

  it("las rutas de Super Admin no hablan con la puerta: pasan por server/super-admin/credits.ts", () => {
    for (const f of todos.filter((f) => rel(f).startsWith("app/api/super-admin/credits/"))) {
      expect(leer(f), rel(f)).not.toMatch(/from "@\/server\/credits/);
      expect(leer(f), rel(f)).toContain("withSuperAdmin(");
    }
  });

  it("solo se cobra por la puerta (spendCredits) y nunca en un camino que no sea el turno o el envío", () => {
    const quienCobra = todos.filter((f) => !rel(f).startsWith("server/credits/") && /\bspendCredits\(/.test(sinComentarios(leer(f))));
    expect(quienCobra.map(rel).sort()).toEqual(["server/ai/metering.ts", "server/inbox/metering.ts"]);
  });

  it("la puerta no importa el flujo que algún día la llamará (sin dependencias circulares)", () => {
    for (const f of todos.filter((f) => rel(f).startsWith("server/credits/"))) {
      const code = leer(f);
      for (const prohibido of ["@/server/ai/", "@/server/inbox/", "@/server/saas/", "@/server/billing/", "@/server/automation/", "@/server/whatsapp/"]) {
        expect(code, `${rel(f)} importa ${prohibido}`).not.toContain(`from "${prohibido}`);
      }
    }
  });
});

describe("importar la puerta no lee la base", () => {
  it("ningún archivo de server/credits/ lee `schema.*` al cargarse (rompería a quien mockea @/lib/db con un esquema parcial)", () => {
    for (const nombre of readdirSync(path.join(SRC, "server/credits"))) {
      const code = sinComentarios(leer(path.join(SRC, "server/credits", nombre)));
      // Una declaración en la columna 0 que toca `schema.` se evalúa al importar; dentro de funciones va indentada.
      const alCargar = code.split("\n").filter((l) => /^(export )?(const|let|var) /.test(l) && /\bschema\./.test(l) && !/=\s*(async\s*)?\([^)]*\)\s*(:[^=]+)?=>/.test(l));
      expect(alCargar, nombre).toEqual([]);
    }
  });
});

describe("la bandera CREDITS (ADR-001)", () => {
  it("se lee de process.env directo y está apagada si no se define", () => {
    const flag = sinComentarios(leer(path.join(SRC, "server/credits/flag.ts")));
    expect(flag).toContain("process.env.CREDITS");
    expect(flag).not.toContain("getEnv(");
  });

  it("está documentada: en el esquema del entorno y en .env.example", () => {
    expect(leer(path.join(SRC, "lib/env.ts"))).toMatch(/CREDITS:\s*z\.string\(\)\.optional\(\)/);
    expect(leer(path.join(ROOT, ".env.example"))).toContain("# CREDITS=on");
  });

  it("toda operación de la puerta comprueba la bandera antes de tocar la base", () => {
    const ledger = sinComentarios(leer(path.join(SRC, "server/credits/ledger.ts")));
    expect((ledger.match(/if \(!creditsEnabled\(\)\) return DISABLED;/g) ?? []).length).toBe(8);
    for (const nombre of ["usage.ts", "queries.ts", "catalog.ts", "reconcile.ts"]) {
      expect(leer(path.join(SRC, "server/credits", nombre)), nombre).toContain("creditsEnabled()");
    }
  });
});

describe("la migración solo AGREGA", () => {
  const sql = readdirSync(path.join(ROOT, "drizzle"))
    .filter((f) => /^0089_.*\.sql$/.test(f))
    .map((f) => leer(path.join(ROOT, "drizzle", f)))
    .join("\n");

  it("existe y crea las 7 tablas nuevas", () => {
    expect(sql).not.toBe("");
    for (const t of ["credit_account", "credit_ledger", "credit_usage", "credit_rate", "credit_pack", "credit_topup", "credit_alert"]) {
      expect(sql, t).toContain(`CREATE TABLE "${t}"`);
    }
  });

  it("no altera ni borra ninguna tabla existente", () => {
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"/i);
    // Los únicos ALTER son las claves foráneas de las tablas NUEVAS.
    const alters = sql.match(/ALTER TABLE "[^"]+"[^;]*/g) ?? [];
    for (const a of alters) {
      expect(a).toMatch(/^ALTER TABLE "credit_[a-z]+" ADD CONSTRAINT/);
    }
  });

  it("el libro tiene la clave de idempotencia única por organización y las reglas de signo", () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "credit_ledger_org_idem_uq" ON "credit_ledger" USING btree ("organization_id","idempotency_key")');
    expect(sql).toContain("credit_ledger_amount_nonzero");
    expect(sql).toContain("credit_ledger_kind_sign");
  });
});
