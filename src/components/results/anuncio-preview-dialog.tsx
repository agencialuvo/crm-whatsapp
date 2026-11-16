"use client";

import { useState } from "react";
import { ExternalLink, ImageOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/negocio/modal";
import type { AdRowDto } from "@/lib/analytics";
import { etiquetaDeOrigen, titularDeOrigen } from "@/lib/anuncios";
import { safePreviewLink } from "@/lib/meta/ads";

/**
 * 040 — La vista previa de un anuncio: el creativo en grande, su titular y texto, la campaña y el conjunto, y un
 * enlace a la vista previa nativa de Meta si hay. La imagen es la COPIA local del creativo (`/api/media/{id}`), nunca
 * un enlace al CDN de Meta; el enlace externo se valida otra vez aquí antes de convertirse en `href`.
 *
 * Sin imagen ni textos (anuncio de una cuenta sin sincronizar, o un creativo dinámico sin titular) lo dice en vez de
 * abrir vacío.
 */
export function AnuncioPreviewDialog({ anuncio: a, onClose }: { anuncio: AdRowDto; onClose: () => void }) {
  const [rota, setRota] = useState(false);
  const imagen = a.creative?.assetId ?? a.imageAssetId ?? null;
  const titular = a.creative?.title ?? null;
  const texto = a.creative?.body ?? null;
  const nombre = a.adName ?? titularDeOrigen(a.headline, a.sourceType);
  const ruta = [a.campaignName, a.adsetName].filter(Boolean).join(" › ");
  const enlace = safePreviewLink(a.creative?.previewLink);
  const sinNada = !imagen && !titular && !texto;

  return (
    <Modal title={nombre} description={ruta || undefined} onClose={onClose} size="lg">
      <div className="space-y-4" data-preview-anuncio>
        {imagen && !rota ? (
          <div className="flex justify-center rounded-lg border bg-subtle p-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- copia local servida con sesión; no hay host que optimizar */}
            <img
              src={`/api/media/${imagen}`}
              alt={`Creativo: ${nombre}`}
              onError={() => setRota(true)}
              className="max-h-[55vh] w-auto max-w-full rounded object-contain"
              data-preview-imagen
            />
          </div>
        ) : (
          <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-subtle text-text-3" data-preview-sin-imagen>
            <ImageOff className="h-6 w-6" aria-hidden />
            <p className="text-sm">{rota ? "No se pudo cargar la imagen del creativo." : "Este anuncio no tiene imagen guardada."}</p>
          </div>
        )}

        {(titular || texto) && (
          <div className="space-y-2">
            {titular && (
              <div>
                <p className="kicker">Titular</p>
                <p className="mt-0.5 text-sm font-semibold" data-preview-titular>
                  {titular}
                </p>
              </div>
            )}
            {texto && (
              <div>
                <p className="kicker">Texto principal</p>
                <p className="mt-0.5 whitespace-pre-wrap text-sm text-text-2" data-preview-texto>
                  {texto}
                </p>
              </div>
            )}
          </div>
        )}

        {sinNada && (
          <p className="text-sm text-text-3" data-preview-vacio>
            Todavía no hay titular, texto ni imagen de este anuncio. Se traen de Meta al sincronizar la cuenta
            publicitaria (Ajustes → Anuncios); un anuncio dinámico puede no traer titular ni texto propios.
          </p>
        )}

        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
          {a.campaignName && (
            <div>
              <dt className="kicker">Campaña</dt>
              <dd data-preview-campana>{a.campaignName}</dd>
            </div>
          )}
          {a.adsetName && (
            <div>
              <dt className="kicker">Conjunto de anuncios</dt>
              <dd data-preview-conjunto>{a.adsetName}</dd>
            </div>
          )}
          <div>
            <dt className="kicker">Origen</dt>
            <dd className="flex flex-wrap items-center gap-1.5">
              {etiquetaDeOrigen(a.sourceType)}
              {a.status === "paused" && <Badge variant="warning">Pausado en Meta</Badge>}
              {a.status === "archived" && <Badge variant="secondary">Archivado</Badge>}
            </dd>
          </div>
          {a.sourceId && (
            <div>
              <dt className="kicker">ID del anuncio</dt>
              <dd className="font-mono text-xs">{a.sourceId}</dd>
            </div>
          )}
        </dl>

        {enlace && (
          <a
            href={enlace}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:underline"
            data-preview-enlace
          >
            Abrir vista previa en Meta
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        )}
      </div>
    </Modal>
  );
}
