import { LoginForm } from "@/components/auth/login-form";
import { isPublicSignupAllowed } from "@/server/auth/registration";
import { passwordResetAvailable } from "@/server/email/config";

// Que haya o no registro depende del entorno: se lee en cada petición.
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // Sin correo no hay a dónde mandar el código de verificación: no se ofrece el registro.
  const signupEnabled = (await isPublicSignupAllowed()) && passwordResetAvailable();
  return <LoginForm signupEnabled={signupEnabled} />;
}
