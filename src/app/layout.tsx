import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono, Instrument_Serif } from "next/font/google";
import { DEFAULT_BRANDING } from "@/lib/branding";
import { DEFAULT_FAVICON_SRC, tabIconHref } from "@/lib/favicon-default";
import { getSessionOrNull } from "@/lib/auth/session";
import { getBranding } from "@/server/branding";
import { enabledChannels } from "@/server/channels/enabled";
import { productName } from "@/lib/channels";
import "./globals.css";

// Las tres voces de la marca, las mismas de vocerocrm.com. next/font las
// descarga en BUILD y las sirve self-hosted (sin CDN en runtime: soberanía).
const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});
const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-serif",
  display: "swap",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const dynamic = "force-dynamic";

const AGENCY_NAME = "Agencia Luvo";

export async function generateMetadata(): Promise<Metadata> {
  const branding = await getBranding().catch(() => DEFAULT_BRANDING);
  const producto = productName([...enabledChannels()]);
  // Sin sesión (inicio de sesión, recuperación) la pestaña lleva siempre el
  // nombre de la agencia; dentro del sistema, la marca de la organización.
  const session = await getSessionOrNull();
  const marcaBranding = session
    ? await getBranding(session.organizationId).catch(() => branding)
    : branding;
  const marca = session ? marcaBranding.name : AGENCY_NAME;
  return {
    title: `${marca} | ${producto}`,
    description: `${producto} con agente de IA y Laboratorio de auto-evaluación`,
    // Sin logo propio, el icono de Agencia Luvo; con uno subido en Ajustes → Marca,
    // ese. El `?v=` cambia con la marca: los navegadores guardan el favicon con
    // una insistencia notable y, sin eso, el logo nuevo tarda días en aparecer.
    // Sin sesión, siempre el de la agencia; con sesión, el de la marca (si lo hay).
    icons: { icon: session ? tabIconHref(marcaBranding) : DEFAULT_FAVICON_SRC },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="es"
      className={`${archivo.variable} ${instrumentSerif.variable} ${plexMono.variable}`}
    >
      {/* El acento personalizado NO se inyecta aquí: inicio de sesión y
          recuperación llevan siempre los colores de la agencia (los de
          globals.css). Lo aplica `(app)/layout.tsx`, ya dentro del sistema. */}
      <body className="font-sans">{children}</body>
    </html>
  );
}
