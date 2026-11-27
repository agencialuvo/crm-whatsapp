/**
 * Mejora 7 — Partir la respuesta del agente para que quepa en el canal (WhatsApp: 4096 caracteres; Instagram y
 * Messenger miden en bytes). Pura: `cabe` lo decide el canal (`textFits`).
 *
 * Antes, una respuesta larga se rechazaba en el envío (`text_too_long`) y el cliente se quedaba sin nada. Ahora se
 * parte en mensajes por párrafos, luego por oraciones y, como último recurso, por caracteres; con un máximo de
 * `maxPartes` mensajes (más que eso abruma en un chat): lo que sobra se recorta con «…».
 */

export const MAX_PARTES_RESPUESTA = 3;
const ELIPSIS = "…";

/** El prefijo más largo (en puntos de código) de `texto` que cabe. */
function cortarDuro(texto: string, cabe: (s: string) => boolean, sufijo = ""): string {
  const cps = [...texto];
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cabe(cps.slice(0, mid).join("").trimEnd() + sufijo)) lo = mid;
    else hi = mid - 1;
  }
  return cps.slice(0, lo).join("").trimEnd();
}

/** Trozos que caben, en orden, sin perder texto. */
function trozos(texto: string, cabe: (s: string) => boolean): string[] {
  const salida: string[] = [];
  const empujar = (unidades: string[], sep: string, siguiente?: (u: string) => string[]) => {
    let actual = "";
    for (const u of unidades) {
      const candidato = actual ? `${actual}${sep}${u}` : u;
      if (cabe(candidato)) {
        actual = candidato;
        continue;
      }
      if (actual) salida.push(actual);
      actual = "";
      if (cabe(u)) {
        actual = u;
      } else if (siguiente) {
        const partes = siguiente(u);
        // El último trozo de la unidad partida puede juntarse con lo que sigue.
        salida.push(...partes.slice(0, -1));
        actual = partes.at(-1) ?? "";
      } else {
        let resto = u;
        while (resto && !cabe(resto)) {
          const cabeza = cortarDuro(resto, cabe);
          if (!cabeza) break; // nada cabe: el canal rechazaría hasta un carácter
          salida.push(cabeza);
          resto = resto.slice(cabeza.length).trimStart();
        }
        actual = resto;
      }
    }
    if (actual) salida.push(actual);
  };

  const porOraciones = (parrafo: string): string[] => {
    const antes = salida.length;
    empujar(parrafo.split(/(?<=[.!?…])\s+/), " ");
    return salida.splice(antes);
  };
  empujar(texto.split(/\n{2,}/), "\n\n", porOraciones);
  return salida;
}

export function partirParaCanal(
  texto: string,
  cabe: (s: string) => boolean,
  maxPartes = MAX_PARTES_RESPUESTA
): string[] {
  const limpio = texto.trim();
  if (!limpio) return [];
  if (cabe(limpio)) return [limpio];
  const partes = trozos(limpio, cabe);
  if (partes.length <= maxPartes) return partes;
  const recorte = partes.slice(0, maxPartes);
  const ultima = recorte[maxPartes - 1]!;
  recorte[maxPartes - 1] = cabe(`${ultima}${ELIPSIS}`)
    ? `${ultima}${ELIPSIS}`
    : `${cortarDuro(ultima, cabe, ELIPSIS)}${ELIPSIS}`;
  return recorte;
}
