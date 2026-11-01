/**
 * El correo con el código para restablecer la contraseña. Puro: sin red ni
 * base, para probarlo con tablas de casos.
 */

export type ResetCodeEmail = { subject: string; text: string; html: string };

/** Lo que escribió el dueño (el nombre de la marca) va al HTML: se escapa. */
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function resetCodeEmail(input: {
  code: string;
  /** Cuántos minutos vale el código. */
  minutes: number;
  /** El nombre del negocio (Ajustes → Marca). */
  productName: string;
}): ResetCodeEmail {
  const { code, minutes } = input;
  const nombre = input.productName.trim() || "tu cuenta";
  const subject = `Tu código para restablecer la contraseña: ${code}`;

  const text = [
    `Recibimos una solicitud para restablecer la contraseña de ${nombre}.`,
    "",
    `Tu código es: ${code}`,
    "",
    `Vale ${minutes} minutos y solo se puede usar una vez.`,
    "Si no fuiste tú, ignora este correo: tu contraseña no cambia.",
  ].join("\n");

  const html = `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#f6f8fc;font-family:Arial,Helvetica,sans-serif;color:#202020">
    <div style="max-width:440px;margin:0 auto;background:#ffffff;border:1px solid #e4e7f0;border-radius:12px;padding:28px">
      <h1 style="margin:0 0 12px;font-size:18px;color:#0a0f2c">Restablecer contraseña</h1>
      <p style="margin:0 0 16px;font-size:14px;line-height:1.5">
        Recibimos una solicitud para restablecer la contraseña de <strong>${escapeHtml(nombre)}</strong>.
      </p>
      <p style="margin:0 0 6px;font-size:13px;color:#42506b">Tu código es</p>
      <p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:8px;color:#0328ba">${escapeHtml(code)}</p>
      <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#42506b">
        Vale ${minutes} minutos y solo se puede usar una vez.
      </p>
      <p style="margin:0;font-size:13px;line-height:1.5;color:#42506b">
        Si no fuiste tú, ignora este correo: tu contraseña no cambia.
      </p>
    </div>
  </body>
</html>`;

  return { subject, text, html };
}

