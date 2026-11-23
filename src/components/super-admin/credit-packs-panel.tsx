"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { formatCoins } from "@/lib/credits";
import { formatMoneyCents } from "@/lib/money";
import { parsePriceToCents, type PackDto } from "@/lib/super-admin-credits";
import { Button } from "@/components/ui/button";
import { DialogCloseButton } from "@/components/ui/dialog-close";
import { Input } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { Switch } from "@/components/ui/switch";

/**
 * Paquetes de recarga (Super Admin): el catálogo que los clientes verán al comprar monedas. Crear, editar nombre,
 * monedas, precio, moneda y orden, y activar/desactivar. Un paquete nunca se borra: se desactiva (las compras ya
 * hechas copian sus unidades y precio). Todo viene de `/api/super-admin/credits/packs`; aquí no se calcula dinero,
 * solo se convierte lo que se escribe (soles → centavos, monedas con decimales).
 */
export function CreditPacksPanel() {
  const [packs, setPacks] = useState<PackDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PackDto | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/super-admin/credits/packs").catch(() => null);
    if (!res?.ok) return setError("No se pudo cargar el catálogo de paquetes.");
    setError(null);
    setPacks(((await res.json()) as { packs: PackDto[] }).packs);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(p: PackDto) {
    setBusyId(p.id);
    setError(null);
    const res = await fetch(`/api/super-admin/credits/packs/${p.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: !p.active }),
    }).catch(() => null);
    setBusyId(null);
    if (!res?.ok) {
      const d = (await res?.json().catch(() => null)) as { error?: { message?: string } } | null;
      return setError(d?.error?.message ?? "No se pudo cambiar el estado del paquete.");
    }
    void load();
  }

  return (
    <section className="space-y-3" data-testid="packs-panel">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-bold tracking-tight">Paquetes de recarga</h2>
          <p className="text-sm text-text-3">Lo que tus clientes podrán comprar para sumar monedas. Los inactivos no se muestran a los clientes.</p>
        </div>
        <Button size="sm" onClick={() => setEditing("new")} data-testid="new-pack">
          <Plus className="mr-1.5 h-4 w-4" aria-hidden /> Nuevo paquete
        </Button>
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-destructive" data-testid="packs-error">
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm" data-testid="packs-table">
          <thead className="bg-subtle text-left text-xs text-text-3">
            <tr>
              <th className="px-3 py-2">Nombre</th>
              <th className="px-3 py-2 text-right">Monedas</th>
              <th className="px-3 py-2 text-right">Precio</th>
              <th className="px-3 py-2 text-right">Por moneda</th>
              <th className="px-3 py-2 text-right">Orden</th>
              <th className="px-3 py-2">Activo</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {(packs ?? []).map((p) => (
              <tr key={p.id} className={`border-t ${p.active ? "" : "text-text-3"}`} data-testid="pack-row" data-pack={p.id}>
                <td className="px-3 py-2 font-medium">{p.name}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatCoins(p.units)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoneyCents(p.priceCents, p.currency, "es-PE")}</td>
                <td className="px-3 py-2 text-right tabular-nums text-text-3">{formatMoneyCents(Math.round(p.pricePerCoinCents), p.currency, "es-PE")}</td>
                <td className="px-3 py-2 text-right tabular-nums">{p.sortOrder}</td>
                <td className="px-3 py-2">
                  <Switch checked={p.active} onCheckedChange={() => void toggle(p)} label={`${p.active ? "Desactivar" : "Activar"} ${p.name}`} size="sm" disabled={busyId === p.id} />
                </td>
                <td className="px-3 py-2 text-right">
                  <Button size="sm" variant="outline" onClick={() => setEditing(p)} data-testid="edit-pack">
                    Editar
                  </Button>
                </td>
              </tr>
            ))}
            {packs && packs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-text-3" data-testid="packs-empty">
                  Todavía no hay paquetes. Crea el primero para poder vender recargas.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && <PackDialog pack={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </section>
  );
}

function PackDialog({ pack, onClose, onSaved }: { pack: PackDto | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(pack?.name ?? "");
  const [coins, setCoins] = useState(pack ? String(pack.units / 100) : "");
  const [price, setPrice] = useState(pack ? (pack.priceCents / 100).toFixed(2) : "");
  const [currency, setCurrency] = useState(pack?.currency ?? "PEN");
  const [sortOrder, setSortOrder] = useState(String(pack?.sortOrder ?? 0));
  const [active, setActive] = useState(pack?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const coinsNum = Number(coins.replace(",", "."));
  const cents = parsePriceToCents(price);
  const sortNum = Number(sortOrder);
  const invalid =
    name.trim().length < 2 || !Number.isFinite(coinsNum) || coinsNum < 0.01 || cents === null || !Number.isInteger(sortNum) || sortNum < 0;

  async function save() {
    if (saving || invalid || cents === null) return;
    setSaving(true);
    setError(null);
    const body = { name: name.trim(), coins: coinsNum, priceCents: cents, currency, sortOrder: sortNum, active };
    const res = await fetch(pack ? `/api/super-admin/credits/packs/${pack.id}` : "/api/super-admin/credits/packs", {
      method: pack ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      const d = (await res?.json().catch(() => null)) as { error?: { message?: string } } | null;
      return setError(d?.error?.message ?? "No se pudo guardar el paquete.");
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-overlay p-4" onClick={onClose} data-testid="pack-dialog">
      <div className="relative w-full max-w-md rounded-lg border bg-popover p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <DialogCloseButton onClick={onClose} />
        <h3 className="pr-8 font-semibold">{pack ? "Editar paquete" : "Nuevo paquete"}</h3>
        {pack && <p className="mt-1 text-xs text-text-3">Las compras ya hechas conservan las monedas y el precio con que se crearon.</p>}
        <div className="mt-4 space-y-3">
          <div>
            <label className="kicker mb-1 block" htmlFor="pk-name">Nombre</label>
            <Input id="pk-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Ej. Recarga 500" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="kicker mb-1 block" htmlFor="pk-coins">Monedas</label>
              <Input id="pk-coins" inputMode="decimal" value={coins} onChange={(e) => setCoins(e.target.value)} placeholder="500" />
            </div>
            <div>
              <label className="kicker mb-1 block" htmlFor="pk-price">Precio</label>
              <Input id="pk-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="49.90" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="kicker mb-1 block">Moneda del precio</label>
              <SearchSelect
                value={currency}
                onChange={setCurrency}
                ariaLabel="Moneda del precio"
                placeholder="Moneda…"
                searchPlaceholder="Buscar…"
                options={[
                  { value: "PEN", label: "Soles (PEN)" },
                  { value: "USD", label: "Dólares (USD)" },
                ]}
              />
            </div>
            <div>
              <label className="kicker mb-1 block" htmlFor="pk-sort">Orden</label>
              <Input id="pk-sort" inputMode="numeric" value={sortOrder} onChange={(e) => setSortOrder(e.target.value.replace(/\D/g, ""))} />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border bg-subtle px-3 py-2">
            <span className="text-sm">Visible para los clientes</span>
            <Switch checked={active} onCheckedChange={setActive} label="Paquete activo" size="sm" />
          </div>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive" data-testid="pack-error">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end">
          <Button disabled={saving || invalid} onClick={() => void save()} data-testid="save-pack">
            {saving ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </div>
    </div>
  );
}
