import { withAuth } from "@/lib/api";
import { changeCodeAvailable } from "@/server/auth/password-change";
import { backupCodesRemaining, isTwoFactorEnabled } from "@/server/auth/two-factor";

export const dynamic = "force-dynamic";

/**
 * Mi perfil → estado de la verificación en dos pasos. Cambiarlo va por rutas propias:
 * `enable/start` + `enable/confirm` (con código de prueba al correo), `disable` y
 * `backup-codes`; todas piden la contraseña actual.
 */
export const GET = withAuth(async (session) => {
  return Response.json({
    enabled: await isTwoFactorEnabled(session.userId),
    emailAvailable: changeCodeAvailable(),
    backupCodesRemaining: await backupCodesRemaining(session.userId),
  });
});
