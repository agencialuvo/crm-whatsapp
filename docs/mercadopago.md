# Cobro con Mercado Pago

Cómo cobrar los planes (Emprendedor, Pro y Enterprise) automáticamente cada mes. Spec [046](../specs/046-pasarela-pagos-mercadopago/spec.md). Es un **conector opcional de la plataforma**: apagado por defecto, y sin él todo sigue funcionando a mano desde el [panel de Super Admin](super-admin.md).

> **Estado de la verificación.** El código está probado contra una base real y un Mercado Pago **simulado** (el mock de `src/app/api/dev/mp-mock/`). **Todavía no se ha probado contra el sandbox real de Mercado Pago Perú.** Haz la lista de «Antes de producción» (abajo) con credenciales de prueba antes de cobrar a nadie.

## Quién lo enciende

Solo la instancia que **vende** los planes (la plataforma SaaS). Una instalación de un solo negocio no lo necesita y no debe encenderlo.

## Puesta en marcha

1. Crea una aplicación en [mercadopago.com.pe/developers](https://www.mercadopago.com.pe/developers) → **Tus integraciones**.
2. En **Credenciales** copia el **Access Token** (usa el de **prueba** mientras pruebas).
3. En **Webhooks** configura la URL `https://TU-DOMINIO/api/webhooks/mercadopago` con los eventos **Planes y suscripciones** y **Pagos**, y copia la **Clave secreta**.
4. En el `.env` del servidor:

   ```bash
   MERCADOPAGO=on
   MP_ACCESS_TOKEN=APP_USR-...        # secreto: solo servidor
   MP_WEBHOOK_SECRET=...              # la «clave secreta» del paso 3
   PAYMENT_GRACE_DAYS=5               # opcional: días de gracia tras un cobro rechazado
   ```

   (`MP_PUBLIC_KEY` **no se usa** en este paso.) Las variables también van en la plataforma de hosting (runtime, no build).
5. `pnpm doctor` valida el token con una llamada de solo lectura y no imprime el secreto.
6. Los planes deben estar en la **misma moneda que tu cuenta de Mercado Pago** (`PEN` en Perú). Si no, Mercado Pago rechaza el cobro y el cliente ve «La moneda del plan no coincide con la cuenta».

## Qué ve el cliente

- **Ajustes → Suscripción**: su plan y estado, los planes de pago con **Pagar con Mercado Pago**, el cambio de plan, **Cancelar suscripción** y el historial de cobros. Solo el **dueño** de la cuenta puede contratar, cambiar o cancelar; los demás roles lo ven.
- **`/suscripcion-inactiva`** (con `SAAS_ENFORCE`): la misma pantalla, para que quien tiene la prueba vencida pague y vuelva a entrar. Los planes se pagan en la página de Mercado Pago: **aquí no se guardan datos de tarjeta**.
- Al volver del pago, la pantalla confirma el cobro **consultando a Mercado Pago** (no depende de que el webhook haya llegado).

## Reglas de cobro

| Situación | Qué pasa |
|---|---|
| Primer cobro **aprobado** (desde la Demo) | Pasa a `active` por 30 días y cuenta como **conversión** (origen «cobro de Mercado Pago»). Solo «autorizar» la suscripción **no** activa: se espera al cobro. |
| Cobro mensual aprobado | Se renueva 30 días desde el fin vigente (un pago adelantado no pierde días). |
| Cobro mensual **rechazado** | Pasa a `past_due` (`payment_failed`). **5 días de gracia** desde el fin del periodo: aviso en la app, sin bloqueo. Pasada la gracia se bloquea (con `SAAS_ENFORCE`). Si el reintento de Mercado Pago entra, vuelve a `active`. Si Mercado Pago agota los reintentos y cancela, pasa a `canceled`. |
| Primer cobro rechazado | No cambia nada: sigue en prueba; el cliente ve el motivo («fondos insuficientes») y reintenta. |
| **Subir** de plan | Rige ya; el precio nuevo desde el próximo cobro. Sin prorrateo. |
| **Bajar** de plan | Queda programado para el próximo corte; mientras tanto conserva lo pagado. |
| El cliente **cancela** | No se cobra más y conserva el acceso hasta el fin del periodo pagado. No hay reembolso automático. |
| Cancelada o pausada desde Mercado Pago | Se refleja sola (cancelada: activa hasta el corte). |
| Reembolso / contracargo | Se registra y queda **«a revisar»**; no suspende solo. |
| Precio de un plan cambia | **No** toca a quien ya paga: cada suscripción conserva el monto pactado. |

## En el panel de Super Admin

El directorio marca «Mercado Pago» bajo el plan y el cajón muestra último y próximo cobro, el plan programado y el historial de **cobros**. La conversión se desglosa en «por cobro de Mercado Pago» y «activadas a mano». Sobre una suscripción que **cobra Mercado Pago**:

| Acción | Resultado |
|---|---|
| Suspender / Cancelar / Reactivar (suspendida) | Se propaga a Mercado Pago primero; si Mercado Pago falla, **no cambia nada** (502). |
| Cambiar de plan | También actualiza el monto en Mercado Pago. |
| Activar / Asignar | `409 managed_by_provider`: la cobra Mercado Pago, no se activa a mano (evita doble cobro). |
| Reactivar una cancelada | `409 needs_new_checkout`: el cliente debe contratar de nuevo. |

Una suscripción **sin** Mercado Pago (o cuya suscripción en Mercado Pago ya terminó) se gestiona como antes.

## Cómo se protege

- El webhook valida la firma `x-signature` (HMAC-SHA256) **antes de tocar la base**; sin secreto configurado no acepta nada (503); firma inválida es 401.
- El aviso es solo un timbre: **el estado se consulta a la API de Mercado Pago** con tu token, así un aviso falso, repetido o fuera de orden no puede cambiar nada.
- Idempotencia en tres capas: bandeja por `x-request-id`, un cobro = una fila (`mp_authorized_payment_id` único, estado que solo avanza) y `applied_at` bajo el candado de la organización.
- El `external_reference` es el id opaco del checkout; organización y plan se leen de la base. El monto y la moneda del primer cobro deben ser los del checkout o queda «a revisar» sin activar.
- Solo se redirige al cliente a dominios de Mercado Pago.
- Un temporizador horario reprocesa avisos que fallaron, repasa las suscripciones sin noticias hace más de 36 h y abandona los checkouts vencidos (24 h).

## Pruebas locales (mock)

Con `WA_MOCK_ENABLED=true`, `MERCADOPAGO=on`, `MP_ACCESS_TOKEN` y `MP_WEBHOOK_SECRET` cualquiera y `MP_API_BASE=http://localhost:3002/api/dev/mp-mock`, el mock sirve la API, una página de pago (`Pagar`, `Tarjeta rechazada`, `Cancelar`) y firma sus webhooks como lo haría Mercado Pago. Control: `POST /api/dev/mp-mock/_control` (`charge_month`, `reject_month`, `mp_cancel`, `refund`, `resend_last`, `send_bad_signature`, `fail_next`, `fail_create`) y estado en `GET /api/dev/mp-mock/_state`.

## Antes de producción (verificación con credenciales de prueba)

Puntos de la spec 046 que se **supusieron** y hay que confirmar contra el sandbox de Perú:

- [ ] Crear una suscripción en `PEN` sin plan asociado (`POST /preapproval`) y que el `init_point` abra.
- [ ] El correo del pagador (`payer_email`) funciona aunque el comprador use otro correo en Mercado Pago.
- [ ] Pagar con una tarjeta de prueba **aprobada** y con una **rechazada**.
- [ ] Que llegue el webhook real y su firma verifique (formato del manifiesto `id:…;request-id:…;ts:…;`).
- [ ] Cambiar el monto de una suscripción autorizada (`PUT /preapproval`).
- [ ] El calendario de reintentos de un cobro rechazado y qué estado queda al agotarlos.
- [ ] `GET /authorized_payments/search?preapproval_id=…` devuelve los cobros.
- [ ] Cancelar y pausar desde la API y desde el panel de Mercado Pago.
- [ ] Un reembolso y un contracargo de prueba.

Los comprobantes electrónicos (boleta/factura SUNAT), Yape y otros pagos no recurrentes, los planes anuales y los correos de cobranza quedan **fuera** de este paso.
