"use client";

import { useCallback, useEffect, useMemo } from "react";
import { captchaSiteKey, type CaptchaAction } from "@/lib/captcha";

type Grecaptcha = {
  ready: (cb: () => void) => void;
  execute: (siteKey: string, opts: { action: string }) => Promise<string>;
};

declare global {
  interface Window {
    grecaptcha?: Grecaptcha;
  }
}

let loader: Promise<Grecaptcha> | null = null;

/** Carga el script de Google una sola vez por pestaña. */
function loadRecaptcha(siteKey: string): Promise<Grecaptcha> {
  if (!loader) {
    loader = new Promise<Grecaptcha>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}&hl=es`;
      s.async = true;
      s.onload = () => {
        const g = window.grecaptcha;
        if (!g) return reject(new Error("recaptcha"));
        g.ready(() => resolve(g));
      };
      s.onerror = () => {
        loader = null;
        reject(new Error("recaptcha"));
      };
      document.head.appendChild(s);
    });
  }
  return loader;
}

export type CaptchaState = {
  /** Hay claves configuradas: el formulario debe pedir el token al enviar. */
  enabled: boolean;
  /**
   * Token de un solo uso para `action`, o `null` si no se pudo obtener (sin red a Google,
   * script bloqueado). Pídelo en cada envío: invisible para la persona, sin casilla.
   */
  execute: (action: CaptchaAction) => Promise<string | null>;
};

/** reCAPTCHA v3 de un formulario. Precarga el script al montar para que el envío sea inmediato. */
export function useCaptcha(): CaptchaState {
  const siteKey = captchaSiteKey();

  useEffect(() => {
    if (siteKey) loadRecaptcha(siteKey).catch(() => undefined);
  }, [siteKey]);

  const execute = useCallback(
    async (action: CaptchaAction) => {
      if (!siteKey) return null;
      try {
        const g = await loadRecaptcha(siteKey);
        return await g.execute(siteKey, { action });
      } catch {
        return null;
      }
    },
    [siteKey]
  );

  return useMemo(() => ({ enabled: siteKey !== null, execute }), [siteKey, execute]);
}

/**
 * Aviso que Google exige cuando se oculta la insignia flotante (ver `.grecaptcha-badge` en
 * `globals.css`): la protección es invisible, pero se dice que está.
 */
export function CaptchaNotice({ captcha }: { captcha: CaptchaState }) {
  if (!captcha.enabled) return null;
  return (
    <p className="text-center text-[11px] leading-snug text-text-3" data-testid="captcha-notice">
      Protegido por reCAPTCHA ·{" "}
      <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer" className="underline hover:text-text-2">
        Privacidad
      </a>{" "}
      ·{" "}
      <a href="https://policies.google.com/terms" target="_blank" rel="noreferrer" className="underline hover:text-text-2">
        Términos
      </a>
    </p>
  );
}
