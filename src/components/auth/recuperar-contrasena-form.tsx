"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { authClient } from "@/lib/auth/client";
import { CaptchaNotice, useCaptcha } from "@/components/auth/captcha";
import {
  CAPTCHA_ACTIONS,
  CAPTCHA_HEADER,
  CAPTCHA_REQUIRED_MESSAGE,
  CAPTCHA_UNAVAILABLE_MESSAGE,
} from "@/lib/captcha";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Segundos antes de poder pedir otro código. */
const RESEND_SECONDS = 60;
const MIN_PASSWORD = 8;

const emailSchema = z.string().trim().email("Escribe un correo válido");
const resetSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, "El código tiene 6 dígitos"),
    password: z.string().min(MIN_PASSWORD, `La contraseña lleva al menos ${MIN_PASSWORD} caracteres`),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    path: ["confirm"],
    message: "Las contraseñas no coinciden",
  });

type Step = "email" | "code" | "done";

function describeError(err: { status?: number; code?: string; message?: string } | null): string {
  if (!err) return "";
  if (err.status === 429) return "Demasiados intentos. Espera unos minutos.";
  if (err.code === "CAPTCHA_REQUIRED") return CAPTCHA_REQUIRED_MESSAGE;
  if (err.code === "CAPTCHA_UNAVAILABLE") return CAPTCHA_UNAVAILABLE_MESSAGE;
  if (err.status === 503) return "El restablecimiento por correo no está disponible en esta instancia.";
  if (err.code === "TOO_MANY_ATTEMPTS") return "Demasiados intentos con ese código. Pide uno nuevo.";
  if (err.code === "OTP_EXPIRED") return "El código venció. Pide uno nuevo.";
  if (err.code === "INVALID_OTP") return "El código no es correcto.";
  if (err.code === "PASSWORD_TOO_SHORT") return `La contraseña lleva al menos ${MIN_PASSWORD} caracteres.`;
  return "No se pudo completar. Revisa los datos e inténtalo de nuevo.";
}

/**
 * Restablecer la contraseña con un código que llega por correo, en dos pasos:
 * 1) el correo → se envía el código; 2) el código y la contraseña nueva.
 *
 * El paso 1 responde igual exista o no la cuenta (no se revela quién tiene una).
 */
export function RecuperarContrasenaForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [resent, setResent] = useState(false);
  const captcha = useCaptcha();

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  useEffect(() => {
    if (step !== "done") return;
    const t = setTimeout(() => router.push("/iniciar-sesion"), 2500);
    return () => clearTimeout(t);
  }, [step, router]);

  async function requestCode() {
    // Token invisible de un solo uso: uno nuevo en cada envío (también al reenviar).
    let token: string | null = null;
    if (captcha.enabled) {
      token = await captcha.execute(CAPTCHA_ACTIONS.passwordReset);
      if (!token) return { code: "CAPTCHA_UNAVAILABLE" };
    }
    const { error: err } = await authClient.emailOtp.requestPasswordReset({
      email: email.trim().toLowerCase(),
      fetchOptions: { headers: token ? { [CAPTCHA_HEADER]: token } : {} },
    });
    return err;
  }

  async function onSubmitEmail(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setFieldErrors({ email: parsed.error.issues[0]?.message ?? "Correo no válido" });
      return;
    }
    setFieldErrors({});
    setLoading(true);
    const err = await requestCode();
    setLoading(false);
    if (err) {
      setError(describeError(err));
      return;
    }
    setCooldown(RESEND_SECONDS);
    setStep("code");
  }

  async function onResend() {
    setError(null);
    setResent(false);
    setLoading(true);
    const err = await requestCode();
    setLoading(false);
    if (err) {
      setError(describeError(err));
      return;
    }
    setCode("");
    setResent(true);
    setCooldown(RESEND_SECONDS);
  }

  async function onSubmitReset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResent(false);
    const parsed = resetSchema.safeParse({ code, password, confirm });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "form");
        if (!errs[key]) errs[key] = issue.message;
      }
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    setLoading(true);
    const { error: err } = await authClient.emailOtp.resetPassword({
      email: email.trim().toLowerCase(),
      otp: parsed.data.code,
      password: parsed.data.password,
    });
    setLoading(false);
    if (err) {
      setError(describeError(err));
      return;
    }
    setStep("done");
  }

  if (step === "done") {
    return (
      <Card className="shadow-md">
        <CardHeader>
          <CardTitle>Contraseña actualizada</CardTitle>
          <CardDescription>
            Ya puedes entrar con tu contraseña nueva. Te llevamos al inicio de sesión…
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="w-full" onClick={() => router.push("/iniciar-sesion")}>
            Ir a iniciar sesión
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (step === "code") {
    return (
      <Card className="shadow-md">
        <CardHeader>
          <CardTitle>Escribe el código</CardTitle>
          <CardDescription>
            Si <strong>{email.trim()}</strong> tiene una cuenta, te enviamos un código de 6
            dígitos. Vale 10 minutos.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmitReset} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="code" required>Código</Label>
              <Input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                aria-invalid={!!fieldErrors.code}
              />
              {fieldErrors.code && <p className="text-xs text-destructive">{fieldErrors.code}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-password" required>Contraseña nueva</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!fieldErrors.password}
              />
              {fieldErrors.password && (
                <p className="text-xs text-destructive">{fieldErrors.password}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm-password" required>Repite la contraseña</Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                aria-invalid={!!fieldErrors.confirm}
              />
              {fieldErrors.confirm && (
                <p className="text-xs text-destructive">{fieldErrors.confirm}</p>
              )}
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {resent && !error && (
              <p role="status" className="text-sm text-text-2">
                Te enviamos un código nuevo.
              </p>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Guardando…" : "Cambiar contraseña"}
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
              <button
                type="button"
                onClick={() => {
                  setStep("email");
                  setError(null);
                  setFieldErrors({});
                }}
                className="text-text-2 hover:underline"
              >
                Cambiar correo
              </button>
            </div>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-md">
      <CardHeader>
        <CardTitle>Restablecer contraseña</CardTitle>
        <CardDescription>
          Escribe el correo de tu cuenta y te enviamos un código para crear una contraseña nueva.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmitEmail} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="email" required>Correo</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={!!fieldErrors.email}
            />
            {fieldErrors.email && <p className="text-xs text-destructive">{fieldErrors.email}</p>}
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Enviando…" : "Enviar código"}
          </Button>
          <CaptchaNotice captcha={captcha} />
          <p className="text-center text-sm text-muted-foreground">
            <Link href="/iniciar-sesion" className="text-primary hover:underline">
              Volver a iniciar sesión
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
