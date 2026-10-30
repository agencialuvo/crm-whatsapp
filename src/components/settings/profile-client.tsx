"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { MediaImageField, type ImagenElegida } from "@/components/medios/media-picker";
import { apiFetch, describeError } from "@/components/negocio/api";
import { Modal, ModalFooter } from "@/components/negocio/modal";
import { authClient } from "@/lib/auth/client";
import { scrollToSettingsAnchor } from "@/lib/settings-scroll";
import { cn } from "@/lib/utils";

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
/** Segundos antes de poder pedir otro código. */
const RESEND_SECONDS = 60;

/**
 * Cómo viaja el código de verificación: `smtp` (correo real), `console` (solo
 * desarrollo: se imprime en la consola del servidor) o `off` (sin correo: el
 * cambio pide solo la contraseña actual).
 */
export type EmailMode = "smtp" | "console" | "off";

type Notice = { kind: "ok" | "error"; text: string } | null;

function NoticeBox({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p
      role={notice.kind === "error" ? "alert" : "status"}
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        notice.kind === "ok"
          ? "border-success-soft bg-success-tint text-success-text"
          : "border-danger-soft bg-danger-tint text-danger-text"
      )}
    >
      {notice.text}
    </p>
  );
}

/** `maria@gmail.com` → `ma***@gmail.com`: se confirma a dónde llegó sin exponer el correo entero. */
function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

/**
 * Ajustes → Mi perfil: el espacio personal de quien inició sesión (no de la
 * organización). Nombre y foto se guardan en el usuario; el correo se muestra
 * pero no se edita; la contraseña se cambia con doble verificación: la actual y
 * un código de un solo uso que llega al correo.
 */
