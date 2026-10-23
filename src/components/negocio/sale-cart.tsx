"use client";

import { useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchSelect, type SearchSelectOption } from "@/components/ui/search-select";
import { Field, MoneyInput } from "@/components/negocio/fields";
import { parseMoneyToCents } from "@/lib/money";
import { centsToInput, money } from "@/lib/salon/format";
import { OTHER_NOTE_MAX, PAYMENT_LABELS, PAYMENT_METHODS, type PaymentMethod } from "@/lib/salon/schemas";
import type { SaleOptionsDto } from "@/lib/salon/types";
import { cn } from "@/lib/utils";

/**
 * El carrito de una venta y sus campos, compartidos por «Registrar venta» (Caja)
 * y por «Nuevo cliente»: los dos piden lo mismo (servicios y ofertas, monto
 * cobrado y método de pago) y deben verse y comportarse igual.
 */

type CartLine = { key: number; value: string; price: string; note: string };

const NOTE_REQUIRED = "Escribe qué servicio u oferta es";

export type SaleCart = ReturnType<typeof useSaleCart>;

export function useSaleCart(
  options: SaleOptionsDto | null,
  currency: string,
  /** Se avisa con los ítems que quedan al AGREGAR uno (para ajustar quién atendió). */
  onAdd?: (values: string[]) => void,
  /** Al EDITAR una venta: sus ítems y su monto de partida, y los ítems que ya no están en el catálogo activo. */
  seed?: {
    lines: { value: string; price: string; note: string }[];
    amount: string;
    extra: { value: string; label: string; group: string; priceCents: number }[];
  },
) {
  const [cart, setCart] = useState<CartLine[]>(() =>
    (seed?.lines ?? []).map((l, i) => ({ key: i, ...l })),
  );
  const nextKey = useRef(seed?.lines.length ?? 0);
  // El monto sigue a la suma del carrito hasta que se edita a mano (al editar una venta, parte del cobrado).
  const [amount, setAmount] = useState(seed?.amount ?? "");
  const [amountEdited, setAmountEdited] = useState(seed !== undefined);

  const priceOf = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of options?.services ?? []) map.set(`service:${s.id}`, s.priceCents);
    for (const c of options?.combos ?? []) map.set(`combo:${c.id}`, c.priceCents);
    for (const x of seed?.extra ?? []) if (!map.has(x.value)) map.set(x.value, x.priceCents);
    return map;
    // `seed` solo se usa al abrir: lo que importa para recalcular son las opciones.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  const values = cart.map((l) => l.value);
  const lineCents = (l: { value: string; price: string }): number =>
    l.value === "other" ? (parseMoneyToCents(l.price) ?? 0) : (priceOf.get(l.value) ?? 0);
  const total = cart.reduce((a, l) => a + lineCents(l), 0);
  const shownAmount = amountEdited ? amount : cart.length > 0 ? centsToInput(total) : "";

  const choices: SearchSelectOption[] = [
    ...(options?.services ?? []).map((x) => ({
      value: `service:${x.id}`,
      label: x.name,
      group: "Servicios",
      hint: money(x.priceCents, currency),
    })),
    ...(options?.combos ?? []).map((x) => ({
      value: `combo:${x.id}`,
      label: x.name,
      group: "Ofertas",
      hint: money(x.priceCents, currency),
    })),
    { value: "other", label: "Otro (precio a criterio)", group: "Otros" },
  ];
  // Lo que la venta ya tenía y hoy no está activo sigue visible en su lista.
  for (const x of seed?.extra ?? []) {
    if (!choices.some((o) => o.value === x.value)) {
      choices.push({ value: x.value, label: x.label, group: x.group, hint: money(x.priceCents, currency) });
    }
  }

  return {
    cart,
    values,
    total,
    shownAmount,
    amountEdited,
    choices,
    lineCents,
    add(value: string) {
      if (!value) return;
      setCart((c) => [...c, { key: nextKey.current++, value, price: "", note: "" }]);
      onAdd?.([...values, value]);
    },
    remove(key: number) {
      setCart((c) => c.filter((l) => l.key !== key));
    },
    patch(key: number, change: Partial<Pick<CartLine, "price" | "note">>) {
      setCart((c) => c.map((x) => (x.key === key ? { ...x, ...change } : x)));
    },
    editAmount(v: string) {
      setAmount(v);
      setAmountEdited(true);
    },
    resetAmount() {
      setAmountEdited(false);
    },
    /** Los ítems en la forma que pide la API. */
    payload() {
      return cart.map((l) => {
        const [kind, id] = l.value.split(":") as ["service" | "combo" | "other", string | undefined];
        return kind === "other"
          ? { other: true, note: l.note, amountCents: parseMoneyToCents(l.price) ?? Number.NaN }
          : { serviceId: kind === "service" ? id : null, comboId: kind === "combo" ? id : null };
      });
    },
    /** El monto cobrado en centavos (`NaN` si está vacío o es inválido). */
    amountCents(): number {
      return parseMoneyToCents(shownAmount) ?? Number.NaN;
    },
  };
}

