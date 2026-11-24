"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCoins, formatCoinsLabel, pricePerCoinCents } from "@/lib/credits";
import {
  checkoutConfig,
  CULQI_CHECKOUT_SRC,
  normalizePhone,
  POLL_MAX_MS,
  POLL_MS,
  purchaseErrorMessage,
  topupView,
  type TopupStatusDto,
  type TopupView,
} from "@/lib/credits-topup-ui";
import { formatMoneyCents } from "@/lib/money";
import type { PublicPackDto } from "@/lib/super-admin-credits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Ajustes → Monedas: comprar una recarga. Lista los paquetes ACTIVOS (`GET /api/credits/packs`), inicia la compra
 * (`POST /api/credits/topups`), abre el checkout de Culqi con la llave PÚBLICA y la orden que devolvió el servidor, y
 * consulta el estado (`GET /api/credits/topups/[id]`) hasta que se acredite, falle o venza. Esta pantalla jamás abona
 * nada ni decide montos: el servidor lo hace al confirmar el pago con Culqi. No guarda ni muestra secretos.
 */

const PENDING_KEY = "lia.topup.pending";
const PHONE_KEY = "lia.topup.phone";

type CulqiCheckoutCtor = new (publicKey: string, config: unknown) => { open: () => void; culqi?: () => void };
declare global {
  interface Window {
    CulqiCheckout?: CulqiCheckoutCtor;
  }
}

const remember = (id: string | null) => {
  try {
    if (id) window.sessionStorage.setItem(PENDING_KEY, id);
    else window.sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* sin almacenamiento: solo se pierde retomar tras recargar la página */
  }
};
const remembered = (): string | null => {
  try {
    return window.sessionStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
};

function loadCulqi(): Promise<CulqiCheckoutCtor> {
  if (window.CulqiCheckout) return Promise.resolve(window.CulqiCheckout);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = CULQI_CHECKOUT_SRC;
    s.async = true;
    s.onload = () => (window.CulqiCheckout ? resolve(window.CulqiCheckout) : reject(new Error("sin CulqiCheckout")));
    s.onerror = () => reject(new Error("no se pudo cargar Culqi"));
    document.head.appendChild(s);
  });
}

