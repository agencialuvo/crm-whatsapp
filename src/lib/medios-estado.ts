import { formatBytes, type EstadoEnvio, type EstadoVariante, type MedioDto } from "@/lib/medios";

/**
 * Medios — lógica PURA de lo que la interfaz muestra sobre el estado de un video para WhatsApp (insignias de la galería,
 * sondeo, opciones y avisos del selector de pasos). Vive aparte de los componentes para probarse sin navegador.
 */

export type Tono = "ok" | "info" | "error" | "neutro";

/** Lo que el selector de pasos necesita saber de un medio (un subconjunto del DTO, con los campos nuevos opcionales). */
export type MedioDePaso = {
  id: string;
  nombre: string;
  tipo: "image" | "video" | "document";
  noEnviable?: boolean;
  varianteEstado?: EstadoVariante;
  envio?: EstadoEnvio;
  varianteError?: string | null;
};

/** La insignia de una tarjeta de la galería; `null` = nada que decir (imagen, PDF o un video que se envía tal cual). */
export function insigniaDeEnvio(m: Pick<MedioDto, "tipo" | "envio" | "varianteBytes">): { texto: string; tono: Tono } | null {
  switch (m.envio) {
    case "listo":
      return { texto: m.varianteBytes ? `Listo para WhatsApp · ${formatBytes(m.varianteBytes)}` : "Listo para WhatsApp", tono: "ok" };
    case "optimizando":
      return { texto: "Optimizando para WhatsApp…", tono: "info" };
    case "fallo":
      return { texto: "No se pudo optimizar", tono: "error" };
    case "no_enviable":
      return { texto: "No se envía por WhatsApp", tono: "neutro" };
    default:
      return null;
  }
}

/** ¿Hay algún medio optimizándose? Mientras sea así la galería vuelve a preguntar. */
export function hayOptimizando(medios: readonly Pick<MedioDto, "varianteEstado">[] | null | undefined): boolean {
  return !!medios?.some((m) => m.varianteEstado === "processing");
}

/**
 * Mezcla una lista recién pedida con la que ya se muestra, tocando SOLO lo que cambia por la optimización (estado de la
 * variante, su peso y error, la insignia, el reintento y la URL de la variante). El resto de cada tarjeta —en particular
 * `urlFirmada`, que cambia en cada petición— se conserva para que las miniaturas no parpadeen. No agrega ni quita
 * tarjetas (una subida o un borrado en curso no se pisa). Devuelve la MISMA lista si nada cambió (React no repinta).
 */
export function fusionarVariantes(actuales: MedioDto[], nuevos: readonly MedioDto[]): MedioDto[] {
  const porId = new Map(nuevos.map((m) => [m.id, m]));
  let cambio = false;
  const res = actuales.map((m) => {
    const n = porId.get(m.id);
    if (!n) return m;
    if (
      n.varianteEstado === m.varianteEstado &&
      n.varianteBytes === m.varianteBytes &&
      n.varianteError === m.varianteError &&
      n.envio === m.envio &&
      n.puedeReintentar === m.puedeReintentar &&
      n.noEnviable === m.noEnviable &&
      (n.urlVariante === null) === (m.urlVariante === null)
    ) {
      return m;
    }
    cambio = true;
    return {
      ...m,
      varianteEstado: n.varianteEstado,
      varianteBytes: n.varianteBytes,
      varianteError: n.varianteError,
      envio: n.envio,
      puedeReintentar: n.puedeReintentar,
      noEnviable: n.noEnviable,
      urlVariante: n.urlVariante,
    };
  });
  return cambio ? res : actuales;
}

/** El origen de la miniatura/vista previa: la variante ligera cuando está lista; si no, el original. */
export function origenDeVista(m: Pick<MedioDto, "tipo" | "urlVariante" | "urlFirmada" | "ruta">): string {
  return m.tipo === "video" && m.urlVariante ? m.urlVariante : (m.urlFirmada ?? m.ruta);
}

/** ¿El selector de pasos ofrece este medio? Lo no enviable no se ofrece (fallaría al ejecutarse), salvo el ya elegido. */
export function seOfreceEnPaso(m: MedioDePaso, elegidoId: string | null | undefined): boolean {
  return !m.noEnviable || m.id === elegidoId;
}

/** El texto de una opción del selector: «nombre · Video (optimizando…)». */
export function etiquetaDeOpcion(m: MedioDePaso): string {
  const tipo = m.tipo === "video" ? "Video" : m.tipo === "document" ? "PDF" : "Imagen";
  const base = `${m.nombre} · ${tipo}`;
  if (m.varianteEstado === "processing") return `${base} (optimizando…)`;
  if (m.noEnviable) return `${base} (no se puede enviar)`;
  return base;
}

/** El aviso que acompaña al medio elegido en un paso (`null` = nada que avisar). */
export function avisoDeMedioEnPaso(m: MedioDePaso | undefined): { tono: Tono; texto: string } | null {
  if (!m) return null;
  if (m.varianteEstado === "processing") {
    return { tono: "info", texto: "Este video se está optimizando para WhatsApp. Estará listo en unos minutos; si el flujo se ejecuta antes, el paso espera (hasta una hora)." };
  }
  if (m.noEnviable) {
    const motivo = m.varianteEstado === "failed" && m.varianteError ? ` Motivo: ${m.varianteError}` : "";
    return {
      tono: "error",
      texto: `Este archivo no se puede enviar por WhatsApp y el paso fallaría al ejecutarse. Elige otro o, en Medios, reintenta la optimización.${motivo}`,
    };
  }
  return null;
}