/** Un correo de la cuenta: el mismo marco para el código y para el aviso. */
function accountMail(input: {
  title: string;
  body: string[];
  highlight?: string;
  footer: string;
}): string {
  const paragraphs = input.body
    .map((p) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.5">${p}</p>`)
    .join("\n      ");
  const highlight = input.highlight
    ? `<p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:8px;color:#0328ba">${escapeHtml(input.highlight)}</p>`
    : "";
  return `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#f6f8fc;font-family:Arial,Helvetica,sans-serif;color:#202020">
    <div style="max-width:440px;margin:0 auto;background:#ffffff;border:1px solid #e4e7f0;border-radius:12px;padding:28px">
      <h1 style="margin:0 0 12px;font-size:18px;color:#0a0f2c">${escapeHtml(input.title)}</h1>
      ${paragraphs}
      ${highlight}
      <p style="margin:0;font-size:13px;line-height:1.5;color:#42506b">${input.footer}</p>
    </div>
  </body>
</html>`;
}

/** El código para autorizar el cambio de contraseña desde Mi perfil. */
export function passwordChangeCodeEmail(input: {
  code: string;
  minutes: number;
  productName: string;
}): ResetCodeEmail {
  const nombre = input.productName.trim() || "tu cuenta";
  const subject = `Tu código para cambiar la contraseña: ${input.code}`;
  const text = [
    `Alguien con tu sesión abierta pidió cambiar la contraseña de ${nombre}.`,
    "",
    `Tu código es: ${input.code}`,
    "",
    `Vale ${input.minutes} minutos y solo se puede usar una vez.`,
    "Si no fuiste tú, no compartas el código.",
  ].join("\n");
  const html = accountMail({
    title: "Confirma el cambio de contraseña",
    body: [
      `Alguien con tu sesión abierta pidió cambiar la contraseña de <strong>${escapeHtml(nombre)}</strong>. Para autorizarlo, escribe este código:`,
    ],
    highlight: input.code,
    footer: `Vale ${input.minutes} minutos y solo se puede usar una vez. Si no fuiste tú, no compartas el código.`,
  });
  return { subject, text, html };
}

/** El código de PRUEBA al activar la verificación en dos pasos: comprueba que el correo llega. */
export function twoFactorSetupCodeEmail(input: {
  code: string;
  minutes: number;
  productName: string;
}): ResetCodeEmail {
  const nombre = input.productName.trim() || "tu cuenta";
  const subject = `Tu código para activar la verificación en dos pasos: ${input.code}`;
  const text = [
    `Estás activando la verificación en dos pasos en ${nombre}.`,
    "",
    `Tu código de prueba es: ${input.code}`,
    "",
    `Vale ${input.minutes} minutos y solo se puede usar una vez.`,
    "Escribirlo confirma que este correo recibe tus códigos. Si no fuiste tú, ignora este mensaje.",
  ].join("\n");
  const html = accountMail({
    title: "Activa la verificación en dos pasos",
    body: [
      `Estás activando la verificación en dos pasos en <strong>${escapeHtml(nombre)}</strong>. Escribe este código para confirmar que recibes los correos:`,
    ],
    highlight: input.code,
    footer: `Vale ${input.minutes} minutos y solo se puede usar una vez. Si no fuiste tú, ignora este mensaje.`,
  });
  return { subject, text, html };
}

/** El código de la verificación en dos pasos al iniciar sesión. */
export function loginCodeEmail(input: { code: string; minutes: number; productName: string }): ResetCodeEmail {
  const nombre = input.productName.trim() || "tu cuenta";
  const subject = `Tu código de acceso: ${input.code}`;
  const text = [
    `Alguien está iniciando sesión en ${nombre} con tu correo y contraseña.`,
    "",
    `Tu código de verificación es: ${input.code}`,
    "",
    `Vale ${input.minutes} minutos y solo se puede usar una vez.`,
    "Si no fuiste tú, no compartas el código y cambia tu contraseña.",
  ].join("\n");
  const html = accountMail({
    title: "Código de verificación",
    body: [
      `Alguien está iniciando sesión en <strong>${escapeHtml(nombre)}</strong> con tu correo y contraseña. Para entrar, escribe este código:`,
    ],
    highlight: input.code,
    footer: `Vale ${input.minutes} minutos y solo se puede usar una vez. Si no fuiste tú, no compartas el código y cambia tu contraseña.`,
  });
  return { subject, text, html };
}

/** El código para confirmar el correo al crear una cuenta nueva. */
export function signupCodeEmail(input: { code: string; minutes: number; productName: string }): ResetCodeEmail {
  const nombre = input.productName.trim() || "tu cuenta";
  const subject = `Tu código para verificar tu correo: ${input.code}`;
  const text = [
    `Gracias por registrarte. Para activar tu cuenta en ${nombre}, escribe este código:`,
    "",
    `Tu código de verificación es: ${input.code}`,
    "",
    `Vale ${input.minutes} minutos y solo se puede usar una vez.`,
    "Si no creaste una cuenta, ignora este correo: no pasa nada.",
  ].join("\n");
  const html = accountMail({
    title: "Verifica tu correo",
    body: [
      `Gracias por registrarte. Para activar tu cuenta en <strong>${escapeHtml(nombre)}</strong>, escribe este código:`,
    ],
    highlight: input.code,
    footer: `Vale ${input.minutes} minutos y solo se puede usar una vez. Si no creaste una cuenta, ignora este correo.`,
  });
  return { subject, text, html };
}

/** El aviso de seguridad inmediato: se cambió una contraseña. Va a la persona y a los propietarios. */
export function passwordChangedAlertEmail(input: {
  /** Nombre de quien cambió la contraseña. */
  userName: string;
  userEmail: string;
  /** Cuándo, ya formateado (se muestra tal cual). */
  when: string;
  productName: string;
}): ResetCodeEmail {
  const nombre = input.productName.trim() || "tu cuenta";
  const subject = `Aviso de seguridad: se cambió una contraseña en ${nombre}`;
  const text = [
    `Se cambió la contraseña de ${input.userName} (${input.userEmail}) en ${nombre}.`,
    `Cuándo: ${input.when}`,
    "",
    "Por seguridad se cerraron las demás sesiones de esa cuenta.",
    "Si no fue una acción esperada, revisa el equipo y restablece la contraseña de esa cuenta.",
  ].join("\n");
  const html = accountMail({
    title: "Se cambió una contraseña",
    body: [
      `Se cambió la contraseña de <strong>${escapeHtml(input.userName)}</strong> (${escapeHtml(input.userEmail)}) en <strong>${escapeHtml(nombre)}</strong>.`,
      `Cuándo: ${escapeHtml(input.when)}`,
    ],
    footer:
      "Por seguridad se cerraron las demás sesiones de esa cuenta. Si no fue una acción esperada, revisa el equipo y restablece la contraseña de esa cuenta.",
  });
  return { subject, text, html };
}