export function CreditsTopup({ canBuy, gatewayReady }: { canBuy: boolean; gatewayReady: boolean }) {
  const router = useRouter();
  const [packs, setPacks] = useState<PublicPackDto[] | null>(null);
  const [packsError, setPacksError] = useState(false);
  const [busyPack, setBusyPack] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [topupId, setTopupId] = useState<string | null>(null);
  const [topup, setTopup] = useState<TopupStatusDto | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [pollKey, setPollKey] = useState(0);
  const [newTotal, setNewTotal] = useState<number | null>(null);
  // Culqi exige un teléfono del comprador para crear la orden. Se recuerda en este navegador para no pedirlo cada vez.
  const [phoneText, setPhoneText] = useState("");
  const phone = normalizePhone(phoneText);
  const settled = useRef<string | null>(null);

  const loadPacks = useCallback(async () => {
    const res = await fetch("/api/credits/packs").catch(() => null);
    if (!res?.ok) return setPacksError(true);
    setPacksError(false);
    setPacks(((await res.json()) as { packs: PublicPackDto[] }).packs);
  }, []);

  useEffect(() => {
    void loadPacks();
    const id = remembered();
    if (id) setTopupId(id);
    try {
      const saved = window.localStorage.getItem(PHONE_KEY);
      if (saved) setPhoneText(saved);
    } catch {
      /* sin almacenamiento: se escribe cada vez */
    }
  }, [loadPacks]);

  // Consulta el estado hasta que sea definitivo o se agote la espera.
  useEffect(() => {
    if (!topupId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    setTimedOut(false);
    const tick = async () => {
      const res = await fetch(`/api/credits/topups/${encodeURIComponent(topupId)}`).catch(() => null);
      if (stop) return;
      if (res?.status === 404) {
        remember(null);
        setTopupId(null);
        return;
      }
      if (res?.ok) {
        const t = ((await res.json()) as { topup: TopupStatusDto }).topup;
        if (stop) return;
        setTopup(t);
        if (topupView(t.status).terminal) {
          remember(null);
          if (t.status === "paid" && settled.current !== t.id) {
            settled.current = t.id;
            const s = await fetch("/api/credits/summary").catch(() => null);
            if (s?.ok) {
              const d = (await s.json()) as { enabled?: boolean; total?: number };
              if (!stop && d.enabled && typeof d.total === "number") setNewTotal(d.total);
            }
            router.refresh();
          }
          return;
        }
      }
      if (Date.now() - started > POLL_MAX_MS) return setTimedOut(true);
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [topupId, pollKey, router]);

  async function buy(pack: PublicPackDto) {
    if (busyPack || !canBuy || !gatewayReady) return;
    if (!phone) return setError("Escribe tu teléfono con el código de país (por ejemplo 51999888777): Culqi lo pide para el pago.");
    try {
      window.localStorage.setItem(PHONE_KEY, phone);
    } catch {
      /* sin almacenamiento */
    }
    setBusyPack(pack.id);
    setError(null);
    setNewTotal(null);
    setTopup(null);
    const res = await fetch("/api/credits/topups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ packId: pack.id, phone }),
    }).catch(() => null);
    if (!res?.ok) {
      const d = (await res?.json().catch(() => null)) as { error?: { code?: string } } | null;
      setBusyPack(null);
      setError(purchaseErrorMessage(res?.status ?? 0, d?.error?.code));
      if (d?.error?.code === "pack_not_found") void loadPacks();
      return;
    }
    const order = (await res.json()) as { topupId: string; orderId: string; publicKey: string | null; amountCents: number; currency: string };
    remember(order.topupId);
    setTopupId(order.topupId);
    setPollKey((k) => k + 1);
    const cfg = checkoutConfig(order);
    if (!cfg) {
      setBusyPack(null);
      setError("El pago con tarjeta no está listo todavía (falta la llave pública). Contacta a quien administra la plataforma.");
      return;
    }
    try {
      const Culqi = await loadCulqi();
      const checkout = new Culqi(cfg.publicKey, cfg.config);
      // Al terminar (pague o cierre la ventana) se vuelve a consultar de inmediato; el estado lo decide el servidor.
      checkout.culqi = () => setPollKey((k) => k + 1);
      checkout.open();
    } catch {
      setError("No se pudo abrir la ventana de pago de Culqi. Revisa tu conexión e inténtalo de nuevo.");
    } finally {
      setBusyPack(null);
    }
  }

  const view = topup ? topupView(topup.status, { timedOut }) : topupId ? topupView("pending", { timedOut }) : null;

  return (
    <section className="space-y-4 rounded-lg border bg-card p-5" data-testid="topup-section">
      <div>
        <h3 className="font-semibold">Recargar monedas</h3>
        <p className="text-sm text-text-3">Las recargas no vencen y se usan cuando se acaba la cuota de tu plan.</p>
      </div>

      {!gatewayReady && <Notice tone="neutral" testId="topup-unavailable" title="Las recargas no están disponibles por ahora" text="Vuelve a intentarlo más tarde." />}
      {gatewayReady && !canBuy && <Notice tone="neutral" testId="topup-owner-only" title="Solo el dueño de la cuenta puede comprar recargas" text="Pídele que haga la compra." />}
      {error && <Notice tone="danger" testId="topup-error" title="No se pudo completar" text={error} />}
      {view && view.title && <StatusBanner view={view} units={topup?.units} newTotal={newTotal} onVerify={() => setPollKey((k) => k + 1)} />}

      <div className="max-w-xs" data-testid="topup-phone-field">
        <label className="kicker mb-1 block" htmlFor="topup-phone">Tu teléfono (con código de país)</label>
        <Input id="topup-phone" inputMode="tel" autoComplete="tel" value={phoneText} maxLength={20} onChange={(e) => setPhoneText(e.target.value)} placeholder="51999888777" aria-invalid={phoneText !== "" && !phone} />
        <p className="mt-1 text-xs text-text-3">Culqi lo pide para registrar el pago.</p>
      </div>

      <PackGrid packs={packs} failed={packsError} disabled={!canBuy || !gatewayReady} busyId={busyPack} onBuy={(p) => void buy(p)} onRetry={() => void loadPacks()} />
    </section>
  );
}

export function PackGrid({
  packs,
  failed,
  disabled,
  busyId,
  onBuy,
  onRetry,
}: {
  packs: PublicPackDto[] | null;
  failed: boolean;
  disabled: boolean;
  busyId: string | null;
  onBuy: (p: PublicPackDto) => void;
  onRetry: () => void;
}) {
  if (failed) {
    return (
      <p className="text-sm text-text-2" data-testid="packs-failed">
        No se pudieron cargar los paquetes.{" "}
        <button type="button" className="underline" onClick={onRetry}>
          Reintentar
        </button>
      </p>
    );
  }
  if (!packs) return <p className="text-sm text-text-3" data-testid="packs-loading">Cargando paquetes…</p>;
  if (packs.length === 0) return <p className="text-sm text-text-3" data-testid="packs-none">Por ahora no hay paquetes disponibles.</p>;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="pack-grid">
      {packs.map((p) => (
        <div key={p.id} className="flex flex-col justify-between gap-3 rounded-md border p-4" data-testid="pack-card" data-pack={p.id}>
          <div>
            <p className="text-sm font-medium">{p.name}</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{formatCoinsLabel(p.units)}</p>
            <p className="text-xs text-text-3">{formatMoneyCents(Math.round(pricePerCoinCents(p)), p.currency, "es-PE")} por moneda</p>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-lg font-semibold tabular-nums">{formatMoneyCents(p.priceCents, p.currency, "es-PE")}</span>
            <Button size="sm" disabled={disabled || busyId !== null} onClick={() => onBuy(p)} data-testid="buy-pack">
              {busyId === p.id ? "Abriendo…" : "Comprar"}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function StatusBanner({ view, units, newTotal, onVerify }: { view: TopupView; units?: number; newTotal: number | null; onVerify: () => void }) {
  return (
    <div data-testid="topup-status" data-tone={view.tone}>
      <Notice tone={view.tone} title={view.title} text={view.text} testId="topup-status-box" />
      {view.tone === "success" && units !== undefined && (
        <p className="mt-2 text-sm text-text-2" data-testid="topup-credited">
          + {formatCoinsLabel(units)}
          {newTotal !== null ? ` · saldo ahora: ${formatCoins(newTotal)}` : ""}
        </p>
      )}
      {!view.terminal && (
        <Button size="sm" variant="outline" className="mt-2" onClick={onVerify} data-testid="topup-verify">
          Verificar ahora
        </Button>
      )}
    </div>
  );
}

function Notice({ tone, title, text, testId }: { tone: TopupView["tone"]; title: string; text: string; testId: string }) {
  const cls =
    tone === "danger"
      ? "border-danger-soft bg-danger-tint text-destructive"
      : tone === "success"
        ? "border-success-soft bg-success-tint text-success-text"
        : "bg-subtle text-text-2";
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`rounded-md border px-3 py-2 text-sm ${cls}`} data-testid={testId}>
      <p className="font-medium">{title}</p>
      <p className="mt-0.5">{text}</p>
    </div>
  );
}
