# Super Admin: planes, membresías y panel de control

El **Super Admin** es el operador de la *plataforma* (no de un negocio): ve todas las organizaciones, su plan y el estado de su suscripción, y puede cambiarlos a mano. Vive en `/super-admin`. Spec: [045](../specs/045-super-admin-membresias/spec.md).

## Cómo se da (y se quita) la bandera

La bandera `user.is_super_admin` **solo se concede por la línea de comandos del servidor**. No existe pantalla para otorgarla y el sistema de cuentas no la expone, así que nadie puede auto-promoverse por HTTP.

```bash
pnpm superadmin grant correo@ejemplo.com    # da la bandera a una cuenta que YA existe
pnpm superadmin revoke correo@ejemplo.com   # la quita (surte efecto en la siguiente petición)
pnpm superadmin list                        # quiénes son Super Admin y si tienen 2FA
```

Cada concesión o revocación queda en la auditoría (`super_admin_audit`).

**Antes de conceder:** activa la **verificación en dos pasos** de esa cuenta en *Ajustes → Mi perfil*. El panel la exige; una cuenta sin ella ve una página que explica cómo activarla. (Una cuenta que no pertenece a ninguna organización no puede activarla desde la app: activa el 2FA mientras la cuenta aún pertenece a una.)

Un Super Admin **no necesita pertenecer a ninguna organización**: al iniciar sesión entra directo al panel.

## Qué ve y qué no

Solo **metadatos de la cuenta**: nombre de la organización, dueño (nombre y correo), plan, estado, fechas y conteos. **Nunca** conversaciones, contactos, mensajes, credenciales ni llaves. Quien no es Super Admin recibe un 404 en el panel y en `/api/super-admin/*` (el panel no revela que existe).

## Los planes

| Plan | Precio | Qué es |
|---|---|---|
| **Demo** | gratis · 14 días | La prueba con la que nace **toda** organización nueva. Incluye todo (los módulos y canales de Pro). |
| **Emprendedor** | S/ 79 / mes | Agenda, equipo y fidelización · WhatsApp. |
| **Pro** | S/ 149 / mes | Todo lo anterior + finanzas, atribución de anuncios, Instagram y Messenger. |
| **Enterprise** | S/ 299 / mes | Sin límites. |

Los planes antiguos «Básico» y «Salón» se retiraron: quien ya los tiene **conserva su acceso** y el panel los muestra como «Plan anterior». Los precios viven en `src/server/seed/platform-catalog.ts`; un plan ya sembrado no se pisa en el siguiente arranque. Los límites (`maxStaff`, `maxMonthlyAiTurns`) **hoy solo se declaran**: ninguna parte del sistema los aplica todavía.

## Estados y acciones

Estados: `trialing` (en prueba), `active`, `past_due` (una prueba vencida —`trial_ended`— o un pago vencido), `paused` (suspendida) y `canceled`. Una prueba cuyo periodo venció se ve como «Prueba vencida» al instante; un temporizador (cada hora) la persiste como `past_due`.

Acciones del panel, cada una con **motivo obligatorio** (queda en la historia y en la auditoría):

| Acción | Desde | Qué hace |
|---|---|---|
| Asignar plan | sin suscripción | Para organizaciones anteriores al módulo SaaS. |
| Activar plan de pago | prueba, vencida, suspendida, cancelada | Plan de pago por 30 días. Desde una prueba cuenta como **conversión** (marcada como manual). |
| Cambiar de plan | cualquiera | Solo cambia el plan. |
| Extender la prueba | prueba o prueba vencida | De 1 a 90 días; si ya venció, la reabre desde hoy. |
| Fijar fecha de corte | prueba o activa | La fecha exacta en que termina el periodo. |
| Suspender | prueba, activa, vencida | `paused`. |
| Cancelar | cualquiera menos cancelada | Inmediata o «al final del periodo». |
| Reactivar | suspendida o cancelada | Vuelve a `active` por 30 días. |

## El dashboard

- **Organizaciones por estado**: activas, en prueba, vencidas, canceladas (y suspendidas). La suma siempre da el total; las organizaciones anteriores al módulo SaaS salen como «sin suscripción».
- **Por plan**: plan × estado; los planes retirados aparecen juntos como «Planes anteriores».
- **Conversión Demo → pago**: se calcula sobre la historia de suscripciones (`subscription_event`). La tasa **cerrada** es `convirtieron / (convirtieron + perdidas)`: las pruebas todavía en curso no la deprimen. Las suscripciones anteriores al seguimiento no cuentan (no se vio cuándo empezó su prueba).
- **MRR estimado**: la suma de los precios de lista de las suscripciones `active` de planes de pago (en soles). Es una estimación: no sabe de descuentos ni cortesías hasta que exista el cobro real.

## Bloquear a quien no está al día: `SAAS_ENFORCE`

Por defecto **nada se bloquea**: solo se muestra el aviso «Tu prueba termina en N días». Con `SAAS_ENFORCE=true`, una organización con la prueba vencida, suspendida o cancelada ve «Tu suscripción no está activa» en vez de la app y su API responde `403 SUBSCRIPTION_INACTIVE`. Los **mensajes entrantes siguen guardándose** (no se pierde nada del cliente) y el agente de IA y las automatizaciones **no se pausan** en este paso.

> **Cuidado en una instalación propia.** Toda organización nueva nace en la Demo de 14 días. Si enciendes `SAAS_ENFORCE` en una instalación de un solo negocio, **asígnale antes un plan de pago** desde el panel (Activar), o quedará bloqueada al terminar sus 14 días. Las organizaciones sin suscripción nunca se bloquean.
