import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IgnoredNumbersCard } from "@/components/agent/ignored-numbers-card";
import { IGNORED_LABEL_MAX, NEEDS_COUNTRY_CODE } from "@/lib/ignored-number";

/**
 * Números ignorados — la interfaz. El repo no tiene un DOM de pruebas: lo que se puede fijar aquí es el primer
 * dibujo (plegada por defecto) y que el cableado y los textos acordados estén en el código. El recorrido real
 * —abrir, agregar, pegar varios, quitar, ignorar desde la Bandeja— se prueba en el navegador.
 */

const read = (p: string) => readFileSync(p, "utf8");
const card = read("src/components/agent/ignored-numbers-card.tsx");
const panel = read("src/components/inbox/contact-panel.tsx");

describe("tarjeta «Números que el agente ignora»: primer dibujo", () => {
  const html = (canConfigure: boolean) => renderToStaticMarkup(createElement(IgnoredNumbersCard, { canConfigure }));

  it("nace PLEGADA: el título se ve, el cuerpo no", () => {
    const h = html(true);
    expect(h).toContain("Números que el agente ignora");
    expect(h).toContain('aria-expanded="false"');
    expect(h).not.toContain("Agregar");
    expect(h).not.toContain("Pegar varios");
    // Ni el cuerpo ni sus campos existen todavía (la cabecera solo apunta a él con aria-controls).
    expect(h).not.toContain('id="ignored-numbers-body"');
    expect(h).not.toContain('id="ignored-number"');
  });

  it("explica la idea desde el encabezado, sin abrirla", () => {
    expect(html(false)).toContain("llegan a tu Bandeja");
  });

  it("se dibuja igual de plegada para quien no configura (los controles se deciden al abrir)", () => {
    expect(html(false)).toContain('aria-expanded="false"');
  });
});

describe("tarjeta: textos y reglas acordados", () => {
  it("el texto de ayuda fijo", () => {
    expect(card).toContain("El mensaje sigue llegando a tu Bandeja. Solo el agente deja de contestar.");
  });

  it("empieza cerrada", () => {
    expect(card).toMatch(/const \[open, setOpen\] = useState\(false\)/);
  });

  it("la nota admite 80 caracteres, desde la MISMA constante que la base y el servidor", () => {
    expect(IGNORED_LABEL_MAX).toBe(80);
    expect(card).toContain("maxLength={IGNORED_LABEL_MAX}");
  });

  it("valida en vivo con la misma regla del servidor y avisa del código de país", () => {
    expect(card).toContain("ignoreKeyOf(number)");
    expect(card).toContain("parseIgnoredInput(bulkText)");
    expect(card).toContain("Escríbelo con el código de país, por ejemplo +51…");
    expect(NEEDS_COUNTRY_CODE).toBe("Incluye el código de país, por ejemplo +51…");
  });

  it("agregar, pegar varios y quitar van a la API de números ignorados", () => {
    expect(card).toContain('"/api/agent/ignored-numbers"');
    expect(card).toContain('jsonInit("POST", { number, label: label.trim() || undefined })');
    expect(card).toContain('jsonInit("POST", { bulk: bulkText })');
    expect(card).toContain("`/api/agent/ignored-numbers/${entry.id}`");
    expect(card).toContain('method: "DELETE"');
  });

  it("quitar pide confirmación antes de borrar", () => {
    expect(card).toContain("¿Quitar? El agente volverá a contestarle.");
    expect(card).toContain("Sí, quitar");
    expect(card).toContain("Cancelar");
  });

  it("el buscador y el contador aparecen pasando de 10 entradas", () => {
    expect(card).toContain("const SEARCH_FROM = 10;");
    expect(card).toContain("total > SEARCH_FROM");
    expect(card).toContain("Buscar por número o nota");
  });

  it("«Pegar varios» enseña qué se agregó, qué ya estaba y qué línea falló con su motivo", () => {
    expect(card).toContain("Ya estaban en la lista");
    expect(card).toContain("Línea {l.line}: {l.reason}");
    expect(card).toContain("por el tope de {limit}");
  });

  it("sin permiso no se ofrece escribir: el formulario y «Quitar» dependen de canConfigure", () => {
    expect(card).toContain("{canConfigure ? (");
    expect(card).toContain("{canConfigure &&");
    expect(card).toContain("Solo el dueño o un administrador puede cambiar esta lista.");
  });

  it("no toca la pausa del contacto ni de la conversación (la lista es la fuente de verdad)", () => {
    expect(card).not.toMatch(/aiPaused|ai_paused|aiEnabled|\/api\/contacts/);
  });
});

