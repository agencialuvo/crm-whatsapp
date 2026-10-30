/** El contenedor con scroll del contenido de Ajustes (ver `ajustes/layout.tsx`). */
export const SETTINGS_SCROLL_ID = "settings-scroll";

/**
 * Ir a una zona de Mi perfil estando ya en esa pantalla: cambia la dirección SIN navegar,
 * avisa a quien la lee (el menú de Ajustes marca la zona activa) y desplaza el contenido.
 */
export function goToSettingsAnchor(href: string): void {
  const anchor = href.split("#")[1];
  if (!anchor) return;
  window.history.replaceState(null, "", href);
  // `replaceState` no dispara `hashchange`: se avisa a mano.
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  scrollToSettingsAnchor(anchor);
}

/**
 * Lleva a una zona de la pantalla de Ajustes desplazando SOLO el contenido de Ajustes.
 *
 * Por qué no el `#ancla` nativo: el navegador hace `scrollIntoView` en TODOS los
 * contenedores con scroll por encima del elemento, también los que son `overflow-hidden`
 * (el marco de la aplicación). Resultado: la cabecera y el menú se corrían hacia arriba y
 * abajo quedaba un espacio en blanco enorme. Aquí se calcula el desplazamiento a mano y
 * solo se toca el contenedor de Ajustes.
 */
export function scrollToSettingsAnchor(anchor: string, behavior: ScrollBehavior = "smooth"): void {
  const scroller = document.getElementById(SETTINGS_SCROLL_ID);
  const target = document.getElementById(anchor);
  if (!scroller || !target) return;
  const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  scroller.scrollTo({ top: Math.max(0, top - 16), behavior });
  // Si algo (la carga con `#ancla` en la dirección) ya movió el marco, se deja como estaba.
  for (let el = scroller.parentElement; el; el = el.parentElement) {
    if (el.scrollTop !== 0) el.scrollTop = 0;
  }
}
