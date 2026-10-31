"use client";

import { useEffect, useState } from "react";
import { apiFetch, describeError } from "@/components/negocio/api";
import { LoyaltyCardPanel } from "@/components/negocio/loyalty-card";
import { Modal } from "@/components/negocio/modal";
import { DataTablePagination, DataTableToolbar } from "@/components/ui/data-table-pagination";
import { useDataTable } from "@/components/ui/use-data-table";
import { birthdayLabel, dateNumeric, formatPeruPhone, money } from "@/lib/salon/format";
import { PAYMENT_LABELS } from "@/lib/salon/schemas";
import type { SalonClientDetailDto } from "@/lib/salon/types";

/** Lista vacía estable mientras la ficha carga. */
const NONE: never[] = [];

/**
 * Módulo SALON — la ficha de un cliente: sus datos (celular, cumpleaños, notas) y la línea de tiempo: cada atención con su fecha
 * (DD/MM/AAAA, sin hora), lo que se hizo, quién atendió, cómo pagó y cuánto. Se
 * abre desde el número de «Visitas» de la lista; es solo lectura.
 */
export function ClientHistoryDialog({
  clientId,
  currency,
  timezone,
  onClose,
}: {
  clientId: string;
  currency: string;
  timezone: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<SalonClientDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const table = useDataTable(detail?.history ?? NONE, { view: "ficha-cliente" });

  useEffect(() => {
    let alive = true;
    apiFetch<SalonClientDetailDto>(`/api/negocio/clientes/${clientId}`)
      .then((d) => alive && setDetail(d))
      .catch((err) => alive && setError(describeError(err)));
    return () => {
      alive = false;
    };
  }, [clientId]);

  const client = detail?.client;
  return (
    <Modal
      title={client ? `Ficha de ${client.name}` : "Ficha del cliente"}
      description={
        client
          ? `${client.visits} visita${client.visits === 1 ? "" : "s"} · ${money(client.totalCents, currency)} invertidos`
          : undefined
      }
      onClose={onClose}
      size="lg"
    >
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-danger-text"
        >
          {error}
        </p>
      ) : !detail ? (
        <div className="space-y-2" aria-busy aria-label="Cargando">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded-md bg-subtle" />
          ))}
        </div>
      ) : null}
      {detail && (
        <dl className="mb-3 grid gap-x-6 gap-y-1.5 rounded-md border bg-subtle/50 px-3 py-2.5 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-text-3">Celular</dt>
            <dd className="tabular-nums">{formatPeruPhone(client?.phone)}</dd>
          </div>
          <div>
            <dt className="text-xs text-text-3">Cumpleaños</dt>
            <dd>{birthdayLabel(client?.birthdayDay ?? null, client?.birthdayMonth ?? null)}</dd>
          </div>
          <div>
            <dt className="text-xs text-text-3">Cliente desde</dt>
            <dd className="tabular-nums">{client ? dateNumeric(client.registeredAt, timezone) : "—"}</dd>
          </div>
          {client?.notes && (
            <div className="sm:col-span-3">
              <dt className="text-xs text-text-3">Notas</dt>
              <dd>{client.notes}</dd>
            </div>
          )}
        </dl>
      )}
      {detail && <LoyaltyCardPanel contactId={clientId} className="mb-3" />}
      {error ? null : !detail ? null : detail.history.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-sm text-text-2">
          Todavía no tiene atenciones registradas.
        </p>
      ) : (
        <>
        <DataTableToolbar {...table.pagination} noun={{ one: "atención", other: "atenciones" }} />
        <div className="relative max-h-[60vh] overflow-auto rounded-md border">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b bg-subtle text-left text-xs font-semibold text-text-2">
                <th scope="col" className="px-3 py-2">
                  Fecha de atención
                </th>
                <th scope="col" className="px-2 py-2">
                  Servicio / oferta
                </th>
                <th scope="col" className="px-2 py-2">
                  Atendió
                </th>
                <th scope="col" className="px-2 py-2">
                  Método de pago
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Monto
                </th>
              </tr>
            </thead>
            <tbody>
              {table.rows.map((h) => (
                <tr key={h.id} className="border-b last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-text-2">
                    {dateNumeric(h.createdAt, timezone)}
                  </td>
                  <td className="px-2 py-2">
                    {h.itemName}
                    {h.itemKind === "combo" && (
                      <span className="ml-1.5 text-[11px] text-text-3">oferta</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2">{h.staffName}</td>
                  <td className="whitespace-nowrap px-2 py-2">{PAYMENT_LABELS[h.paymentMethod]}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">
                    {money(h.amountCents, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
      {detail && detail.history.length > 0 && (
        <DataTablePagination
          {...table.pagination}
          noun={{ one: "atención", other: "atenciones" }}
          label="Paginación de atenciones"
        />
      )}
    </Modal>
  );
}
