"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Segundos antes de poder pedir otro código. */
const RESEND_SECONDS = 60;

type ApiBody = { error?: { message?: string } };

async function post(url: string, json: unknown): Promise<{ status: number; body: ApiBody }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(json),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as ApiBody };
}

/**
 * Paso «escribe el código que te llegó al correo» de un registro nuevo. Lo comparten la pantalla de
 * registro (recién creada la cuenta) y la de inicio de sesión (quien dejó el registro a medias).
 * Con el código correcto el servidor verifica el correo, crea el negocio e inicia la sesión.
 */
export function EmailCodeStep({
  email,
  password,
  maskedEmail,
  onVerified,
  onBack,
}: {
  email: string;
  password: string;
  /** El correo como se muestra en pantalla (puede ir parcialmente oculto). */
  maskedEmail: string;
  onVerified: () => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(RESEND_SECONDS);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (!/^\d{6}$/.test(code)) {
      setError("El código tiene 6 dígitos.");
      return;
    }
    setLoading(true);
    try {
      const { status, body } = await post("/api/registro/verificar", { email, password, code });
      if (status >= 200 && status < 300) {
        onVerified();
        return;
      }
      setError(body.error?.message ?? "No se pudo verificar el código.");
    } catch {
      setError("No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.");
    }
    setLoading(false);
  }

  async function onResend() {
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      const { status, body } = await post("/api/registro/codigo", { email, password });
      if (status >= 200 && status < 300) {
        setCode("");
        setCooldown(RESEND_SECONDS);
        setInfo(`Te enviamos un código nuevo a ${maskedEmail}.`);
      } else {
        setError(body.error?.message ?? "No se pudo enviar el código.");
      }
    } catch {
      setError("No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.");
    }
    setLoading(false);
  }

  return (
    <Card className="shadow-md">
      <CardHeader>
        <CardTitle>Verifica tu correo</CardTitle>
        <CardDescription>
          Enviamos un código de 6 dígitos a <span className="font-semibold">{maskedEmail}</span>. Escríbelo para
          activar tu cuenta. Vale 10 minutos.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="signup-code" required>Código</Label>
            <Input
              id="signup-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              aria-invalid={!!error}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {info && !error && (
            <p role="status" className="text-sm text-text-2">
              {info}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Verificando…" : "Verificar y entrar"}
          </Button>
          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              onClick={() => void onResend()}
              disabled={loading || cooldown > 0}
              className="text-primary hover:underline disabled:cursor-not-allowed disabled:text-text-3 disabled:no-underline"
            >
              {cooldown > 0 ? `Reenviar código (${cooldown} s)` : "Reenviar código"}
            </button>
            <button type="button" onClick={onBack} className="text-text-2 hover:underline">
              Volver
            </button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
