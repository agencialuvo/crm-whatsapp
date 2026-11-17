"use client";

import { useEffect, useRef, useState } from "react";
import { nextTickMs, type WindowFields } from "@/lib/inbox-window";

/**
 * 042 — El reloj de la bandeja: devuelve «ahora» en hora del SERVIDOR (el reloj del navegador más el desfase
 * que midió la última respuesta), y re-renderiza cuando algo puede haber cambiado de estado.
 *
 * Late cada 60 s y cada segundo en el último tramo antes de que cierre la ventana de la conversación abierta
 * (`nextTickMs`). Al volver a ver la pestaña late de inmediato: los temporizadores de una pestaña oculta se
 * frenan y al volver podrían marcar «abierta» una ventana que ya cerró.
 */
export function useInboxClock(selected: WindowFields | null, offsetMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const offsetRef = useRef(offsetMs);
  offsetRef.current = offsetMs;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const current = selectedRef.current;
      const wait = current ? nextTickMs(current, Date.now() + offsetRef.current) : null;
      timer = setTimeout(tick, Math.min(wait ?? 60_000, 60_000));
    };
    const tick = () => {
      setNow(Date.now());
      schedule();
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      tick();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Cambiar de conversación o de desfase vuelve a calcular ya, sin esperar al siguiente latido.
  const selectedKey = selected ? `${selected.windowExpiresAt}|${selected.humanWindow?.expiresAt}` : "";
  useEffect(() => {
    setNow(Date.now());
  }, [selectedKey, offsetMs]);

  return now + offsetMs;
}
