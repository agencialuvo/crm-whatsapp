import type { NextConfig } from "next";
import { readFileSync } from "node:fs";

// La versión sale de package.json y no de una constante aparte: duplicarla es
// tenerla desactualizada en uno de los dos lados, y justo esta no puede mentir.
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
) as { version: string };

/** [ruta antigua, ruta nueva]. Lo específico va antes que lo general. */
const REDIRECCIONES_DE_PAGINAS: ReadonlyArray<readonly [string, string]> = [
  ["/settings/ads", "/ajustes/anuncios"],
  ["/settings/ai", "/ajustes/ia"],
  ["/settings/branding", "/ajustes/marca"],
  ["/settings/calendar", "/ajustes/calendario"],
  ["/settings/channels", "/ajustes/canales"],
  ["/settings/team", "/ajustes/equipo"],
  ["/settings/templates", "/ajustes/plantillas"],
  ["/settings/:canal(instagram|messenger|tiktok|whatsapp)", "/ajustes/:canal"],
  ["/settings", "/ajustes"],
  ["/negocio/servicios", "/servicios"],
  ["/negocio/equipo", "/equipo"],
  ["/negocio/caja", "/caja"],
  ["/negocio/agenda", "/citas?pestana=sillas"],
  ["/agenda-por-sillas", "/citas?pestana=sillas"],
  ["/negocio", "/servicios"],
  ["/agent", "/agente"],
  ["/bookings", "/citas"],
  ["/contacts", "/contactos"],
  ["/inbox", "/bandeja"],
  ["/lab", "/laboratorio"],
  ["/onboarding", "/guia-de-inicio"],
  ["/results", "/resultados"],
  ["/login", "/iniciar-sesion"],
];

/**
 * Cabeceras de seguridad globales (auditoría de seguridad, frente CORS &
 * Cabeceras). No hay CORS que abrir: el CRM no expone API para que otro
 * origen la consuma desde el navegador — sin `Access-Control-Allow-Origin`,
 * el navegador bloquea toda lectura cross-origin por defecto, que es lo que
 * se quiere.
 *
 * El CSP es autocontenido a propósito: todo el JS/CSS es de `next/font` y del
 * propio bundle (sin CDN ni fuente externa, ver CLAUDE.md), así que
 * `default-src 'self'` no rompe nada y cierra XSS-por-inyección-de-script
 * aunque alguna sanitización fallara más adelante. `/api/media/*` y el
 * favicon ya traen su propio CSP más estricto (`src/server/whatsapp/media-headers.ts`,
 * `src/lib/favicon.ts`); el de aquí no los pisa porque Next aplica las
 * cabeceras de cada respuesta de API tal cual las puso el handler.
 */
// reCAPTCHA es un conector opcional: solo con la clave pública se abre el CSP a Google. Las
// cabeceras se fijan al construir, y ahí solo existe la pública (la secreta llega al arrancar).
const RECAPTCHA = !!process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY?.trim();

const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
  // HSTS: solo importa detrás de HTTPS (Coolify/Caddy en el borde); de más no
  // hace daño servirla siempre.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // React Refresh (solo en desarrollo) evalúa código; en producción no.
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}${RECAPTCHA ? " https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self'${RECAPTCHA ? " https://www.google.com/recaptcha/" : ""}`,
      // reCAPTCHA (solo con claves): el desafío vive en un iframe de Google.
      ...(RECAPTCHA ? ["frame-src https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/"] : []),
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  // standalone es para la imagen Docker (Linux). En Windows el trazado crea
  // symlinks que requieren permisos elevados, así que ahí se omite.
  output: process.platform === "win32" ? undefined : "standalone",
  // El paquete `postgres` usa APIs de Node que no deben empaquetarse en el bundle.
  serverExternalPackages: ["postgres"],
  // Se congelan al construir: lo que queda aquí va dentro del binario y no
  // cambia en tiempo de ejecución. El commit solo se congela si `SOURCE_COMMIT`
  // llega AL BUILD (build arg `SOURCE_COMMIT`; con docker compose,
  // `--build-arg`). Si no llega, esto queda vacío y el servidor cae al
  // `SOURCE_COMMIT` del entorno al arrancar, marcado como NO verificado
  // (`src/lib/version.ts`, #50): puede no ser el del código que corre.
  // Las páginas viven en español. Las rutas en inglés de antes (enlaces
  // guardados, correos, la guía impresa) siguen funcionando: 308 permanente a la
  // nueva. `/api/*` NO se toca: es el contrato publicado (bot, webhooks, health).
  async redirects() {
    return REDIRECCIONES_DE_PAGINAS.map(([source, destination]) => ({
      source,
      destination,
      permanent: true,
    }));
  },
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      // Medios: el archivo público es contenido que subió una persona. Va
      // DESPUÉS de la regla global para que su CSP (sin nada que ejecutar) sea la
      // que llega, no la de las páginas.
      {
        source: "/api/medios/:id/archivo",
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'none'; sandbox" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_BUILD_COMMIT: process.env.SOURCE_COMMIT ?? "",
  },
};

export default nextConfig;