export function ProfileClient({
  name: initialName,
  email,
  image: initialImage,
  emailMode,
  twoFactorEnabled: initialTwoFactor,
  backupCodesRemaining: initialBackupRemaining,
}: {
  name: string;
  email: string;
  image: string | null;
  emailMode: EmailMode;
  twoFactorEnabled: boolean;
  /** Códigos de respaldo que le quedan sin usar. */
  backupCodesRemaining: number;
}) {
  const router = useRouter();

  const [name, setName] = useState(initialName);
  const [photo, setPhoto] = useState<ImagenElegida | null>(
    initialImage
      ? { id: /\/api\/medios\/([^/]+)\/archivo/.exec(initialImage)?.[1] ?? "externa", url: initialImage }
      : null
  );
  const [nameError, setNameError] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileNotice, setProfileNotice] = useState<Notice>(null);

  const needsCode = emailMode !== "off";
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [step, setStep] = useState<"form" | "code">("form");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState(email);
  const [cooldown, setCooldown] = useState(0);
  const [passErrors, setPassErrors] = useState<Record<string, string>>({});
  const [savingPass, setSavingPass] = useState(false);
  const [passNotice, setPassNotice] = useState<Notice>(null);

  // Verificación en dos pasos. El interruptor muestra lo guardado; cambiarlo abre la
  // confirmación con la contraseña actual. Activarla manda un código de PRUEBA al correo
  // (ventana «Confirma tu correo») y solo al escribirlo se guarda y se dan los códigos de
  // respaldo, que se muestran una sola vez.
  type TwoFactorAction = "enable" | "disable" | "regenerate";
  const [twoFactor, setTwoFactor] = useState(initialTwoFactor);
  const [backupRemaining, setBackupRemaining] = useState(initialBackupRemaining);
  const [tfAction, setTfAction] = useState<TwoFactorAction | null>(null);
  const [tfPassword, setTfPassword] = useState("");
  const [tfError, setTfError] = useState<string | null>(null);
  const [tfBusy, setTfBusy] = useState(false);
  const [tfNotice, setTfNotice] = useState<Notice>(null);
  const [tfModal, setTfModal] = useState<"verify" | "codes" | null>(null);
  const [tfCode, setTfCode] = useState("");
  const [tfCodeError, setTfCodeError] = useState<string | null>(null);
  const [tfSentTo, setTfSentTo] = useState(email);
  const [tfCooldown, setTfCooldown] = useState(0);
  const [tfCodes, setTfCodes] = useState<string[]>([]);
  const [tfCopied, setTfCopied] = useState(false);

  // Entrar con `#seguridad` en la dirección: se baja a esa zona sin mover el marco de la app.
  useEffect(() => {
    const anchor = window.location.hash.slice(1);
    if (!anchor) return;
    // Next también intenta bajar al `#ancla` por su cuenta, un poco después de hidratar y
    // moviendo el marco de la app: se corrige otra vez tras ese intento.
    const timers = [0, 150, 500, 1000].map((ms) => setTimeout(() => scrollToSettingsAnchor(anchor, "auto"), ms));
    return () => timers.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    if (tfCooldown <= 0) return;
    const t = setTimeout(() => setTfCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [tfCooldown]);

  function resetTwoFactorPanel() {
    setTfAction(null);
    setTfPassword("");
    setTfError(null);
  }

  /** Manda (o reenvía) el código de prueba al correo y abre la ventana para escribirlo. */
  async function sendSetupCode() {
    const r = await apiFetch<{ email: string }>("/api/account/two-factor/enable/start", {
      method: "POST",
      json: { currentPassword: tfPassword },
    });
    setTfSentTo(r.email);
    setTfCooldown(RESEND_SECONDS);
  }

  async function confirmTwoFactor(e: React.FormEvent) {
    e.preventDefault();
    if (tfAction === null) return;
    setTfNotice(null);
    if (!tfPassword) {
      setTfError("Escribe tu contraseña actual");
      return;
    }
    setTfError(null);
    setTfBusy(true);
    try {
      if (tfAction === "enable") {
        await sendSetupCode();
        setTfCode("");
        setTfCodeError(null);
        setTfModal("verify");
      } else if (tfAction === "disable") {
        await apiFetch("/api/account/two-factor/disable", { method: "POST", json: { currentPassword: tfPassword } });
        setTwoFactor(false);
        setBackupRemaining(0);
        resetTwoFactorPanel();
        setTfNotice({ kind: "ok", text: "Verificación en dos pasos desactivada." });
      } else {
        const r = await apiFetch<{ backupCodes: string[] }>("/api/account/two-factor/backup-codes", {
          method: "POST",
          json: { currentPassword: tfPassword },
        });
        setTfCodes(r.backupCodes);
        setBackupRemaining(r.backupCodes.length);
        setTfCopied(false);
        resetTwoFactorPanel();
        setTfModal("codes");
      }
    } catch (err) {
      setTfError(describeError(err));
    } finally {
      setTfBusy(false);
    }
  }

  async function resendSetupCode() {
    setTfCodeError(null);
    setTfBusy(true);
    try {
      await sendSetupCode();
      setTfCode("");
    } catch (err) {
      setTfCodeError(describeError(err));
    } finally {
      setTfBusy(false);
    }
  }

  async function submitSetupCode(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(tfCode)) {
      setTfCodeError("El código tiene 6 dígitos");
      return;
    }
    setTfCodeError(null);
    setTfBusy(true);
    try {
      const r = await apiFetch<{ backupCodes: string[] }>("/api/account/two-factor/enable/confirm", {
        method: "POST",
        json: { code: tfCode },
      });
      setTwoFactor(true);
      setTfCodes(r.backupCodes);
      setBackupRemaining(r.backupCodes.length);
      setTfCopied(false);
      resetTwoFactorPanel();
      setTfModal("codes");
    } catch (err) {
      setTfCodeError(describeError(err));
    } finally {
      setTfBusy(false);
    }
  }

  async function copyBackupCodes() {
    try {
      await navigator.clipboard.writeText(tfCodes.join("\n"));
      setTfCopied(true);
    } catch {
      setTfCodeError("No se pudo copiar. Usa «Descargar» o anótalos a mano.");
    }
  }

  function downloadBackupCodes() {
    const text = [
      "Códigos de respaldo de la verificación en dos pasos",
      `Cuenta: ${email}`,
      "Cada código sirve una sola vez. Guárdalos en un lugar seguro.",
      "",
      ...tfCodes,
      "",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "codigos-de-respaldo.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  function closeCodes() {
    setTfModal(null);
    setTfCodes([]);
    setTfCodeError(null);
    setTfNotice({
      kind: "ok",
      text: "Verificación en dos pasos activa. Guarda tus códigos de respaldo: no se vuelven a mostrar.",
    });
  }

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setProfileNotice(null);
    const tidy = name.replace(/\s+/g, " ").trim();
    if (tidy.length < 2) {
      setNameError("Escribe tu nombre y apellido");
      return;
    }
    if (tidy.length > 80) {
      setNameError("Máximo 80 caracteres");
      return;
    }
    setNameError(null);
    setSavingProfile(true);
    const { error } = await authClient.updateUser({ name: tidy, image: photo?.url ?? null });
    setSavingProfile(false);
    if (error) {
      setProfileNotice({ kind: "error", text: "No se pudo guardar tu perfil. Inténtalo de nuevo." });
      return;
    }
    setName(tidy);
    setProfileNotice({ kind: "ok", text: "Perfil guardado." });
    // El menú lateral lee el nombre y la foto de la sesión.
    router.refresh();
  }

  /** Valida el formulario de contraseñas; devuelve si todo está bien. */
  function validatePasswords(): boolean {
    const errs: Record<string, string> = {};
    if (!current) errs.current = "Escribe tu contraseña actual";
    if (next.length < MIN_PASSWORD) errs.next = `Mínimo ${MIN_PASSWORD} caracteres`;
    else if (next.length > MAX_PASSWORD) errs.next = `Máximo ${MAX_PASSWORD} caracteres`;
    else if (next === current) errs.next = "La nueva debe ser distinta a la actual";
    if (confirm !== next) errs.confirm = "Las contraseñas no coinciden";
    setPassErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function requestCode() {
    const r = await apiFetch<{ email: string }>("/api/account/password/code", {
      method: "POST",
      json: { currentPassword: current },
    });
    setSentTo(r.email);
    setCooldown(RESEND_SECONDS);
  }

  async function applyChange(withCode: string | undefined) {
    await apiFetch("/api/account/password", {
      method: "POST",
      json: { currentPassword: current, newPassword: next, ...(withCode ? { code: withCode } : {}) },
    });
    setCurrent("");
    setNext("");
    setConfirm("");
    setCode("");
    setStep("form");
    setPassNotice({
      kind: "ok",
      text: needsCode
        ? "Contraseña actualizada. Cerramos tus otras sesiones y avisamos por correo a los propietarios."
        : "Contraseña actualizada. Se cerraron tus otras sesiones.",
    });
  }

  /** Paso 1: con la actual correcta, manda el código (o cambia directo si no hay correo). */
  async function submitForm(e: React.FormEvent) {
    e.preventDefault();
    setPassNotice(null);
    if (!validatePasswords()) return;
    setSavingPass(true);
    try {
      if (needsCode) {
        await requestCode();
        setCode("");
        setStep("code");
      } else {
        await applyChange(undefined);
      }
    } catch (err) {
      setPassNotice({ kind: "error", text: describeError(err) });
    } finally {
      setSavingPass(false);
    }
  }

  /** Paso 2: el código del correo autoriza el cambio. */
  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setPassNotice(null);
    if (!/^\d{6}$/.test(code)) {
      setPassErrors({ code: "El código tiene 6 dígitos" });
      return;
    }
    setPassErrors({});
    setSavingPass(true);
    try {
      await applyChange(code);
    } catch (err) {
      setPassNotice({ kind: "error", text: describeError(err) });
    } finally {
      setSavingPass(false);
    }
  }

  async function resendCode() {
    setPassNotice(null);
    setSavingPass(true);
    try {
      await requestCode();
      setCode("");
      setPassNotice({ kind: "ok", text: `Te enviamos un código nuevo a ${maskEmail(sentTo)}.` });
    } catch (err) {
      setPassNotice({ kind: "error", text: describeError(err) });
    } finally {
      setSavingPass(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <form id="perfil" onSubmit={saveProfile} noValidate className="scroll-mt-4">
        <Card>
          <CardHeader>
            <CardTitle>Mi perfil</CardTitle>
            <CardDescription>Cómo te ven en el sistema. Es solo tuyo: no cambia nada del negocio.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="profile-name" required>Nombre y apellido</Label>
              <Input
                id="profile-name"
                value={name}
                maxLength={80}
                autoComplete="name"
                onChange={(e) => setName(e.target.value)}
                aria-invalid={!!nameError}
                disabled={savingProfile}
              />
              {nameError && <p className="text-xs text-danger-text">{nameError}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="profile-email">Correo electrónico</Label>
              <Input id="profile-email" value={email} readOnly disabled />
              <p className="text-xs text-text-3">Con este correo inicias sesión. Por seguridad no se puede cambiar aquí.</p>
            </div>

            <div className="max-w-xs">
              <MediaImageField
                id="profile-photo"
                label="Foto de perfil (opcional)"
                value={photo}
                onChange={setPhoto}
                disabled={savingProfile}
              />
            </div>

            <NoticeBox notice={profileNotice} />
            <Button type="submit" disabled={savingProfile}>
              {savingProfile ? "Guardando…" : "Guardar perfil"}
            </Button>
          </CardContent>
        </Card>
      </form>

      <Card id="seguridad" className="scroll-mt-4">
        <CardHeader>
          <CardTitle>Seguridad</CardTitle>
          <CardDescription>
            Verificación en dos pasos: además de tu contraseña, al iniciar sesión te pedimos un código de un solo
            uso que enviamos a tu correo.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold">Activar verificación en dos pasos por correo</p>
              <p className="mt-0.5 text-xs text-text-3">
                {twoFactor ? `Activa: los códigos llegan a ${maskEmail(email)}.` : "Desactivada: se entra solo con correo y contraseña."}
              </p>
            </div>
            <Switch
              checked={twoFactor}
              label="Activar verificación en dos pasos por correo"
              disabled={tfBusy || (emailMode === "off" && !twoFactor)}
              onCheckedChange={(next) => {
                setTfNotice(null);
                setTfError(null);
                setTfPassword("");
                setTfAction(next ? "enable" : "disable");
              }}
            />
          </div>
          {emailMode === "off" && !twoFactor && (
            <p className="rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-xs text-warning-text">
              Esta instancia no tiene correo configurado (SMTP): sin él no se podría enviar el código. Configúralo
              para activar la verificación en dos pasos.
            </p>
          )}
          {twoFactor && tfAction === null && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-subtle/50 px-3 py-2.5">
              <p className="text-xs text-text-2">
                <span className="font-semibold">Códigos de respaldo:</span>{" "}
                {backupRemaining > 0
                  ? `te quedan ${backupRemaining}. Sirven para entrar si el correo falla.`
                  : "ya no te queda ninguno. Genera nuevos por si el correo falla."}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setTfNotice(null);
                  setTfError(null);
                  setTfPassword("");
                  setTfAction("regenerate");
                }}
              >
                Generar códigos nuevos
              </Button>
            </div>
          )}
          {tfAction !== null && (
            <form onSubmit={confirmTwoFactor} noValidate className="space-y-3 rounded-md border bg-subtle/50 p-3">
              <div className="space-y-1.5">
                <Label htmlFor="twofactor-password" required>
                  {tfAction === "enable"
                    ? "Confirma con tu contraseña actual para activarla"
                    : tfAction === "disable"
                      ? "Confirma con tu contraseña actual para desactivarla"
                      : "Confirma con tu contraseña actual para generar códigos nuevos"}
                </Label>
                <Input
                  id="twofactor-password"
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  value={tfPassword}
                  onChange={(e) => setTfPassword(e.target.value)}
                  aria-invalid={!!tfError}
                  disabled={tfBusy}
                  className="max-w-sm"
                />
                {tfAction === "enable" && (
                  <p className="text-xs text-text-3">
                    Te enviaremos un código de prueba a tu correo para comprobar que lo recibes. Solo entonces se
                    activa.
                  </p>
                )}
                {tfAction === "regenerate" && (
                  <p className="text-xs text-text-3">Los códigos que tienes ahora dejarán de servir.</p>
                )}
                {tfError && (
                  <p role="alert" className="text-xs text-danger-text">
                    {tfError}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" size="sm" disabled={tfBusy}>
                  {tfBusy
                    ? "Un momento…"
                    : tfAction === "enable"
                      ? "Enviar código de prueba"
                      : tfAction === "disable"
                        ? "Desactivar"
                        : "Generar códigos"}
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={tfBusy} onClick={resetTwoFactorPanel}>
                  Cancelar
                </Button>
              </div>
            </form>
          )}
          <NoticeBox notice={tfNotice} />
        </CardContent>
      </Card>

      <Card id="cambiar-contrasena" className="scroll-mt-4">
        <CardHeader>
          <CardTitle>Cambiar contraseña</CardTitle>
          <CardDescription>
            {needsCode
              ? "Por seguridad pedimos tu contraseña actual y un código que enviamos a tu correo."
              : "Te pedimos la actual para confirmar que eres tú."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {step === "form" ? (
            <form onSubmit={submitForm} noValidate className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="pass-current" required>Contraseña actual</Label>
                <Input
                  id="pass-current"
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  aria-invalid={!!passErrors.current}
                  disabled={savingPass}
                  className="max-w-sm"
                />
                {passErrors.current && <p className="text-xs text-danger-text">{passErrors.current}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pass-new" required>Contraseña nueva</Label>
                <Input
                  id="pass-new"
                  type="password"
                  autoComplete="new-password"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  aria-invalid={!!passErrors.next}
                  disabled={savingPass}
                  className="max-w-sm"
                />
                <p className="text-xs text-text-3">Al menos {MIN_PASSWORD} caracteres.</p>
                {passErrors.next && <p className="text-xs text-danger-text">{passErrors.next}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pass-confirm" required>Repite la contraseña nueva</Label>
                <Input
                  id="pass-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  aria-invalid={!!passErrors.confirm}
                  disabled={savingPass}
                  className="max-w-sm"
                />
                {passErrors.confirm && <p className="text-xs text-danger-text">{passErrors.confirm}</p>}
              </div>
              {emailMode === "off" && (
                <p className="rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-xs text-warning-text">
                  Esta instancia no tiene correo configurado (SMTP): el cambio solo pide tu contraseña actual y no se
                  envían avisos. Configúralo para activar el código de verificación.
                </p>
              )}
              <NoticeBox notice={passNotice} />
              <Button type="submit" disabled={savingPass}>
                {savingPass ? "Verificando…" : needsCode ? "Continuar" : "Cambiar contraseña"}
              </Button>
            </form>
          ) : (
            <form onSubmit={submitCode} noValidate className="space-y-4">
              <p className="text-sm text-text-2">
                Enviamos un código de 6 dígitos a <span className="font-semibold">{maskEmail(sentTo)}</span>. Vale 10
                minutos y se usa una sola vez.
              </p>
              {emailMode === "console" && (
                <p className="rounded-md border bg-subtle px-3 py-2 text-xs text-text-3">
                  Modo desarrollo: sin SMTP, el código aparece en la consola del servidor.
                </p>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="pass-code" required>Código de verificación</Label>
                <Input
                  id="pass-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  // Solo dígitos: no se puede teclear ni pegar otra cosa.
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  aria-invalid={!!passErrors.code}
                  disabled={savingPass}
                  className="h-11 w-full text-center font-mono text-lg tracking-[0.5em] tabular-nums"
                />
                {passErrors.code && <p className="text-xs text-danger-text">{passErrors.code}</p>}
              </div>
              <NoticeBox notice={passNotice} />
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" disabled={savingPass}>
                  {savingPass ? "Cambiando…" : "Confirmar cambio"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={savingPass || cooldown > 0}
                  onClick={() => void resendCode()}
                >
                  {cooldown > 0 ? `Reenviar código (${cooldown}s)` : "Reenviar código"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={savingPass}
                  onClick={() => {
                    setStep("form");
                    setPassNotice(null);
                    setPassErrors({});
                  }}
                >
                  Volver
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      {tfModal === "verify" && (
        <Modal
          title="Confirma tu correo"
          description="Hemos enviado un código de verificación a tu correo para comprobar que lo recibes correctamente."
          onClose={() => setTfModal(null)}
          busy={tfBusy}
          size="sm"
        >
          <form onSubmit={submitSetupCode} noValidate className="space-y-4">
            <p className="text-sm text-text-2">
              Lo enviamos a <span className="font-semibold">{maskEmail(tfSentTo)}</span>. Vale 10 minutos. La
              verificación en dos pasos no se activa hasta que lo escribas.
            </p>
            {emailMode === "console" && (
              <p className="rounded-md border bg-subtle px-3 py-2 text-xs text-text-3">
                Modo desarrollo: sin SMTP, el código aparece en la consola del servidor.
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="setup-code" required>Código de verificación</Label>
              <Input
                id="setup-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={tfCode}
                // Solo dígitos: no se puede teclear ni pegar otra cosa.
                onChange={(e) => setTfCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                aria-invalid={!!tfCodeError}
                disabled={tfBusy}
                className="h-11 w-full text-center font-mono text-lg tracking-[0.5em] tabular-nums"
              />
              {tfCodeError && (
                <p role="alert" className="text-xs text-danger-text">
                  {tfCodeError}
                </p>
              )}
            </div>
            <ModalFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={tfBusy || tfCooldown > 0}
                onClick={() => void resendSetupCode()}
              >
                {tfCooldown > 0 ? `Reenviar código (${tfCooldown}s)` : "Reenviar código"}
              </Button>
              <Button type="submit" disabled={tfBusy}>
                {tfBusy ? "Verificando…" : "Verificar y activar"}
              </Button>
            </ModalFooter>
          </form>
        </Modal>
      )}

      {tfModal === "codes" && (
        <Modal
          title="Guarda tus códigos de respaldo"
          description="Si algún día el correo no te llega, cada uno de estos códigos te deja entrar una sola vez."
          onClose={closeCodes}
          size="sm"
        >
          <div className="space-y-4">
            <p className="rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-xs text-warning-text">
              Guárdalos ahora en un lugar seguro (un gestor de contraseñas o impresos). No se vuelven a mostrar:
              si los pierdes, genera nuevos desde Seguridad.
            </p>
            <ul
              aria-label="Códigos de respaldo"
              className="grid grid-cols-2 gap-2 rounded-md border bg-subtle/50 p-3 font-mono text-sm tracking-wider"
            >
              {tfCodes.map((c) => (
                <li key={c} className="select-all text-center">
                  {c}
                </li>
              ))}
            </ul>
            {tfCodeError && (
              <p role="alert" className="text-xs text-danger-text">
                {tfCodeError}
              </p>
            )}
            <ModalFooter>
              <Button type="button" variant="outline" onClick={() => void copyBackupCodes()}>
                {tfCopied ? (
                  <Check className="mr-1 h-4 w-4" aria-hidden />
                ) : (
                  <Copy className="mr-1 h-4 w-4" aria-hidden />
                )}
                {tfCopied ? "Copiados" : "Copiar códigos"}
              </Button>
              <Button type="button" variant="outline" onClick={downloadBackupCodes}>
                <Download className="mr-1 h-4 w-4" aria-hidden />
                Descargar
              </Button>
              <Button type="button" onClick={closeCodes}>
                Ya los guardé
              </Button>
            </ModalFooter>
          </div>
        </Modal>
      )}
    </div>
  );
}
