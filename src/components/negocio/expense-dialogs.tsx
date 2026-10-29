"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ComboboxInput } from "@/components/ui/combobox-input";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, describeError } from "@/components/negocio/api";
import { Field, fieldErrors, MoneyInput, toInt } from "@/components/negocio/fields";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import { parseMoneyToCents } from "@/lib/money";
import {
  DOZEN_UNITS,
  expenseItemInputSchema,
  type ExpenseItemDto,
  type ExpensePresentation,
} from "@/lib/salon/expenses";
import { centsToInput, money } from "@/lib/salon/format";

/**
 * Módulo SALON — el diálogo de Gastos: registrar o corregir un egreso. Valida con el
 * MISMO esquema Zod que la API. Es un egreso financiero y nada más: un insumo / variable
 * es un gasto por su precio total (paquetes y unidades por paquete son solo el detalle
 * de lo comprado: no hay almacén ni stock).
 */

export function ExpenseDialog({
  item,
  currency,
  today,
  onClose,
  onSaved,
}: {
  item: ExpenseItemDto | null;
  currency: string;
  today: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [isFixed, setIsFixed] = useState(item?.isFixed ?? false);
  const [name, setName] = useState(item?.name ?? "");
  const [presentation, setPresentation] = useState<ExpensePresentation>(
    item?.presentation ?? (item?.unitsPerPackage ? "package" : "units")
  );
  // Unidades por paquete de la última compra de cada nombre, para autocompletar.
  const [packSizes, setPackSizes] = useState<Record<string, number>>({});
  const [quantity, setQuantity] = useState(item?.quantity ? String(item.quantity) : "");
  const [perPackage, setPerPackage] = useState(item?.unitsPerPackage ? String(item.unitsPerPackage) : "");
  const [price, setPrice] = useState(item ? centsToInput(item.totalPriceCents) : "");
  const [date, setDate] = useState(item?.expenseDate ?? today);
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState<string[]>([]);

  // Los nombres que el negocio ya usó, para autocompletar y no duplicarlos con otra ortografía.
  useEffect(() => {
    let alive = true;
    apiFetch<{ names: string[]; packSizes?: Record<string, number> }>(
      `/api/negocio/gastos/nombres?kind=${isFixed ? "fixed" : "variable"}`
    )
      .then((r) => {
        if (!alive) return;
        setNames(r.names);
        setPackSizes(r.packSizes ?? {});
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [isFixed]);

  // En «Paquete / Caja», si ese nombre ya se compró antes, se propone su tamaño de paquete.
  useEffect(() => {
    if (isFixed || presentation !== "package" || perPackage !== "") return;
    const known = packSizes[name.trim().toLowerCase()];
    if (known) setPerPackage(String(known));
  }, [name, presentation, packSizes, isFixed, perPackage]);

  const qtyNum = quantity.trim() === "" ? null : toInt(quantity);
  const perNum = perPackage.trim() === "" ? null : toInt(perPackage);
  const validQty = qtyNum !== null && !Number.isNaN(qtyNum) && qtyNum > 0 ? qtyNum : null;
  const validPer = perNum !== null && !Number.isNaN(perNum) && perNum > 0 ? perNum : null;
  const totalUnits =
    validQty === null
      ? null
      : presentation === "dozen"
        ? validQty * DOZEN_UNITS
        : presentation === "package"
          ? validPer === null
            ? null
            : validQty * validPer
          : validQty;
  const priceCents = parseMoneyToCents(price);
  // Resumen en vivo: total de unidades y costo por unidad (solo referencia, no se guarda).
  const summary =
    isFixed || totalUnits === null || validQty === null
      ? null
      : {
          units:
            presentation === "dozen"
              ? `${validQty} ${validQty === 1 ? "docena" : "docenas"} = ${totalUnits} unidades en total`
              : presentation === "package" && validPer !== null
                ? `${validQty} ${validQty === 1 ? "paquete" : "paquetes"} × ${validPer} unidades = ${totalUnits} ${totalUnits === 1 ? "unidad" : "unidades"} en total`
                : `${totalUnits} ${totalUnits === 1 ? "unidad" : "unidades"} en total`,
          unitCost:
            priceCents !== null && !Number.isNaN(priceCents) && priceCents > 0
              ? money(Math.round(priceCents / totalUnits), currency)
              : null,
        };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = expenseItemInputSchema.safeParse({
      isFixed,
      name,
      quantity: isFixed || quantity.trim() === "" ? null : toInt(quantity),
      presentation: isFixed ? null : presentation,
      unitsPerPackage:
        isFixed || presentation !== "package" || perPackage.trim() === "" ? null : toInt(perPackage),
      totalPriceCents: parseMoneyToCents(price) ?? Number.NaN,
      expenseDate: date,
      notes,
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await apiFetch(item ? `/api/negocio/gastos/${item.id}` : "/api/negocio/gastos", {
        method: item ? "PUT" : "POST",
        json: parsed.data,
      });
      onSaved();
    } catch (err) {
      setFormError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={item ? "Editar gasto" : "Registrar gasto"}
      description="Se descuenta de la ganancia del mes de su fecha."
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <div role="radiogroup" aria-label="Tipo de gasto" className="grid grid-cols-2 gap-2">
          {[
            { fixed: true, title: "Gasto fijo", hint: "Alquiler, luz, agua…" },
            { fixed: false, title: "Insumo / variable", hint: "Cuchillas, productos…" },
          ].map((o) => (
            <button
              key={o.title}
              type="button"
              role="radio"
              aria-checked={isFixed === o.fixed}
              disabled={busy}
              onClick={() => setIsFixed(o.fixed)}
              className={`rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                isFixed === o.fixed ? "border-brand bg-brand-tint" : "hover:bg-row-hover"
              }`}
            >
              <span className="block text-sm font-semibold">{o.title}</span>
              <span className="block text-xs text-text-3">{o.hint}</span>
            </button>
          ))}
        </div>

        <Field label="Nombre del gasto" required htmlFor="exp-name" error={errors.name}>
          <ComboboxInput
            maxLength={120}
            id="exp-name"
            value={name}
            onChange={setName}
            options={names.map((n) => ({ value: n }))}
            newHint="Nombre nuevo: se guardará tal cual."
            placeholder={isFixed ? "Ej. Alquiler del local" : "Ej. Hoja de afeitar"}
            disabled={busy}
            invalid={!!errors.name}
          />
        </Field>

        {!isFixed && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <p className="mb-1.5 text-sm font-medium">Tipo de presentación</p>
              <div role="radiogroup" aria-label="Tipo de presentación" className="grid grid-cols-3 gap-2">
                {[
                  { value: "units" as const, title: "Unidades" },
                  { value: "package" as const, title: "Paquete / Caja" },
                  { value: "dozen" as const, title: "Docena" },
                ].map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={presentation === o.value}
                    disabled={busy}
                    onClick={() => setPresentation(o.value)}
                    className={`rounded-md border px-3 py-2 text-left text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      presentation === o.value ? "border-brand bg-brand-tint" : "hover:bg-row-hover"
                    }`}
                  >
                    {o.title}
                  </button>
                ))}
              </div>
            </div>
            <Field
              label={
                presentation === "package"
                  ? "Cantidad de paquetes o cajas"
                  : presentation === "dozen"
                    ? "Cantidad de docenas"
                    : "Cantidad"
              }
              htmlFor="exp-qty"
              error={errors.quantity}
              hint="Opcional, solo de referencia."
            >
              <Input
                id="exp-qty"
                inputMode="numeric"
                autoComplete="off"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value.replace(/\D/g, "").slice(0, 6))}
                disabled={busy}
                aria-invalid={!!errors.quantity}
              />
            </Field>
            {presentation === "package" && (
              <Field
                label="Unidades por paquete o caja"
                htmlFor="exp-per"
                error={errors.unitsPerPackage}
                hint="Ej. 12 unidades por caja."
              >
                <Input
                  id="exp-per"
                  inputMode="numeric"
                  autoComplete="off"
                  value={perPackage}
                  onChange={(e) => setPerPackage(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  disabled={busy}
                  aria-invalid={!!errors.unitsPerPackage}
                />
              </Field>
            )}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={isFixed ? "Monto total" : "Precio total pagado"}
            required
            htmlFor="exp-price"
            error={errors.totalPriceCents}
            hint={isFixed ? undefined : "Lo que costó toda la compra."}
          >
            <MoneyInput
              id="exp-price"
              value={price}
              onChange={setPrice}
              currency={currency}
              disabled={busy}
              invalid={!!errors.totalPriceCents}
            />
          </Field>
          <Field
            label={isFixed ? "Fecha de pago" : "Fecha de compra"}
            required
            htmlFor="exp-date"
            error={errors.expenseDate}
          >
            <DatePicker
              id="exp-date"
              value={date}
              onChange={setDate}
              disabled={busy}
              invalid={!!errors.expenseDate}
              className="w-full"
            />
          </Field>
        </div>

        {summary && (
          <div
            aria-live="polite"
            className="rounded-md border bg-subtle px-3 py-2 text-sm"
            data-testid="expense-summary"
          >
            <p className="font-medium">{summary.units}</p>
            {summary.unitCost && (
              <p className="text-xs text-text-3">Costo por unidad estimado: {summary.unitCost} c/u</p>
            )}
          </div>
        )}

        <Field label="Notas" htmlFor="exp-notes" error={errors.notes} hint="Opcional.">
          <Textarea
            id="exp-notes"
            rows={2}
            maxLength={500}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={busy}
          />
        </Field>

        <ModalFooter error={formError}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Guardando…" : item ? "Guardar cambios" : "Registrar gasto"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
