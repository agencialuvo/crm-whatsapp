"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { authClient } from "@/lib/auth/client";
import { EmailCodeStep } from "@/components/auth/email-code-step";
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

const MIN_PASSWORD = 8;

const registerSchema = z
  .object({
    name: z.string().trim().min(2, "Escribe tu nombre").max(80, "Máximo 80 caracteres"),
    email: z.string().trim().email("Escribe un correo válido"),
    password: z.string().min(MIN_PASSWORD, `La contraseña lleva al menos ${MIN_PASSWORD} caracteres`),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Las contraseñas no coinciden" });

function describeError(err: { status?: number; code?: string; message?: string } | null): string {
  if (!err) return "";
  if (err.status === 429) return "Demasiados intentos. Espera unos minutos.";
  if (err.code === "CAPTCHA_REQUIRED") return CAPTCHA_REQUIRED_MESSAGE;
  if (err.code === "CAPTCHA_UNAVAILABLE") return CAPTCHA_UNAVAILABLE_MESSAGE;
  if (err.status === 403) return "El registro no está disponible en esta instancia.";
  if (err.code === "USER_ALREADY_EXISTS" || err.status === 422) {
    return "Ya existe una cuenta con ese correo. Inicia sesión (si no la verificaste, ahí te mandamos el código) o recupera tu contraseña.";
  }
  if (err.code === "PASSWORD_TOO_SHORT") return `La contraseña lleva al menos ${MIN_PASSWORD} caracteres.`;
  return "No se pudo crear la cuenta. Revisa los datos e inténtalo de nuevo.";
}

/**
 * Registro de un propietario nuevo: nombre, correo y contraseña. Al crear la cuenta se crea también
 * SU negocio (queda como propietario) y entra directo a la guía de inicio.
 */
export function RegistroForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  // Cuenta creada: falta escribir el código que llegó al correo.
  const [verifying, setVerifying] = useState(false);
  const captcha = useCaptcha();

  function goHome() {
    // A la raíz, no a la Bandeja: ahí se decide si toca la guía de inicio.
    router.push("/");
    router.refresh();
  }

  /** Pide el código al correo de la cuenta recién creada (el servidor comprueba la contraseña). */
  async function sendCode(addr: string): Promise<string | null> {
    try {
      const res = await fetch("/api/registro/codigo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: addr, password }),
      });
      if (res.ok) return null;
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      return body.error?.message ?? "No se pudo enviar el código al correo.";
    } catch {
      return "No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.";
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = registerSchema.safeParse({ name, email, password, confirm });
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

    // Token invisible de un solo uso, ligado a esta acción.
    let token: string | null = null;
    if (captcha.enabled) {
      token = await captcha.execute(CAPTCHA_ACTIONS.signup);
      if (!token) {
        setLoading(false);
        setError(CAPTCHA_UNAVAILABLE_MESSAGE);
        return;
      }
    }
    const { error: err } = await authClient.signUp.email({
      name: parsed.data.name,
      email: parsed.data.email.toLowerCase(),
      password: parsed.data.password,
      fetchOptions: { headers: token ? { [CAPTCHA_HEADER]: token } : {} },
    });
    if (err) {
      setLoading(false);
      setError(describeError(err));
      return;
    }
    // La cuenta existe pero no tiene sesión ni negocio hasta verificar el correo.
    const sendError = await sendCode(parsed.data.email.toLowerCase());
    setLoading(false);
    if (sendError) {
      setError(`Tu cuenta se creó, pero ${sendError.charAt(0).toLowerCase()}${sendError.slice(1)} Inicia sesión para recibir el código.`);
      return;
    }
    setVerifying(true);
  }

  if (verifying) {
    const addr = email.trim().toLowerCase();
    const [local = "", domain = ""] = addr.split("@");
    return (
      <EmailCodeStep
        email={addr}
        password={password}
        maskedEmail={`${local.slice(0, 2)}***@${domain}`}
        onVerified={goHome}
        onBack={() => setVerifying(false)}
      />
    );
  }

  return (
    <Card className="shadow-md">
      <CardHeader>
        <CardTitle>Crear cuenta</CardTitle>
        <CardDescription>
          Registra tu negocio: tú quedas como propietario y empiezas con tu propio espacio, vacío y solo tuyo.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="name" required>Tu nombre</Label>
            <Input
              id="name"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!!fieldErrors.name}
            />
            {fieldErrors.name && <p className="text-xs text-destructive">{fieldErrors.name}</p>}
          </div>
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
          <div className="space-y-1.5">
            <Label htmlFor="password" required>Contraseña</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={!!fieldErrors.password}
            />
            {fieldErrors.password && <p className="text-xs text-destructive">{fieldErrors.password}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm" required>Repite la contraseña</Label>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={!!fieldErrors.confirm}
            />
            {fieldErrors.confirm && <p className="text-xs text-destructive">{fieldErrors.confirm}</p>}
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Creando…" : "Crear cuenta"}
          </Button>
          <CaptchaNotice captcha={captcha} />
          <p className="text-center text-sm text-muted-foreground">
            ¿Ya tienes cuenta?{" "}
            <Link href="/iniciar-sesion" className="text-primary hover:underline">
              Inicia sesión
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
