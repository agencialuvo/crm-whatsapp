import { money } from "@/lib/salon/format";
import { cn } from "@/lib/utils";

/** Sobrante (verde), faltante (rojo) o exacto. */
export function Difference({ cents, currency }: { cents: number; currency: string }) {
  const tone = cents === 0 ? "text-text-2" : cents > 0 ? "text-success-text" : "text-danger-text";
  const label = cents === 0 ? "Cuadra exacto" : cents > 0 ? "Sobrante" : "Faltante";
  return (
    <div
      className={cn(
        "flex items-center justify-between rounded-md border px-3 py-2",
        cents === 0 ? "bg-subtle" : cents > 0 ? "border-success-soft bg-success-tint" : "border-danger-soft bg-danger-tint"
      )}
    >
      <span className={cn("text-sm font-medium", tone)}>{label}</span>
      <span className={cn("text-base font-semibold tabular-nums", tone)}>
        {cents > 0 ? "+" : ""}
        {money(cents, currency)}
      </span>
    </div>
  );
}

export function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-text-2">{label}</span>
      <span className={cn("tabular-nums", strong && "font-semibold")}>{value}</span>
    </div>
  );
}
