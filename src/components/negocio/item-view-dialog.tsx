"use client";

import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/negocio/modal";
import { staffPreview, type StaffOption } from "@/components/negocio/staff-select";
import { durationLabel, money } from "@/lib/salon/format";
import type { ComboDto, ServiceDto } from "@/lib/salon/types";

/**
 * Módulo SALON — el ojo del catálogo: ver un servicio u oferta sin poder
 * cambiarlo. Se cierra con la X, con Escape o tocando fuera.
 */
export function ItemViewDialog({
  target,
  currency,
  staff,
  onClose,
}: {
  target: { kind: "service"; item: ServiceDto } | { kind: "combo"; item: ComboDto };
  currency: string;
  staff: StaffOption[];
  onClose: () => void;
}) {
  const { item } = target;
  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "Precio", value: <span className="font-semibold">{money(item.priceCents, currency)}</span> },
    { label: "Duración", value: durationLabel(item.durationMinutes) },
  ];
  if (target.kind === "service") {
    rows.push({
      label: "Comisión por defecto",
      value:
        target.item.defaultCommissionPercentage === null ? "Sin comisión" : `${target.item.defaultCommissionPercentage}%`,
    });
  } else {
    rows.push({
      label: "Palabra clave del anuncio",
      value: target.item.keywordTrigger ? (
        <Badge variant="secondary" className="font-mono">
          {target.item.keywordTrigger}
        </Badge>
      ) : (
        "—"
      ),
    });
  }
  rows.push({ label: "Estado", value: item.active ? "Activo" : "Desactivado" });

  return (
    <Modal
      title={item.name}
      description={target.kind === "service" ? "Servicio" : "Oferta"}
      onClose={onClose}
      closeButton
    >
      {item.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.imageUrl}
          alt={item.name}
          // Si el archivo ya no existe (se borró de la galería), no se deja un icono roto.
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
          className="mb-4 aspect-[16/9] w-full rounded-md border object-cover"
        />
      )}
      {/* El nombre y, a continuación, quién lo da: la lista completa del equipo si
          no se detalló, o «Profesional: …» con los elegidos. */}
      <p className="mb-4 text-sm text-text-2">{staffPreview({ kind: target.kind, id: item.id, staffIds: item.staffIds }, staff)}</p>
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-xs font-semibold text-text-2">Descripción</dt>
          <dd className="mt-0.5 whitespace-pre-wrap break-words">{item.description || "—"}</dd>
        </div>
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-4 border-t pt-3">
            <dt className="text-xs font-semibold text-text-2">{r.label}</dt>
            <dd className="text-right tabular-nums">{r.value}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
