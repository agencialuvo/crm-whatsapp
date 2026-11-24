/**
 * Medios — ¿un MP4/MOV tiene el índice (`moov`) ANTES de los datos (`mdat`)? Es lo que permite empezar a verlo sin bajarlo
 * entero (`faststart`). Se recorren los átomos de primer nivel leyendo solo sus cabeceras (8 o 16 bytes cada una): un archivo
 * de 250 MB cuesta unas pocas lecturas pequeñas, no leerlo.
 *
 * Módulo puro: la lectura se inyecta (`leer(desde, cuantos)`), así se prueba con buffers y se usa con un archivo.
 */

export type Lector = (desde: number, cuantos: number) => Promise<Uint8Array>;

const MAX_ATOMOS = 64;

const tipoDe = (b: Uint8Array, o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

/**
 * `true` si el `moov` aparece antes que el `mdat`; `false` si el `mdat` va primero (o no hay `moov` a la vista).
 * `total` es el tamaño del archivo (un átomo con tamaño 0 significa «hasta el final»).
 */
export async function moovAlPrincipio(leer: Lector, total: number): Promise<boolean> {
  let pos = 0;
  for (let i = 0; i < MAX_ATOMOS && pos + 8 <= total; i++) {
    const cab = await leer(pos, 16);
    if (cab.length < 8) return false;
    const view = new DataView(cab.buffer, cab.byteOffset, cab.byteLength);
    let tam = view.getUint32(0);
    const tipo = tipoDe(cab, 4);
    if (tipo === "moov") return true;
    if (tipo === "mdat") return false;
    if (tam === 1) {
      if (cab.length < 16) return false;
      tam = Number(view.getBigUint64(8)); // tamaño de 64 bits
    } else if (tam === 0) {
      return false; // hasta el final del archivo, sin `moov` antes
    }
    if (tam < 8) return false; // átomo roto
    pos += tam;
  }
  return false;
}
