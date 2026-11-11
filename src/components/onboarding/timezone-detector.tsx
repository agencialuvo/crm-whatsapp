"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * No pinta nada. Mientras el negocio no tenga zona horaria elegida, informa la del navegador (la del
 * país desde donde se usa el sistema) para que se guarde como la del negocio. Se intenta una vez por
 * pestaña; un fallo no molesta a nadie: seguirá valiendo la de por defecto hasta elegirla en Marca.
 */
export function TimezoneDetector() {
  const router = useRouter();
  useEffect(() => {
    let tz = "";
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
      if (!tz || sessionStorage.getItem("tz-detect") === "1") return;
      sessionStorage.setItem("tz-detect", "1");
    } catch {
      if (!tz) return;
    }
    fetch("/api/settings/timezone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timezone: tz }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { saved?: boolean } | null) => {
        // Re-renderiza para que «hoy» y los días ya se cuenten en la zona nueva.
        if (d?.saved) router.refresh();
      })
      .catch(() => undefined);
  }, [router]);
  return null;
}