describe("pantalla Agente", () => {
  const agent = read("src/components/agent/agent-client.tsx");
  const page = read("src/app/(app)/agente/page.tsx");

  it("la tarjeta va al FINAL, después de comportamiento y conocimiento", () => {
    expect(agent).toContain("<IgnoredNumbersCard canConfigure={canConfigure} />");
    expect(agent.indexOf("<KbSection")).toBeLessThan(agent.indexOf("<IgnoredNumbersCard"));
  });

  it("el permiso sale de la sesión en el servidor, como en la Bandeja", () => {
    expect(page).toContain("canConfigure(session?.role)");
    expect(page).toContain("<AgentClient canConfigure={canConfigure(session?.role)} />");
  });
});

describe("Bandeja: acceso rápido en el panel del contacto", () => {
  const inbox = read("src/components/inbox/inbox-client.tsx");
  const bandeja = read("src/app/(app)/bandeja/page.tsx");

  it("«Ignorar este número» agrega por contactId, sin ventanas extra", () => {
    expect(panel).toContain("Ignorar este número");
    expect(panel).toContain("JSON.stringify({ contactId })");
  });

  it("un contacto ignorado muestra «Número ignorado» y, con permiso, «Quitar de la lista»", () => {
    expect(panel).toContain("Número ignorado");
    expect(panel).toContain("Quitar de la lista");
    expect(panel).toContain("`/api/agent/ignored-numbers/${ignored.id}`");
  });

  it("consulta el estado a la lista (la fuente de verdad) y lo refresca con el resto del panel en vivo", () => {
    expect(panel).toContain("/api/agent/ignored-numbers?contactId=");
    expect(panel).toMatch(/refreshLive = useCallback[\s\S]*void loadIgnored\(\)/);
    expect(panel).toMatch(/const refetch = useCallback[\s\S]*void loadIgnored\(\)/);
  });

  it("no dice «Respondiendo» de un número ignorado y no deja encender el interruptor de IA", () => {
    expect(panel).toContain("No responde · número ignorado");
    expect(panel).toContain("disabled={ignored !== null}");
    expect(panel).toContain("checked={aiActive && !ignored}");
  });

  it("ignorar NO pausa nada: el panel no escribe `aiPaused` ni `aiEnabled` por este camino", () => {
    const ignoreBlock = panel.slice(panel.indexOf("async function ignoreContact"), panel.indexOf("async function unignoreContact"));
    expect(ignoreBlock).not.toMatch(/aiPaused|aiEnabled|\/api\/contacts/);
  });

  it("agregar y quitar solo se ofrecen a quien configura; el resto ve el estado", () => {
    expect(panel).toContain("canIgnore = false");
    expect(panel).toContain("{canIgnore && (");
    expect(panel).toContain("canIgnore ? (");
    expect(inbox).toContain("canIgnore = false");
    expect(inbox).toContain("canIgnore={canIgnore}");
    expect(bandeja).toContain("canIgnore={canConfigure(session?.role)}");
  });
});

describe("lo que viaja al navegador", () => {
  it("la lógica de números ignorados y la normalización no arrastran el entorno ni el servidor", () => {
    for (const f of ["src/lib/ignored-number.ts", "src/lib/phone-normalize.ts"]) {
      const imports = [...read(f).matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]);
      expect(imports.filter((i) => /^@\/(server|lib\/env|lib\/db)|meta\/client/.test(i!))).toEqual([]);
    }
  });

  it("`lib/meta/client` sigue exportando la normalización, para quien ya la importaba de ahí", () => {
    const src = read("src/lib/meta/client.ts");
    expect(src).toContain('export { normalizeMx, normalizeRecipient } from "@/lib/phone-normalize"');
  });
});
