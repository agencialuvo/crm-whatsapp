import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP, organization } from "better-auth/plugins";
import { getDb, schema } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { AUTH_RATE_LIMIT, checkRateLimit, clientIp } from "@/lib/rate-limit";
import {
  onUserCreated,
  resolveActiveOrganizationId,
} from "@/server/auth/on-signup";
import {
  isBlockedEmailOtpPath,
  REQUEST_RESET_PATH,
  RESET_CODE_LENGTH,
  RESET_CODE_MAX_ATTEMPTS,
  RESET_CODE_TTL_SECONDS,
  RESET_PASSWORD_PATH,
  sendResetCode,
} from "@/server/auth/password-reset";
import { CAPTCHA_ACTIONS, CAPTCHA_REQUIRED_MESSAGE } from "@/lib/captcha";
import { captchaEnabled, verifyCaptchaHeader, verifyCaptchaProof } from "@/server/auth/captcha";
import { isPublicSignupAllowed } from "@/server/auth/registration";
import { findUserByEmail, isTwoFactorVerified } from "@/server/auth/two-factor";
import { passwordResetAvailable } from "@/server/email/config";

/**
 * Contexto interno del proceso: permite que ciertas llamadas server-side (el alta de
 * cuentas de equipo del owner, el cambio de contraseña con código de Mi perfil)
 * atraviesen un gate que por HTTP está cerrado. No es alcanzable desde fuera: solo
 * envuelve llamadas internas.
 */
type InternalKind = "signup" | "password-change";

const globalForInternal = globalThis as unknown as {
  __voceroInternalAuth?: AsyncLocalStorage<InternalKind>;
};

// En globalThis: los módulos pueden evaluarse más de una vez (una por ruta en
// dev) y todas las copias deben compartir el mismo contexto.
function internalContext(): AsyncLocalStorage<InternalKind> {
  if (!globalForInternal.__voceroInternalAuth) {
    globalForInternal.__voceroInternalAuth = new AsyncLocalStorage<InternalKind>();
  }
  return globalForInternal.__voceroInternalAuth;
}

export function runInternalSignup<T>(fn: () => Promise<T>): Promise<T> {
  return internalContext().run("signup", fn);
}

/** El cambio de contraseña solo entra por `/api/account/password` (contraseña actual + código del correo). */
export function runInternalPasswordChange<T>(fn: () => Promise<T>): Promise<T> {
  return internalContext().run("password-change", fn);
}

function isInternal(kind: InternalKind): boolean {
  return internalContext().getStore() === kind;
}

const RATE_LIMITED_PATHS = new Set([
  "/sign-in/email",
  "/sign-up/email",
  REQUEST_RESET_PATH,
  RESET_PASSWORD_PATH,
]);

/** Pedir el código: pocos por correo, para no usar el CRM como bomba de correo. */
const RESET_REQUEST_PER_EMAIL = { windowMs: 10 * 60 * 1000, max: 3 };

