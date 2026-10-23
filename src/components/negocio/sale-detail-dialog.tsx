"use client";

import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import { money, wallClockInTz } from "@/lib/salon/format";
import { PAYMENT_LABELS } from "@/lib/salon/schemas";
import type { SaleRowDto } from "@/lib/salon/types";

/**
 * Módulo SALON — detalle de una venta de Caja (solo lectura): cuándo, a quién,
 * quién atendió, qué se cobró y cómo se repartió. La fecha y la hora van en la
 * zona del negocio.
 */
export function SaleDetailDialog({
  sale,
  currency,
  timezone,
  onClose,
  onEdit,
}: {
  sale: SaleRowDto;
  currency: string;
  timezone: string;
  onClose: () => void;
  onEdit: () => void;
}) {
  const at = wallClockInTz(sale.createdAt, timezone);
  const rows: [string, React.ReactNode][] = [
    ["Fecha y hora", `${at.date.split("-").reverse().join("/")} · ${at.time}`],
    ["Cliente", sale.customerName],
    ["Atendió", sale.staffName],
    ["Método de pago", PAYMENT_LABELS[sale.paymentMethod]],
    ["Monto total", <strong key="m">{money(sale.amountCents, currency)}</strong>],
    ["Comisión del profesional", money(sale.staffCommissionCents, currency)],
    ["Ganancia neta", <strong key="n">{money(sale.businessNetCents, currency)}</strong>],
  ];

  return (
    <Modal title="Detalle de la venta" description={sale.itemName} onClose={onClose}>
      <div className="space-y-4">
        <section aria-label="Lo cobrado">
          <h3 className="mb-1.5 text-sm font-semibold">Servicios y ofertas</h3>
          <ul className="divide-y rounded-md border text-sm">
            {sale.items.map((i, idx) => (
              <li key={idx} className="flex items-start justify-between gap-3 px-3 py-2">
                <span className="min-w-0">
                  <span className="font-medium">{i.name}</span>
                  {i.kind === "combo" && <span className="ml-1.5 text-[11px] text-text-3">oferta</span>}
                  {i.note && <span className="block text-xs text-text-2">{i.note}</span>}
                </span>
                <span className="shrink-0 tabular-nums text-text-2">{money(i.amountCents, currency)}</span>
              </li>
            ))}
          </ul>
        </section>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-text-3">{label}</dt>
              <dd className="text-right tabular-nums sm:text-left">{value}</dd>
            </div>
          ))}
        </dl>

        <ModalFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
          <Button type="button" variant="outline" onClick={onEdit}>
            Editar venta
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  );
}
