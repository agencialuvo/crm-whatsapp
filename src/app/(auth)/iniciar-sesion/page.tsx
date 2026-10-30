"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "@/lib/auth/client";
import { CaptchaNotice, useCaptcha } from "@/components/auth/captcha";
import {
  CAPTCHA_ACTIONS,
  CAPTCHA_HEADER,
  CAPTCHA_PROOF_HEADER,
  CAPTCHA_REQUIRED_MESSAGE,
  CAPTCHA_UNAVAILABLE_MESSAGE,
} from "@/lib/captcha";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Segundos antes de poder pedir otro código. */
const RESEND_SECONDS = 60;

type ApiBody = {
  twoFactor?: boolean;
  emailSent?: boolean;
  backupAvailable?: boolean;
  email?: string;
  captchaProof?: string;
  error?: { message?: string };
};

async function postJson(
  url: string,
  json: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; body: ApiBody }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(json),
  });
  const body = (await res.json().catch(() => ({}))) as ApiBody;
  return { status: res.status, body };
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<"credentials" | "code">("credentials");
  const [code, setCode] = useState("");
  // Código de respaldo: la salida para cuando el correo no llega.
  const [useBackup, setUseBackup] = useState(false);
  const [backupAvailable, setBackupAvailable] = useState(false);
  const [backupCode, setBackupCode] = useState("");
  const [maskedEmail, setMaskedEmail] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const captcha = useCaptcha();

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  function goHome() {
    // A la raíz, no a la Bandeja: ahí se decide si toca la guía de inicio
    // (#86) o la Bandeja de siempre.
    router.push("/");
    router.refresh();
  }

  /** Pide el código de la verificación en dos pasos. `null` = esta cuenta no la usa. */
  async function startTwoFactor(): Promise<{
    ok: boolean;
    twoFactor: boolean;
    message?: string;
    email?: string;
    emailSent?: boolean;
    backupAvailable?: boolean;
    captchaProof?: string;
  }> {
    try {
      const headers: Record<string, string> = {};
      if (captcha.enabled) {
        // Token invisible de un solo uso: uno nuevo en cada intento (también al reenviar).
        const token = await captcha.execute(CAPTCHA_ACTIONS.login);
        if (!token) return { ok: false, twoFactor: false, message: CAPTCHA_UNAVAILABLE_MESSAGE };
        headers[CAPTCHA_HEADER] = token;
      }
      const { status, body } = await postJson("/api/login/two-factor/start", { email, password }, headers);
      if (status === 429) return { ok: false, twoFactor: false, message: "Demasiados intentos. Espera unos minutos." };
      if (status >= 400) {
        return { ok: false, twoFactor: false, message: body.error?.message ?? "No se pudo enviar el código." };
      }
      return {
        ok: true,
        twoFactor: body.twoFactor === true,
        email: body.email,
        emailSent: body.emailSent !== false,
        backupAvailable: body.backupAvailable === true,
        captchaProof: body.captchaProof,
      };
    } catch {
      // Sin red a esta ruta: se sigue con el inicio de sesión normal (que rechaza a quien use 2FA).
      return { ok: true, twoFactor: false };
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    const start = await startTwoFactor();
    if (!start.ok) {
      setLoading(false);
      setError(start.message ?? "No se pudo iniciar sesión.");
      return;
    }
    if (start.twoFactor) {
      setLoading(false);
      setMaskedEmail(start.email ?? "");
      setCode("");
      setBackupCode("");
      setBackupAvailable(start.backupAvailable === true);
      // Si el correo no salió pero hay códigos de respaldo, se entra directo por ellos.
      setUseBackup(start.emailSent === false);
      if (start.emailSent === false) {
        setInfo("No pudimos enviar el código a tu correo. Usa uno de tus códigos de respaldo.");
      } else {
        setCooldown(RESEND_SECONDS);
      }
      setStep("code");
      return;
    }
    const { error: err } = await signIn.email({
      email,
      password,
      fetchOptions: { headers: start.captchaProof ? { [CAPTCHA_PROOF_HEADER]: start.captchaProof } : {} },
    });
    setLoading(false);
    if (err) {
      setError(
        err.status === 429
          ? "Demasiados intentos. Espera unos minutos."
          : err.code === "CAPTCHA_REQUIRED"
            ? CAPTCHA_REQUIRED_MESSAGE
            : "Correo o contraseña incorrectos."
      );
      return;
    }
    goHome();
  }

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (useBackup ? backupCode.replace(/[^a-zA-Z0-9]/g, "").length !== 8 : !/^\d{6}$/.test(code)) {
      setError(useBackup ? "El código de respaldo tiene 8 caracteres (ABCD-EFGH)." : "El código tiene 6 dígitos.");
      return;
    }
    setLoading(true);
    try {
      const { status, body } = await postJson(
        "/api/login/two-factor/verify",
        useBackup ? { email, password, backupCode } : { email, password, code }
      );
      if (status >= 200 && status < 300) {
        goHome();
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
    const start = await startTwoFactor();
    setLoading(false);
    if (!start.ok || !start.twoFactor) {
      setError(start.message ?? "No se pudo enviar el código.");
      return;
    }
    setCode("");
    if (start.emailSent === false) {
      setUseBackup(true);
      setInfo("No pudimos enviar el código a tu correo. Usa uno de tus códigos de respaldo.");
      return;
    }
    setCooldown(RESEND_SECONDS);
    setInfo(`Te enviamos un código nuevo a ${start.email ?? maskedEmail}.`);
  }

  if (step === "code") {
    return (
      <Card className="shadow-md">
        <CardHeader>
          <CardTitle>Verificación en dos pasos</CardTitle>
          <CardDescription>
            {useBackup ? (
              "Escribe uno de tus códigos de respaldo. Cada uno sirve una sola vez."
            ) : (
              <>
                Enviamos un código de 6 dígitos a <span className="font-semibold">{maskedEmail}</span>. Vale 10
                minutos y se usa una sola vez.
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onVerify} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              {useBackup ? (
                <>
                  <Label htmlFor="backup-code" required>Código de respaldo</Label>
                  <Input
                    id="backup-code"
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    autoFocus
                    value={backupCode}
                    placeholder="ABCD-EFGH"
                    onChange={(e) => setBackupCode(e.target.value.replace(/[^a-zA-Z0-9-]/g, "").toUpperCase().slice(0, 9))}
                    className="h-11 w-full text-center font-mono text-lg uppercase tracking-[0.3em]"
                  />
                </>
              ) : (
                <>
                  <Label htmlFor="code" required>Código de verificación</Label>
                  <Input
                    id="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    value={code}
                    // Solo dígitos: no se puede teclear ni pegar otra cosa.
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    className="h-11 w-full text-center font-mono text-lg tracking-[0.5em] tabular-nums"
                  />
                </>
              )}
            </div>
            {info && (
              <p role="status" className="rounded-md border border-success-soft bg-success-tint px-3 py-2 text-sm text-success-text">
                {info}
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Verificando…" : "Verificar y entrar"}
            </Button>
            <div className="flex flex-wrap items-center justify-between gap-2">
              {useBackup ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={loading}
                  onClick={() => {
                    setUseBackup(false);
                    setError(null);
                    setInfo(null);
                  }}
                >
                  Usar el código del correo
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={loading || cooldown > 0}
                  onClick={() => void onResend()}
                >
                  {cooldown > 0 ? `Reenviar código (${cooldown}s)` : "Reenviar código"}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={loading}
                onClick={() => {
                  setStep("credentials");
                  setCode("");
                  setBackupCode("");
                  setUseBackup(false);
                  setError(null);
                  setInfo(null);
                }}
              >
                Volver
              </Button>
            </div>
            {backupAvailable && !useBackup && (
              <button
                type="button"
                className="block w-full text-center text-sm text-primary hover:underline"
                onClick={() => {
                  setUseBackup(true);
                  setError(null);
                  setInfo(null);
                }}
              >
                ¿No te llega el correo? Usa un código de respaldo
              </button>
            )}
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-md">
      <CardHeader>
        <CardTitle>Iniciar sesión</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email" required>Correo electrónico</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password" required>Contraseña</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="-mt-1 text-right">
            <Link href="/recuperar-contrasena" className="text-sm text-primary hover:underline">
              ¿Olvidaste tu contraseña?
            </Link>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Ingresando…" : "Ingresar"}
          </Button>
          <CaptchaNotice captcha={captcha} />
        </form>
      </CardContent>
    </Card>
  );
}
