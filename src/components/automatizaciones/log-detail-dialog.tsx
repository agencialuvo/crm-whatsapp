"use client";

import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/negocio/modal";
import {
  describeLog,
  formatWhen,
  logStatusLabel,
  logStatusTone,
  prettyJson,
  type LogDto,
} from "@/lib/automation-monitor-dto";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2 py-2 text-sm">
      <dt className="text-text-3">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold text-text-2">{label}</p>
      <pre
        tabIndex={0}
        className="max-h-56 overflow-auto rounded-md border bg-subtle p-3 text-xs leading-relaxed"
        aria-label={label}
      >
        {prettyJson(value)}
      </pre>
    </div>
  );
}

/**
 * Automatizaciones — el detalle de una línea del historial: qué se ejecutó, con quién, cómo terminó y la
 * «foto» que el motor guardó en ese momento (el paso tal como estaba, el mensaje enviado, su ID en
 * WhatsApp o el error exacto). La foto sirve aunque el paso se haya editado o borrado después.
 */
export function LogDetailDialog({ log, onClose }: { log: LogDto; onClose: () => void }) {
  const d = describeLog(log);
  return (
    <Modal
      title="Detalle de la ejecución"
      description={`${log.flowName} · ${formatWhen(log.executedAt)}`}
      onClose={onClose}
      size="lg"
    >
      <div className="space-y-4">
        <dl className="divide-y rounded-md border px-3">
          <Row label="Estado">
            <Badge variant={logStatusTone(log.status)}>{logStatusLabel(log.status)}</Badge>
          </Row>
          <Row label="Contacto">
            <span className="font-medium">{log.contact.name}</span>
            {log.contact.phone && <span className="text-text-3"> · {log.contact.phone}</span>}
          </Row>
          <Row label="Paso">
            {d.title}
            {!d.stepExists && <span className="text-text-3"> (el paso ya no existe)</span>}
          </Row>
          {d.attempt !== null && <Row label="Intento">{d.attempt}</Row>}
          {d.windowOpen !== null && (
            <Row label="Ventana de 24 h">{d.windowOpen ? "Abierta: se envió mensaje libre" : "Cerrada: se envió con plantilla"}</Row>
          )}
          {d.waMessageId && (
            <Row label="ID en WhatsApp">
              <code className="break-all text-xs">{d.waMessageId}</code>
            </Row>
          )}
          {d.messageId && (
            <Row label="Mensaje en el CRM">
              <code className="break-all text-xs">{d.messageId}</code>
            </Row>
          )}
          {d.nextAt && <Row label="Siguiente paso">{formatWhen(d.nextAt)}</Row>}
        </dl>

        {d.error && (
          <div role="alert" className="rounded-md border border-danger-soft bg-danger-tint p-3 text-sm text-danger-text">
            <p className="text-xs font-semibold">Error</p>
            <p className="mt-1 break-words font-mono text-xs">{d.error}</p>
            {d.errorHint && <p className="mt-2 text-sm">{d.errorHint}</p>}
          </div>
        )}

        {d.skipReason && (
          <p className="rounded-md border border-warning-soft bg-warning-tint p-3 text-sm text-warning-text">
            {d.skipReason}
          </p>
        )}

        {d.payload !== null && <Json label="Mensaje enviado (payload)" value={d.payload} />}
        {d.stepConfig && <Json label="Ajustes del paso al ejecutarse" value={d.stepConfig} />}
        {d.raw && <Json label="Datos técnicos completos (metadata)" value={d.raw} />}
        {!d.raw && <p className="text-sm text-text-3">Esta línea no guardó datos técnicos.</p>}
      </div>
    </Modal>
  );
}
