import Link from "next/link";
import { RegistroForm } from "@/components/auth/registro-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isPublicSignupAllowed } from "@/server/auth/registration";
import { passwordResetAvailable } from "@/server/email/config";

// Que haya o no registro depende del entorno: se lee en cada petición.
export const dynamic = "force-dynamic";

/**
 * Registro de un propietario nuevo: crea su cuenta y su propio negocio. Solo existe con
 * `ALLOW_SIGNUP=true`; sin él se dice con claridad en vez de dejar un formulario que no funciona.
 */
export default async function RegistroPage() {
  if (!(await isPublicSignupAllowed())) {
    return (
      <Card className="shadow-md">
        <CardHeader>
          <CardTitle>Registro no disponible</CardTitle>
          <CardDescription>
            Esta instancia no acepta registros nuevos. Si ya tienes cuenta, inicia sesión; si eres parte de un
            equipo, pide al propietario que te cree el acceso.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/iniciar-sesion" className="text-sm text-primary hover:underline">
            Volver a iniciar sesión
          </Link>
        </CardContent>
      </Card>
    );
  }
  if (!passwordResetAvailable()) {
    return (
      <Card className="shadow-md">
        <CardHeader>
          <CardTitle>Registro no disponible</CardTitle>
          <CardDescription>
            Para registrarse hace falta verificar el correo con un código, y esta instancia todavía no tiene el
            correo configurado.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-text-2">
            Quien administra el servidor debe definir <code>SMTP_HOST</code> y <code>SMTP_FROM</code> y reiniciar la
            aplicación.
          </p>
          <Link href="/iniciar-sesion" className="text-sm text-primary hover:underline">
            Volver a iniciar sesión
          </Link>
        </CardContent>
      </Card>
    );
  }
  return <RegistroForm />;
}
