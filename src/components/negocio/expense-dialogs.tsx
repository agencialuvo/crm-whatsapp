"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ComboboxInput } from "@/components/ui/combobox-input";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, describeError } from "@/components/negocio/api";
import { Field, fieldErrors, MoneyInput, toInt } from "@/components/negocio/fields";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import { parseMoneyToCents } from "@/lib/money";
import {
  EXPENSE_MEASURE_UNITS,
  EXPENSE_PRESENTATION_LABELS,
  EXPENSE_PRESENTATIONS,
  expenseItemInputSchema,
  expenseTotalUnits,
  expenseUnitCostCents,
  type ExpenseItemDto,
  type ExpenseMeasureUnit,
  type ExpensePresentation,
} from "@/lib/salon/expenses";
import { centsToInput, money } from "@/lib/salon/format";

/**
 * Módulo SALON — el diálogo de Gastos: registrar o corregir un egreso. Valida con el
 * MISMO esquema Zod que la API. Es un egreso financiero y nada más: un insumo / variable
 * es un gasto por su precio total (cantidad y unidad son solo el detalle de lo comprado:
 * no hay almacén ni stock). Los textos son neutros: sirven a cualquier rubro.
 */

const PRESENTATION_OPTIONS = EXPENSE_PRESENTATIONS.map((v) => ({
  value: v,
  label: EXPENSE_PRESENTATION_LABELS[v].title,
  hint: EXPENSE_PRESENTATION_LABELS[v].short || "L · ml · kg · g",
}));
const MEASURE_OPTIONS = EXPENSE_MEASURE_UNITS.map((u) => ({
  value: u,
  label: u === "l" ? "Litros (L)" : u === "ml" ? "Mililitros (ml)" : u === "kg" ? "Kilos (kg)" : "Gramos (g)",
}));
/** Sufijo del costo por unidad según la presentación. */
function unitSuffix(p: ExpensePresentation, m: ExpenseMeasureUnit): string {
  return p === "measure" ? (m === "l" ? "L" : m) : p === "service" ? "srv" : "und";
}

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
  const [measureUnit, setMeasureUnit] = useState<ExpenseMeasureUnit>(item?.measureUnit ?? "kg");
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
  const priceCents = parseMoneyToCents(price);
  // Costo por unidad: solo una referencia en vivo, no se guarda ni frena el registro.
  const perUnit = presentation === "package" ? validPer : null;
  const totalUnits =
    validQty === null || (presentation === "package" && perUnit === null)
      ? null
      : expenseTotalUnits({ quantity: validQty, unitsPerPackage: perUnit });
  const unitCost =
    isFixed || validQty === null || (presentation === "package" && perUnit === null) || priceCents === null || Number.isNaN(priceCents)
      ? null
      : expenseUnitCostCents({ totalPriceCents: priceCents, quantity: validQty, unitsPerPackage: perUnit });

  /** Ocultar una sugerencia: no borra ningún gasto, solo limpia la lista. */
  function hideName(o: { value: string }) {
    setNames((list) => list.filter((n) => n !== o.value));
    apiFetch("/api/negocio/gastos/nombres", {
      method: "DELETE",
      json: { kind: isFixed ? "fixed" : "variable", name: o.value },
    }).catch(() => undefined);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = expenseItemInputSchema.safeParse({
      isFixed,
      name,
      quantity: isFixed || quantity.trim() === "" ? null : toInt(quantity),
      presentation: isFixed ? null : presentation,
      measureUnit: isFixed || presentation !== "measure" ? null : measureUnit,
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
      description="Resta de la ganancia neta del mes de su fecha, desde hoy."
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <div role="radiogroup" aria-label="Tipo de gasto" className="grid grid-cols-2 gap-2">
          {[
            { fixed: true, title: "Gasto fijo", hint: "Se paga cada periodo" },
            { fixed: false, title: "Gasto variable / insumo", hint: "Cambia según la compra" },
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
            onRemoveOption={hideName}
            removeLabel="Quitar de las sugerencias"
            placeholder={
              isFixed
                ? "Ej. Alquiler del local, Software SaaS, Nómina, Internet"
                : "Ej. Insumos operativos, Materia prima, Productos de reventa"
            }
            disabled={busy}
            invalid={!!errors.name}
          />
        </Field>

        {!isFixed && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field
                label="Unidad de medida"
                htmlFor="exp-presentation"
                hint="Cómo se compró. Opcional, solo de referencia."
              >
                <SearchSelect
                  id="exp-presentation"
                  value={presentation}
                  onChange={(v) => setPresentation(v as ExpensePresentation)}
                  options={PRESENTATION_OPTIONS}
                  searchPlaceholder="Buscar unidad…"
                  disabled={busy}
                />
              </Field>
            </div>
            <Field label="Cantidad" htmlFor="exp-qty" error={errors.quantity}>
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
              <Field label="Unidades por paquete" htmlFor="exp-per" error={errors.unitsPerPackage}>
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
            {presentation === "measure" && (
              <Field label="Medida" htmlFor="exp-measure" error={errors.measureUnit}>
                <SearchSelect
                  id="exp-measure"
                  value={measureUnit}
                  onChange={(v) => setMeasureUnit(v as ExpenseMeasureUnit)}
                  options={MEASURE_OPTIONS}
                  searchPlaceholder="Buscar medida…"
                  disabled={busy}
                  invalid={!!errors.measureUnit}
                />
              </Field>
            )}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={isFixed ? "Monto" : "Precio total pagado"}
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
            label={isFixed ? "Fecha de vencimiento" : "Fecha de compra"}
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

        {unitCost !== null && (
          <p aria-live="polite" className="text-xs text-text-3" data-testid="expense-summary">
            Costo estimado: {money(unitCost, currency)} por {unitSuffix(presentation, measureUnit)}
            {totalUnits !== null && presentation === "package" ? ` · ${totalUnits} und en total` : ""}
          </p>
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
