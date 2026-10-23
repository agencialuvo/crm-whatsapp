/**
 * Copia al portapapeles la URL pública de un medio (absoluta, para pegarla en las
 * columnas `imagen_url` / `foto_url` de las plantillas de carga masiva). Con
 * `http` en la red local el portapapeles moderno no está disponible: plan B.
 */
export function absoluteMediaUrl(ruta: string): string {
  return `${window.location.origin}${ruta}`;
}

export async function copyText(texto: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = texto;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
