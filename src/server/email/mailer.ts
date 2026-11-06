import nodemailer from "nodemailer";
import { consoleMailerAllowed, smtpConfig } from "@/server/email/config";

/**
 * Adaptador del correo saliente (contrato público: `sendMail`). Detrás de él
 * vive nodemailer hablando SMTP con el servidor del negocio; cambiar de
 * transporte no toca a nadie más.
 *
 * Degradación: sin SMTP en producción, `sendMail` lanza `EmailNotConfiguredError`
 * y quien llama decide (el restablecimiento ya lo evita antes, con
 * `passwordResetAvailable`). Fuera de producción imprime en consola.
 */

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * Nombre con el que sale el remitente (la marca del negocio de quien recibe). La dirección sigue
   * siendo la de `SMTP_FROM`; solo cambia el nombre que se ve. Sin él, el de `SMTP_FROM`.
   */
  fromName?: string;
};

/** Solo la dirección de un remitente `Nombre <correo@dominio>` o `correo@dominio`. */
export function senderAddress(from: string): string {
  const m = /<([^<>]+)>\s*$/.exec(from.trim());
  return (m ? m[1]! : from).trim();
}

/** El nombre que se ve en el remitente, sin saltos de línea ni caracteres que rompan el encabezado. */
export function cleanSenderName(name: string): string {
  return name.replace(/[\r\n\t"<>\\]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** El `from` de nodemailer: el nombre de la marca (si hay) sobre la dirección de la instancia. */
export function buildFrom(configFrom: string, fromName?: string): string | { name: string; address: string } {
  const name = fromName ? cleanSenderName(fromName) : "";
  return name ? { name, address: senderAddress(configFrom) } : configFrom;
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super("El correo saliente no está configurado (SMTP_HOST y SMTP_FROM)");
    this.name = "EmailNotConfiguredError";
  }
}

export async function sendMail(message: MailMessage): Promise<void> {
  const config = smtpConfig();
  if (!config) {
    if (consoleMailerAllowed()) {
      // Solo desarrollo: ver el código sin montar un servidor de correo.
      console.log(
        `[correo:desarrollo] Para: ${message.to}\nAsunto: ${message.subject}\n${message.text}`
      );
      return;
    }
    throw new EmailNotConfiguredError();
  }

  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user ? { auth: { user: config.user, pass: config.pass ?? "" } } : {}),
    // Un servidor de correo caído no debe colgar la petición.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });

  try {
    await transport.sendMail({
      from: buildFrom(config.from, message.fromName),
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
  } finally {
    transport.close();
  }
}
