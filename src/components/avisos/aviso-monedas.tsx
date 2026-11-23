import Link from "next/link";
import { Coins } from "lucide-react";
import type { AvisoMonedas } from "@/server/saas/credits-summary";

/**
 * La franja de «sin monedas»: aparece SOLO cuando el corte está activo y el saldo no alcanza (en modo sombra o con
 * las monedas apagadas no existe). Sin descartar, como las otras franjas: no es una novedad, es que el producto no
 * está haciendo lo que el dueño cree; se va sola cuando hay saldo. Quien puede configurar ve el enlace a «Monedas»;
 * el resto solo la lee (es información, no una acción suya).
 */
export function AvisoMonedasBanner({ aviso, puedeConfigurar }: { aviso: AvisoMonedas; puedeConfigurar: boolean }) {
  if (!aviso) return null;
  return (
    <div
      role="status"
      data-aviso-monedas={aviso.kind}
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-warning-soft bg-warning-tint px-4 py-2.5 text-[13px] text-warning-text"
    >
      <Coins className="h-4 w-4 shrink-0" strokeWidth={1.7} />
      <span className="min-w-0 flex-1">{aviso.mensaje}</span>
      {puedeConfigurar ? (
        <Link href="/ajustes/monedas" className="shrink-0 font-medium underline underline-offset-2">
          Ver mis monedas →
        </Link>
      ) : (
        <span className="shrink-0 text-text-3">Avisa a quien administra tu cuenta.</span>
      )}
    </div>
  );
}