function createAuth() {
  const env = getEnv();
  return betterAuth({
    baseURL: env.APP_BASE_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        organization: schema.organization,
        member: schema.member,
        invitation: schema.invitation,
      },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      minPasswordLength: 8,
      // Quien restablece la contraseña es porque alguien más pudo tenerla: se
      // cierran las sesiones abiertas.
      revokeSessionsOnPasswordReset: true,
    },
    plugins: [
      organization({ creatorRole: "owner" }),
      // Restablecer la contraseña con un código por correo. El código se guarda
      // hasheado, vence y se invalida tras unos intentos. Solo se exponen las dos
      // rutas del restablecimiento (ver el hook de abajo).
      emailOTP({
        otpLength: RESET_CODE_LENGTH,
        expiresIn: RESET_CODE_TTL_SECONDS,
        allowedAttempts: RESET_CODE_MAX_ATTEMPTS,
        storeOTP: "hashed",
        disableSignUp: true,
        sendVerificationOTP: sendResetCode,
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Rate limit por IP en login/registro (FR-062): 10 / 10 min → 429.
        if (RATE_LIMITED_PATHS.has(ctx.path)) {
          const ip = clientIp(ctx.headers);
          const result = checkRateLimit(`${ctx.path}:${ip}`, AUTH_RATE_LIMIT);
          if (!result.allowed) {
            throw new APIError("TOO_MANY_REQUESTS", {
              message: "Demasiados intentos; espera unos minutos",
            });
          }
        }
        // 2FA por correo: una cuenta que lo activó NO entra por aquí con solo la
        // contraseña. Solo pasa la petición que viene de /api/login/two-factor/verify
        // (ya comprobó contraseña y código). Responde igual que una contraseña
        // mala: no se revela qué cuentas tienen 2FA.
        if (ctx.path === "/sign-in/email") {
          const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? "");
          const account = email ? await findUserByEmail(email) : null;
          if (account?.twoFactorEnabled && !isTwoFactorVerified(account.id)) {
            throw new APIError("UNAUTHORIZED", {
              code: "INVALID_EMAIL_OR_PASSWORD",
              message: "Invalid email or password",
            });
          }
          // «No soy un robot»: la constancia la emitió el paso 1 (/api/login/two-factor/start)
          // tras validar el desafío. El paso 2 de un 2FA ya la pasó por ahí.
          if (
            captchaEnabled() &&
            !(account && isTwoFactorVerified(account.id)) &&
            !verifyCaptchaProof(ctx.headers, email)
          ) {
            throw new APIError("BAD_REQUEST", { code: "CAPTCHA_REQUIRED", message: CAPTCHA_REQUIRED_MESSAGE });
          }
        }
        // Cambiar la contraseña por la ruta nativa se saltaría el código del correo: solo
        // pasa la llamada interna de /api/account/password.
        if ((ctx.path === "/change-password" || ctx.path === "/set-password") && !isInternal("password-change")) {
          throw new APIError("NOT_FOUND", { message: "No existe" });
        }
        // El plugin de códigos trae rutas que nadie pidió (entrar solo con un
        // código, verificar o cambiar el correo): 404.
        if (isBlockedEmailOtpPath(ctx.path)) {
          throw new APIError("NOT_FOUND", { message: "No existe" });
        }
        if (ctx.path === REQUEST_RESET_PATH) {
          // Sin un servidor de correo no hay a dónde mandar el código.
          if (!passwordResetAvailable()) {
            throw new APIError("SERVICE_UNAVAILABLE", {
              message: "El restablecimiento por correo no está configurado",
            });
          }
          // Antes de gastar base de datos o correo: sin desafío resuelto, no se manda nada.
          if (!(await verifyCaptchaHeader(ctx.headers, CAPTCHA_ACTIONS.passwordReset, clientIp(ctx.headers)))) {
            throw new APIError("BAD_REQUEST", { code: "CAPTCHA_REQUIRED", message: CAPTCHA_REQUIRED_MESSAGE });
          }
          const email = String(
            (ctx.body as { email?: unknown } | undefined)?.email ?? ""
          ).toLowerCase();
          const byEmail = checkRateLimit(`reset-request:${email}`, RESET_REQUEST_PER_EMAIL);
          if (!byEmail.allowed) {
            throw new APIError("TOO_MANY_REQUESTS", {
              message: "Demasiados intentos; espera unos minutos",
            });
          }
        }
        // Registro por HTTP cerrado: las cuentas se crean por backend (FR-060).
        if (ctx.path === "/sign-up/email") {
          if (!isInternal("signup") && !(await isPublicSignupAllowed())) {
            throw new APIError("FORBIDDEN", {
              message:
                "El registro está deshabilitado: las cuentas las crea quien administra el servidor",
            });
          }
          // El alta interna (propietario → equipo) ya validó el desafío en su propia ruta.
          if (!isInternal("signup") && !(await verifyCaptchaHeader(ctx.headers, CAPTCHA_ACTIONS.signup, clientIp(ctx.headers)))) {
            throw new APIError("BAD_REQUEST", { code: "CAPTCHA_REQUIRED", message: CAPTCHA_REQUIRED_MESSAGE });
          }
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await onUserCreated(user.id, user.name);
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const organizationId = await resolveActiveOrganizationId(
              session.userId
            );
            return {
              data: { ...session, activeOrganizationId: organizationId },
            };
          },
        },
      },
    },
  });
}

type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as unknown as { __voceroAuth?: Auth };

export function getAuth(): Auth {
  if (!globalForAuth.__voceroAuth) globalForAuth.__voceroAuth = createAuth();
  return globalForAuth.__voceroAuth;
}