/** «Servicios y ofertas»: el buscador para agregar y la lista con su X. */
export function SaleItemsField({
  cart,
  currency,
  busy,
  error,
  idPrefix,
}: {
  cart: SaleCart;
  currency: string;
  busy: boolean;
  error?: string;
  idPrefix: string;
}) {
  // El error de «Otro» sin detalle llega bajo `items`: marca las filas que lo dejaron vacío.
  const noteMissing = error === NOTE_REQUIRED;
  return (
    <Field
      label="Servicios y ofertas" required
      htmlFor={`${idPrefix}-item`}
      error={error}
      hint={
        cart.cart.length === 0
          ? "Busca y agrega uno o más servicios u ofertas."
          : "Puedes seguir agregando más al mismo ticket."
      }
    >
      <div className="space-y-2">
        <SearchSelect
          id={`${idPrefix}-item`}
          value=""
          onChange={cart.add}
          options={cart.choices}
          placeholder={cart.cart.length > 0 ? "Agregar otro servicio u oferta…" : "Elige qué se vendió…"}
          searchPlaceholder="Buscar servicio u oferta…"
          disabled={busy}
          invalid={!!error}
        />
        {cart.cart.length > 0 && (
          <ul aria-label="Ítems de la venta" className="divide-y rounded-md border bg-subtle/50">
            {cart.cart.map((l) => {
              const choice = cart.choices.find((o) => o.value === l.value);
              const isOtherLine = l.value === "other";
              const label = isOtherLine ? "Otro" : (choice?.label ?? "—");
              return (
                <li key={l.key} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {label}
                    {choice?.group === "Ofertas" && (
                      <span className="ml-1.5 text-[11px] font-normal text-text-3">oferta</span>
                    )}
                  </span>
                  {isOtherLine ? (
                    <div className="w-36 shrink-0">
                      <MoneyInput
                        id={`${idPrefix}-other-${l.key}`}
                        value={l.price}
                        onChange={(price) => cart.patch(l.key, { price })}
                        currency={currency}
                        disabled={busy}
                      />
                    </div>
                  ) : (
                    <span className="shrink-0 tabular-nums text-text-2">
                      {money(cart.lineCents(l), currency)}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => cart.remove(l.key)}
                    disabled={busy}
                    aria-label={`Quitar ${label} de la venta`}
                    className="shrink-0 rounded-sm p-1 text-text-3 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                  {isOtherLine && (
                    <Input
                      aria-label="Detalle del servicio u oferta «Otro»"
                      value={l.note}
                      onChange={(e) => cart.patch(l.key, { note: e.target.value })}
                      maxLength={OTHER_NOTE_MAX}
                      placeholder="Escribe qué servicio u oferta es..."
                      disabled={busy}
                      aria-invalid={noteMissing && !l.note.trim()}
                      className={`basis-full ${noteMissing && !l.note.trim() ? "border-danger" : ""}`}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Field>
  );
}

/** «Monto cobrado»: la suma de los ítems, editable a mano. */
export function SaleAmountField({
  cart,
  currency,
  busy,
  error,
  idPrefix,
}: {
  cart: SaleCart;
  currency: string;
  busy: boolean;
  error?: string;
  idPrefix: string;
}) {
  return (
    <Field
      label="Monto cobrado" required
      htmlFor={`${idPrefix}-amount`}
      error={error}
      hint={
        cart.amountEdited
          ? `Editado a mano; la suma de los ítems es ${money(cart.total, currency)}.`
          : "Suma de los ítems; puedes ajustarlo si hace falta."
      }
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <MoneyInput
            id={`${idPrefix}-amount`}
            value={cart.shownAmount}
            onChange={cart.editAmount}
            currency={currency}
            disabled={busy}
            invalid={!!error}
          />
        </div>
        {cart.amountEdited && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={cart.resetAmount}
            disabled={busy}
            className="mt-0.5 shrink-0"
          >
            Usar la suma
          </Button>
        )}
      </div>
    </Field>
  );
}

/** «Método de pago»: Efectivo, Yape / Plin, Tarjeta u Otro. */
export function PaymentMethodField({
  method,
  onChange,
  busy,
  error,
}: {
  method: PaymentMethod | "";
  onChange: (m: PaymentMethod) => void;
  busy: boolean;
  error?: string;
}) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium">
        Método de pago
        <span aria-hidden className="ml-0.5 font-semibold text-danger-text">
          *
        </span>
        <span className="sr-only"> (obligatorio)</span>
      </legend>
      <div role="radiogroup" aria-label="Método de pago" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {PAYMENT_METHODS.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={method === m}
            disabled={busy}
            onClick={() => onChange(m)}
            className={cn(
              "rounded-md border px-2 py-2 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              method === m
                ? "border-brand bg-brand-tint text-brand-text"
                : "text-text-2 hover:bg-accent hover:text-foreground",
            )}
          >
            {PAYMENT_LABELS[m]}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-danger-text">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** «Comisión distinta para esta venta (%)»: opcional, vacío = la regla de siempre. */
export function CustomCommissionField({
  value,
  onChange,
  busy,
  error,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  busy: boolean;
  error?: string;
  id: string;
}) {
  return (
    <Field
      label="Comisión distinta para esta venta (%)"
      htmlFor={id}
      error={error}
      hint="Opcional. Vacío: se aplica la regla de siempre."
    >
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        max={100}
        step={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={busy}
        className="w-32"
      />
    </Field>
  );
}
