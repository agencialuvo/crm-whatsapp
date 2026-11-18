# 046 — Pasarela de pagos: Mercado Pago (cobro mensual y conversión automática)

**Feature Branch**: `feat/046-pasarela-pagos-mercadopago`

**Created**: 2026-11-17

**Status**: **Implementada** (2026-11-17), con Q1–Q9 aprobadas tal como se propusieron y Q10 resuelta así: se implementa y se prueba TODO contra el mock; las credenciales reales del sandbox de Perú se inyectarán después para validar los puntos ⚠ en vivo (lista en [docs/mercadopago.md](../../docs/mercadopago.md)). Q11 (contracargos solo «a revisar») y Q12 (credenciales en variables de entorno) se tomaron con la recomendación. Pendiente de commit. Verificada contra Postgres real (`billing-live`, 25 pruebas) y unitarias; **el E2E con navegador NO se corrió por instrucción del dueño** (el mock `mp-mock` y su página de pago quedan listos para cuando se pida) y **no se ha probado contra el sandbox real de Mercado Pago**.

Ajustes que salieron al implementar (respecto del texto de abajo):
- **El cliente vuelve a `/suscripcion-retorno`**, no a `/ajustes/suscripcion`: el layout de `(app)` manda a una organización bloqueada a `/suscripcion-inactiva` y se perdía el `?checkout=`. La página de retorno vive fuera de `(app)`.
- **«Primer cobro» = el checkout aún no está pagado** (no «la suscripción aún no está vinculada»): la prueba contra Postgres lo cazó. Al llegar `authorized` la suscripción ya queda vinculada, y el primer cobro habría perdido el plan y el monto del checkout (y dejado la organización en el plan Demo).
- **`reprocessPending` y la poda usan operadores de Drizzle**, no `sql` con `Date`: el driver rechaza fechas crudas en `sql`.
- **La puerta también escribe `billing_payment.applied_at` y `billing_checkout.status`** (bajo el candado de la organización) para que «aplicar el cobro» y «marcarlo aplicado» sean la misma transacción; el guardián permite esas tablas solo ahí y en `src/server/billing/`.
- **Cancelar del cliente** deja `mp_status = cancelled` por la puerta; **suspender/cancelar/reactivar del panel** pasan `providerStatus` a `applySubscriptionAction`.
- **El cambio de plan programado** (`downgrade_scheduled`) y el aplicado al cobrar usan `plan_changed`/`renewed` con los snapshots de plan; no hay un tipo de evento nuevo.
- **E2E**: el plan de la sección «Plan de pruebas» queda **diferido** por instrucción; la cobertura actual es unitaria + Postgres real.

**Input**: Paso 2 del SaaS. Automatizar el cobro mensual de Emprendedor (S/ 79), Pro (S/ 149) y Enterprise (S/ 299) con Mercado Pago, y que la conversión Demo → pago, el MRR y los estados se actualicen solos con cada cobro.

**Carril**: ciclo completo (Principio VI). Añade **una migración** (0081: columnas en `subscription`, tres tablas de cobro), **un conector externo** (`src/lib/mercadopago/` + `src/server/billing/`), **una ruta pública** (`/api/webhooks/mercadopago`), **una pantalla** (Ajustes → Suscripción) y **amplía la puerta única** `src/server/saas/subscription.ts` con eventos de pago. Va detrás de la bandera `MERCADOPAGO`, **apagada por defecto**.

## Lo que cambia respecto de 045 y por qué importa

045 dejó todo preparado a propósito: el enum `subscription_event.source` ya tiene `payment`, el estado `active` y la regla de conversión ya existen (`decideTransition` con `isConversion`), y el panel ya mide conversión y MRR desde la historia. **046 no inventa un segundo camino**: el cobro entra por la misma puerta, con una función nueva (`applyPaymentEvent`) y una regla pura nueva (`decidePayment`), y el guardián de «solo la puerta escribe la suscripción» sigue valiendo.

## Conflicto con la constitución (hay que decidirlo, ver Q1)

La constitución (II, endurecida en 1.4.0) **prohíbe billing como dependencia del núcleo** y solo admite un tercero como **conector opcional** con cinco condiciones. Y el alcance (VIII) dice que lo que solo sirve a una plataforma centralizada (billing, planes) queda fuera. 045 ya entró en ese terreno con aprobación expresa; 046 lo profundiza. Cómo se cumple cada condición:

| Condición | Cómo la cumple 046 |
|---|---|
| 1. Apagado por defecto tras bandera (ADR-001) | `MERCADOPAGO=on` **y** `MP_ACCESS_TOKEN` presente. Apagado: webhook y rutas `/api/billing/*` responden 404, la pantalla de suscripción no ofrece pagar, y todo sigue funcionando manual como hoy. |
| 2. Aislado tras adaptador con contrato público | Un único cliente `src/lib/mercadopago/client.ts` (como `src/lib/meta/` para Graph). Nadie más habla con `api.mercadopago.com`. |
| 3. Camino sin dependencia externa y degradación definida | El camino manual de 045 (Super Admin activa, cambia, suspende) sigue intacto y es el respaldo. Si Mercado Pago cae: **el CRM sigue operando** (la suscripción solo se evalúa localmente); pagar queda temporalmente no disponible con mensaje claro; los webhooks atrasados se reconcilian después. Nunca se bloquea a un cliente que ya pagó por una caída de la pasarela. |
| 4. Credenciales del propio negocio, cifradas | **Salvedad.** Aquí «el negocio» es el operador de la plataforma (la instancia que vende los planes), no cada tenant. Las credenciales son del operador, en variables de entorno del servidor (nunca al cliente ni a logs). Ver Q1 y Q12. |
| 5. Verificable apagado y encendido, con mock y camino infeliz | `src/app/api/dev/mp-mock/` + `pnpm test:e2e:mercadopago` (apagado y encendido; pago, rechazo, cancelación, duplicado). |

**Propuesta (Q1):** aprobar 046 como **conector de plataforma opcional** y registrarlo en la constitución como enmienda menor 1.5.0 («billing de la plataforma entra solo como conector opcional del operador; nunca como dependencia del núcleo ni de las instalaciones de un solo negocio»).

## Cómo está hoy (leído del código)

- `subscription`: única por organización; `status` ∈ `trialing|active|past_due|canceled|paused`; `current_period_start/end`, `cancel_at_period_end`, `trial_started_at`, `converted_at`, `status_reason`, `status_changed_at`. **Ninguna columna** vincula con una pasarela.
- `subscription_event`: append-only; `source` ya admite `payment`; tipos `trial_started|converted|reactivated|plan_changed|status_changed|trial_extended|period_changed|expired|assigned`. **Faltan** tipos para cobro renovado y cobro fallido.
- `plan`: `price_monthly_cents` (entero, céntimos), `currency` (default `PEN`), `trial_days` (con valor = prueba, null = pago), `active`. Los tres planes de pago ya están sembrados.
- Puerta única (`src/server/saas/subscription.ts`): `applySubscriptionAction` (acciones manuales: candado `FOR UPDATE` sobre la fila de la organización, hora tomada después del candado, evento + auditoría en la misma transacción), `startTrial`, `expireTrials`, `reassignTrialPlan`. La regla `activate` ya marca `converted` cuando viene de una prueba y `convertedAt` es null. **Manual y automático deben producir el mismo evento**; solo cambia `source` (`admin` vs `payment`).
- `PAID_PERIOD_DAYS = 30` y `mrrOf` (MRR = solo `active` con plan de pago, en una sola moneda) ya existen.
- Enforcement (`SAAS_ENFORCE`): `past_due`, `paused`, `canceled` y prueba vencida bloquean; `/suscripcion-inactiva` hoy dice «contacta a quien administra la plataforma». Las rutas `/api/account/**` y los webhooks quedan fuera del corte; **`/api/billing/**` debe quedar fuera también**, o el que más necesita pagar no podría.
- Webhooks existentes (`/api/webhooks/{wa,ig,messenger,tiktok}/[webhookToken]`): dedup por id del mensaje con UNIQUE. No hay una tabla genérica de entradas de webhook.
- Ajustes: `src/components/settings/settings-nav.tsx` (secciones Canales, Agente, Negocio). Roles por organización en `member.role` (`requireSession` devuelve `role`).
- Mocks de entorno: `src/app/api/dev/{wa-mock,ai-mock,google-mock,zoom-mock,zernio-mock}` con el gate único `mockGuard()`. Se añade `mp-mock` con el mismo patrón.

## Qué trae Mercado Pago (API de Suscripciones — «preapproval») y qué asumimos

> **Aviso de honestidad.** Lo que sigue es mi conocimiento de la API, **sin haberlo contrastado todavía con la cuenta real ni con el sandbox**. Los puntos marcados ⚠ deben verificarse con credenciales de prueba antes de dar la feature por hecha (Q10). El mock se construye sobre estas suposiciones; un mock verde no prueba la API real.

- **Crear suscripción:** `POST /preapproval` con `reason` (nombre visible), `external_reference`, `payer_email`, `back_url`, `status: "pending"` y `auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount, currency_id: "PEN" }`. Sin `card_token_id` devuelve `init_point` (URL de Mercado Pago donde el cliente paga) y la suscripción queda `pending` hasta que el cliente la autoriza. Cabecera `X-Idempotency-Key` para no duplicar. ⚠ Que Perú (`PEN`) admita suscripciones sin plan asociado.
- **Consultar / cambiar:** `GET /preapproval/{id}`; `PUT /preapproval/{id}` con `status` (`authorized`, `paused`, `cancelled`) o `auto_recurring.transaction_amount` (cambia el monto **de los próximos cobros**). ⚠ Que el cambio de monto se acepte en una suscripción autorizada en Perú. Una suscripción `cancelled` **no se puede reactivar**: hay que crear otra.
- **Cobros:** cada mes Mercado Pago genera un «pago autorizado» (`GET /authorized_payments/{id}`: `preapproval_id`, `status`, `transaction_amount`, `debit_date`, `retry_attempt`, y el `payment` con su `id` y `status`). Los rechazos se **reintentan** automáticamente unos días. ⚠ Calendario y número de reintentos, y qué estado queda al agotarlos (creo que `cancelled`).
- **Notificaciones (webhook):** tipos `subscription_preapproval` (cambió la suscripción), `subscription_authorized_payment` (un cobro mensual) y `payment`. El cuerpo es solo un aviso (`{ id, type, action, data: { id }, live_mode }`): **no trae el estado confiable**.
- **Firma:** cabeceras `x-signature: ts=<epoch>,v1=<hex>` y `x-request-id`. El `v1` es `HMAC-SHA256(secreto, "id:<data.id>;request-id:<x-request-id>;ts:<ts>;")` donde `data.id` sale del query string (en minúsculas si es alfanumérico). ⚠ Formato exacto del manifiesto con cada tipo de tópico.
- **Moneda:** Mercado Pago cobra en la moneda del país de la cuenta. Un solo `currency_id` por cuenta.

### Principio de seguridad central: el webhook es un timbre, no una fuente

Aunque la firma sea válida, **nunca se confía en el cuerpo**: cada notificación se resuelve con un `GET` al recurso usando `MP_ACCESS_TOKEN`, y se actúa sobre lo que Mercado Pago responde. Así un cuerpo falsificado, repetido o fuera de orden no puede cambiar el estado: lo peor que hace es provocar una consulta. La firma es la primera defensa (descarta ruido y abuso); el `GET` es la que decide.

## Modelo de datos (migración 0081)

### `subscription` — columnas nuevas (las escribe SOLO la puerta)

| Columna | Tipo | Para qué |
|---|---|---|
| `billing_provider` | text null (`mercadopago`) | null = cobro manual (como en 045). |
| `mp_preapproval_id` | text null, **único parcial** (`where not null`) | Vínculo con la suscripción de MP. Un id de MP no puede colgar de dos organizaciones. |
| `mp_payer_id` | text null | Pagador en MP (para soporte). |
| `mp_status` | text null | Último estado visto en MP (`pending|authorized|paused|cancelled`), solo informativo. |
| `billed_amount_cents` | integer null | Monto mensual **realmente acordado** con MP (snapshot al contratar o cambiar de plan). El MRR de una suscripción de MP usa este monto; si cambia el precio del plan después, el cliente conserva el suyo (Q8). |
| `billed_currency` | text null | Moneda del monto anterior. |
| `pending_plan_id` | text null → `plan.id` | Cambio a un plan más barato programado para el próximo corte (Q4). |
| `last_payment_at` | timestamp null | Último cobro aprobado. |
| `next_payment_at` | timestamp null | Próximo cobro según MP (informativo). |

### Tablas nuevas (las escribe SOLO `src/server/billing/`)

**`billing_checkout`** (prefijo `bck`): cada intento de contratar. `organization_id`, `plan_id`, `created_by_user_id`, `status` (`pending|authorized|paid|failed|abandoned|replaced`), `mp_preapproval_id` (único parcial), `amount_cents`, `currency`, `payer_email`, `created_at`, `expires_at` (24 h), `completed_at`. Es lo que se mapea desde `external_reference` (Q3). Índice por `(organization_id, created_at desc)`.

**`billing_payment`** (prefijo `bpy`): un cobro. `organization_id`, `subscription_id`, `plan_id` y `plan_name` (snapshot), `mp_preapproval_id`, `mp_authorized_payment_id` (**UNIQUE**, la clave de idempotencia del cobro), `mp_payment_id` (último intento), `status` (`pending|rejected|approved|refunded|charged_back|cancelled`), `status_detail` (motivo de MP: `cc_rejected_insufficient_amount`…), `amount_cents`, `currency`, `retry_attempt`, `debit_date`, `paid_at`, `applied_at` (cuándo la puerta lo aplicó a la suscripción; null = aún no), `needs_review` boolean (contracargo/reembolso), `created_at`, `updated_at`. Estado **monótono**: `pending → rejected → approved → refunded|charged_back`; un `rejected` tardío no pisa un `approved`. Índice `(organization_id, created_at desc)`.

**`billing_webhook_event`** (prefijo `bwh`): la bandeja de entrada y la idempotencia. `request_id` (cabecera `x-request-id`, **UNIQUE**), `topic`, `resource_id` (`data.id`), `action`, `live_mode`, `status` (`received|processed|ignored|orphan|failed`), `organization_id` (cuando se resolvió), `attempts`, `error`, `received_at`, `processed_at`. Sirve para: (a) responder 200 enseguida a un reenvío ya procesado; (b) reprocesar los `failed`/`orphan`; (c) saber qué llegó cuando algo no cuadra. Se poda a 60 días.

### `subscription_event`

- `source = payment` ya existe. Se añaden los tipos **`renewed`** (cobro mensual aprobado de una suscripción ya activa), **`payment_failed`** (cobro rechazado) y **`refunded`** (reembolso o contracargo, solo informativo). Es texto en TypeScript, **no cambia el esquema** pero sí `SubEventType`, las etiquetas del cajón y las métricas.
- Columna nueva `provider_ref` (text null): el id del cobro de MP que originó el evento, para cruzar historia y cobros.
- **Conversión.** El primer cobro aprobado de una organización en prueba produce `converted` con `source = payment` y escribe `subscription.converted_at`. El dashboard pasa a mostrar «convirtieron» desglosado en **Mercado Pago** y **manual** (Q7 de 045 los contaba juntos con marca `admin`; aquí la marca se vuelve visible).

### Moneda local y sincronía de precios

- Moneda: `plan.currency` (`PEN`). Mercado Pago recibe `currency_id = plan.currency` y el monto como **decimal** (`cents / 100` con dos decimales; función pura `centsToMpAmount`, probada con redondeos). Si `plan.currency` ≠ moneda de la cuenta de MP, MP rechaza: lo capturamos como `currency_mismatch` (422) con mensaje para el operador, sin dejar un checkout colgado.
- Sincronía: **la tabla `plan` es la fuente del precio al momento de contratar**. Se congela en `billed_amount_cents`. Cambiar el precio de un plan **no** reajusta suscripciones vigentes (se respeta el precio pactado). Un reajuste masivo es un trabajo del operador fuera de alcance (ver «Fuera de alcance»).
- Un plan sin precio (`price_monthly_cents = 0`) o con `trial_days` no se puede contratar: 422 `plan_not_billable`.

## Flujos

### F1 · Contratar un plan (dueño de la organización)

1. En `/suscripcion-inactiva` (bloqueada) o en **Ajustes → Suscripción** (`/ajustes/suscripcion`, nueva), el dueño ve los planes de pago (nombre, precio `S/ 149,00/mes`, módulos) y pulsa **Pagar con Mercado Pago**.
2. `POST /api/billing/checkout { planId }`:
   - `withAuth(..., { allowInactive: true })` y solo rol **dueño** (Q7); Origin same-site, límite 5 por minuto por organización.
   - Valida: bandera encendida, plan activo y facturable, no hay ya una suscripción de MP `authorized` (si la hay, 409 `already_subscribed`: se usa cambio de plan), y la moneda.
   - Inserta `billing_checkout` (`pending`) y marca `replaced` cualquier checkout `pending` anterior de la organización.
   - Llama a `POST /preapproval` con `X-Idempotency-Key = bck_…`, `external_reference = bck_…` (Q3), `payer_email` = correo del dueño, `reason = "Vocero · Plan Pro"`, `back_url = {APP_BASE_URL}/ajustes/suscripcion?checkout=bck_…`.
   - Guarda `mp_preapproval_id` en el checkout y responde `{ url: init_point }`.
   - El cliente redirige **solo si el host de `url` está en la lista permitida** (`*.mercadopago.com`, `*.mercadopago.com.pe`; el mock de pruebas añade el suyo). Nunca se redirige a una URL arbitraria.
3. El cliente paga en Mercado Pago y vuelve a `back_url`. La pantalla muestra «Confirmando tu pago…» y pide `GET /api/billing/checkout/{id}` (propio de la organización, 404 si no).
4. **Pull al volver.** Ese `GET` hace una **sincronización activa** (`syncCheckout`): consulta `GET /preapproval/{id}` y `GET /authorized_payments?preapproval_id=…` y aplica lo que encuentre por la misma puerta. Así el flujo funciona **aunque el webhook se retrase o en desarrollo no esté configurado**. El webhook y el pull convergen por idempotencia (nunca se aplica dos veces).
5. Cuando el primer cobro queda **aprobado**: la puerta pasa a `active` (ver `decidePayment`), el checkout a `paid`, y la pantalla muestra «Plan Pro activo hasta …» y libera el acceso. Si el cobro es **rechazado**: la organización sigue como estaba (prueba/`past_due`), el checkout pasa a `failed` con el motivo en español («La tarjeta fue rechazada: fondos insuficientes») y puede reintentar. Si el cliente **abandonó**: el checkout vence a las 24 h (`abandoned`) por el temporizador.

### F2 · Cambio de plan (con suscripción de MP autorizada)

`POST /api/billing/change-plan { planId }` (dueño). Política propuesta (Q4), **sin prorrateo**:
- **Subir** (precio mayor): el plan cambia **ya** (`plan_changed`, `source = payment`… ver nota), se actualiza `transaction_amount` en MP (`PUT`) y el nuevo precio rige **desde el próximo cobro**. `billed_amount_cents` se actualiza.
- **Bajar** (precio menor): se actualiza el monto en MP ya (rige en el próximo cobro) y el cambio de plan queda **programado** (`pending_plan_id`) para el próximo corte; mientras tanto conserva lo pagado. La puerta lo aplica al aprobar el siguiente cobro.
- Orden de operaciones: **primero MP, luego la puerta.** Si el `PUT` falla, nada cambia localmente y se responde 502 `provider_unavailable`. Si el `PUT` sale bien y la escritura local falla, la sincronización del webhook/temporizador converge (el monto ya está en MP y `reconcile` compara plan local vs monto de MP).
- Nota: el evento de cambio iniciado por el cliente lleva `source = payment`; el actor es el usuario que lo pidió.

### F3 · Cancelar (cliente)

`POST /api/billing/cancel` (dueño): `PUT /preapproval` `status: cancelled` (no se cobra más) y localmente `cancel_at_period_end = true`, `status_reason = customer_cancelled`. **Conserva el acceso hasta el fin del periodo ya pagado** (Q5). Al llegar `current_period_end`, el temporizador pasa a `canceled` (hoy el barrido solo atiende pruebas: se extiende con `closeCancelledPeriods`). Reactivar antes del corte no se puede con la misma suscripción de MP (cancelada es terminal): se crea un checkout nuevo; si todavía hay periodo pagado, el nuevo cobro **empieza al fin de ese periodo** (`start_date` = `current_period_end`) para no cobrar dos veces el mismo mes.

### F4 · Super Admin sobre una suscripción gestionada por MP

Matriz (Q9). El principio: **el panel nunca deja la pasarela y el CRM en desacuerdo**.

| Acción manual | Suscripción cobrada por MP | Resultado |
|---|---|---|
| Suspender | permitida | `PUT paused` en MP **y** `paused` local, en ese orden; si MP falla, 502 y no cambia nada. |
| Cancelar | permitida | `PUT cancelled` en MP y local. |
| Reactivar (tras suspender) | permitida | `PUT authorized` en MP y local. Tras cancelar: 409 `needs_new_checkout` (el cliente debe contratar de nuevo). |
| Cambiar plan | permitida | Igual que F2 (monto en MP). |
| Activar / Asignar | **409 `managed_by_provider`** si ya está `active` con MP; permitida si no tiene suscripción de MP vigente | Evita doble cobro y estados contradictorios. |
| Extender prueba / fijar corte | permitidas | Soporte; el corte manual se muestra como «ajustado manualmente» y puede divergir de MP (se avisa en el cajón). |

Si la organización no usa MP (`billing_provider` null) todo funciona **exactamente como en 045**.

### F5 · Cobro mensual automático (lo mueve Mercado Pago)

MP cobra → manda webhook → se resuelve el cobro → `applyPaymentEvent` → la suscripción se renueva sin intervención humana y el MRR/conversión se actualizan al instante porque son lecturas de la misma historia.

## Webhook `POST /api/webhooks/mercadopago`

Orden estricto (cada paso corta si falla):

1. **Bandera apagada → 404** (indistinguible de una ruta inexistente).
2. **Firma.** Lee `x-signature` y `x-request-id`, extrae `ts` y `v1`, reconstruye el manifiesto con `data.id` del query y compara con `crypto.timingSafeEqual` (longitudes iguales primero). Sin secreto configurado: 503 y log (nunca se acepta sin verificar). Firma inválida o ausente → **401**, no se escribe nada en `billing_webhook_event` (para que un atacante no llene la tabla; solo un contador en memoria con límite de log).
3. **Antigüedad.** No se rechaza por `ts` viejo (los reintentos de MP llegan con la firma original); la protección contra repetición es la idempotencia y el `GET` de verdad.
4. **Entrada.** `INSERT … ON CONFLICT (request_id) DO NOTHING` en `billing_webhook_event`. Si ya existía y está `processed|ignored` → **200 inmediato** (duplicado). Si existía `failed|orphan|received` (un intento anterior no terminó) → se reprocesa.
5. **Resolver.** Según `type`: `subscription_preapproval` → `GET /preapproval/{id}`; `subscription_authorized_payment` → `GET /authorized_payments/{id}`; `payment` → `GET /v1/payments/{id}` y, si trae `metadata`/`preapproval_id`, se trata como cobro de suscripción (si no es nuestro, `ignored`). Tópicos desconocidos → `ignored`, 200.
6. **Ubicar la organización.** Por `mp_preapproval_id` en `subscription`; si no está aún, por `external_reference` → `billing_checkout`. Si no se encuentra: `orphan` + 200 (el temporizador lo reintenta durante 24 h; avisa en logs si pasa).
7. **Aplicar** por `applyPaymentEvent` (puerta). Errores transitorios (BD, MP caído) → **500** para que MP reintente; el estado de la fila queda `failed` con el error.
8. Responde **200 en menos de 22 s** (límite de MP): las consultas a MP llevan tiempo máximo de 8 s y un reintento.
9. `live_mode = false` con un token de producción (o al revés) → `ignored` con motivo `mode_mismatch`.

### Idempotencia en tres capas

1. **Bandeja** por `x-request-id` (reenvío idéntico no se vuelve a procesar).
2. **Cobro** por `mp_authorized_payment_id` UNIQUE + estado monótono: un cobro tiene una sola fila y solo avanza.
3. **Aplicación** por `billing_payment.applied_at` **bajo el candado de la organización**: dos notificaciones simultáneas del mismo cobro se serializan y la segunda ve `applied_at` y no hace nada (devuelve `duplicate`). Es la que protege cuando el webhook y el «pull al volver» llegan a la vez.

## Regla pura `decidePayment` (en `src/lib/saas.ts`, testeable sin base)

Entrada: suscripción actual (`status`, `currentPeriodEnd`, `cancelAtPeriodEnd`, `convertedAt`, `statusReason`, plan actual, `pendingPlanId`), evento de pago y `now`. Salida: nuevo estado, periodos, tipo de evento, `isConversion`, o `noop`.

| Evento (ya resuelto contra MP) | Desde | Resultado |
|---|---|---|
| Cobro **aprobado**, plan nuevo/primero | `trialing` / `past_due` (incl. `trial_ended`) | `active`, plan del checkout, periodo `now → now+30 d`, evento **`converted`** si no tenía `converted_at` (conversión), `reactivated` si ya había convertido; `status_reason = paid`. |
| Cobro **aprobado**, renovación | `active` | `active`; el fin se extiende **30 días desde el fin vigente** si aún no venció (un pago adelantado no pierde días) o desde `now` si ya venció; evento **`renewed`**; aplica `pending_plan_id` si lo hay (evento `plan_changed` incluido). |
| Cobro aprobado | `paused` / `canceled` | `active` + `reactivated`. (Caso raro: se pagó mientras estaba suspendida; MP manda, pero queda marcado `needs_review`.) |
| Cobro **rechazado** (reintento pendiente) | `active` | `past_due`, `status_reason = payment_failed`, evento **`payment_failed`**; el periodo vigente se respeta (ver gracia, Q6). |
| Cobro rechazado | `trialing` (primer cobro) | **Sin cambio de estado** (sigue en prueba/vencida); solo `billing_payment` y checkout `failed`. |
| Cobro rechazado de nuevo | `past_due` por `payment_failed` | `noop` (ya está así; se actualiza el cobro). |
| Suscripción **autorizada** (solo `authorized`, aún sin cobro) | cualquiera | **No activa** (Q2): guarda `mp_preapproval_id`, `mp_status = authorized`, checkout `authorized`. La activación espera al cobro aprobado. |
| Suscripción **cancelada** por MP/cliente en MP | `active` con periodo vigente | `cancel_at_period_end = true`, `status_reason = mp_cancelled`; sigue activa hasta el corte. |
| Suscripción cancelada | `past_due` por `payment_failed` (MP agotó reintentos) | `canceled`, `status_reason = payment_failed`, evento `status_changed`. |
| Suscripción **pausada** | `active` | `paused`, `status_reason = mp_paused`. |
| **Reembolso / contracargo** | cualquiera | Sin cambio de estado: evento `refunded` informativo y `billing_payment.needs_review = true` (Q11). |
| Cualquier evento atrasado cuyo estado ya está superado (p. ej. `rejected` después de `approved`) | cualquiera | `noop`. |

`availableActions` (045) se ajusta para ocultar las que devolverían 409 `managed_by_provider`.

## Cambios de código por archivo (plan)

**Puros (`src/lib/`)**
- `src/lib/saas.ts` — `decidePayment`, nuevos `SubEventType` (`renewed`, `payment_failed`, `refunded`), etiquetas, `availableActions` con `billingProvider`; `computeMetrics` desglosa conversión por origen (`payment` / `admin`) y el MRR usa `billedAmountCents` cuando existe.
- `src/lib/billing.ts` — Zod de `checkout`/`change-plan`/`cancel`; `centsToMpAmount`/`mpAmountToCents`; `buildSignatureManifest` y `verifyMpSignature`; mapeo de estados de MP a nuestros eventos (`mapPreapprovalStatus`, `mapPaymentStatus`); lista permitida de hosts de redirección (`isAllowedCheckoutUrl`); mensajes en español para `status_detail`.
- `src/lib/mercadopago/client.ts` — el **único** cliente HTTP: `createPreapproval`, `getPreapproval`, `updatePreapproval`, `getAuthorizedPayment`, `searchAuthorizedPayments`, `getPayment`. Base `MP_API_BASE`, `Authorization: Bearer`, tiempo máximo 8 s, `X-Idempotency-Key`, errores clasificados (`MpApiError`: `auth` 401/403, `rate_limited` 429 con backoff, `transient` 5xx/timeout reintentable, `invalid` 4xx con causa). El token jamás aparece en mensajes de error ni logs.

**Servidor**
- `src/server/saas/subscription.ts` (la puerta) — `applyPaymentEvent` (candado, `decidePayment`, escribe suscripción + evento + `billing_payment.applied_at` en la misma transacción), `linkProvider` (escribe `mp_*`, `billed_*`, `pending_plan_id`), `closeCancelledPeriods` (lo llama el barrido horario junto a `expireTrials`). La prueba de vigilancia sigue exigiendo que **nadie más** escriba `subscription` ni `subscription_event`.
- `src/server/billing/checkout.ts` (crear, listar, `syncCheckout`), `webhook.ts` (`handleMpNotification`), `plan-change.ts`, `cancel.ts`, `reconcile.ts` (repasa huérfanos y suscripciones de MP sin noticias hace más de 36 h; compara contra `GET /preapproval`), `queries.ts` (historial de cobros para pantalla y panel). Las escribe solo este directorio (guardián).
- `src/server/saas/subscription-sweeper.ts` — el tick horario añade `closeCancelledPeriods`, `reconcileBilling` y poda de `billing_webhook_event` (60 d). Con la bandera apagada solo corre lo que ya corría.
- `src/server/saas/enforcement.ts` — gracia de cobro fallido (Q6): un `past_due` con motivo `payment_failed` **no bloquea** mientras `now ≤ current_period_end + PAYMENT_GRACE_DAYS`; muestra aviso. Rutas `/api/billing/**` fuera del corte (`withAuth` con `allowInactive`).
- `src/server/super-admin/directory.ts` — expone `billingProvider`, `mpStatus`, `lastPaymentAt`, `nextPaymentAt`, `pendingPlanName` y el historial de cobros del cajón (solo metadatos: monto, estado, motivo; **nunca** datos de tarjeta, que no pasan por nuestros servidores).

**Rutas**
- `src/app/api/webhooks/mercadopago/route.ts` — el webhook.
- `src/app/api/billing/{plans,status,checkout,checkout/[id],change-plan,cancel,payments}/route.ts` — del dueño; todas `404` con la bandera apagada.
- Super Admin: `src/app/api/super-admin/organizations/[id]/subscription/route.ts` se extiende para propagar a MP según la matriz F4; `…/organizations/[id]` suma los cobros.
- `src/app/api/dev/mp-mock/**` — mock de la API y del checkout alojado, con `mockGuard()`.

**UI**
- `src/app/(app)/ajustes/suscripcion/page.tsx` y `src/components/billing/` (`plan-cards`, `subscription-status-card`, `payments-table` con `useDataTable`, `cancel-dialog`, `change-plan-dialog`, `checkout-return`): la pantalla de suscripción; `SearchSelect` para el plan, X en cada ventana, sin DatePicker nuevo (no hay fechas editables). Se añade «Suscripción» a la sección Negocio de `settings-nav.tsx` solo con la bandera encendida.
- `src/app/suscripcion-inactiva/page.tsx` — con la bandera encendida muestra los planes y **Pagar con Mercado Pago** en lugar de «contacta al administrador» (apagada: el texto de hoy). Solo el dueño ve el botón; otros roles ven «pide al dueño de la cuenta».
- `src/components/avisos/aviso-suscripcion.tsx` — avisos de cobro fallido («No pudimos cobrar tu plan. Actualiza tu medio de pago antes del 12/12») y de «se cancela al corte», con enlace a la pantalla.
- Super Admin: columna/etiqueta «Cobro: Mercado Pago» o «Manual», próximo cobro, y cobros en el cajón (`organization-drawer.tsx`); tarjeta de conversión con el desglose por origen (`conversion-card.tsx`).

**Configuración**
- `src/lib/env.ts` y `.env.example`: variables de abajo; `src/server/billing/flag.ts` (`billingEnabled()` = bandera **y** token, igual que `enforcementEnabled`).
- `package.json`: `test:e2e:mercadopago`.
- Docs: `docs/mercadopago.md` (alta de la aplicación en MP, URL del webhook, secreto, tarjetas de prueba, puesta en marcha), `CLAUDE.md` (fila del mapa), `AGENTS.md`, `CHANGELOG.md`, `docs/super-admin.md` (acciones sobre suscripciones de MP) y la enmienda de constitución si se aprueba Q1.

## Variables de entorno

Siguiendo la regla de credenciales: se agregan a `.env` como placeholders `REEMPLAZA_...` con guía inline, y se resumen en el chat.

| Variable | Secreta | Descripción |
|---|---|---|
| `MERCADOPAGO` | no | Bandera `on`/`off`. Apagada por defecto. |
| `MP_ACCESS_TOKEN` | **sí** | Credencial de producción (o de prueba) de la aplicación de Mercado Pago. Solo servidor. |
| `MP_WEBHOOK_SECRET` | **sí** | «Clave secreta» de la sección Webhooks de la aplicación; firma las notificaciones. |
| `MP_API_BASE` | no | Por defecto `https://api.mercadopago.com`; los E2E la apuntan al mock. |
| `MP_PUBLIC_KEY` | no | **No se usa en este paso** (la clave pública es para tokenizar tarjetas en el navegador con Bricks; el flujo con redirección no la necesita). Se documenta como futura y no se valida. |
| `PAYMENT_GRACE_DAYS` | no | Días de gracia tras un cobro rechazado antes de bloquear (por defecto 5, Q6). |

`pnpm doctor` valida: con `MERCADOPAGO=on` exige token y secreto, y hace una llamada de prueba de solo lectura (`GET /users/me`) sin imprimir el token. Con la bandera apagada no toca nada.

## Seguridad (resumen)

- Token y secreto solo en servidor; el cliente nunca los ve ni aparecen en errores, logs o respuestas (prueba de vigilancia que escanea `src/components/` y `src/app/**/page.tsx`).
- Firma HMAC con comparación de tiempo constante; sin secreto no se acepta nada.
- El webhook **solo consulta** y actúa sobre lo que MP responde con nuestro token.
- `external_reference` es un identificador opaco (`bck_…`) validado contra la base; el monto y el pagador del recurso consultado deben coincidir con el checkout (monto, moneda): si difiere, el evento se marca `needs_review` y **no activa**.
- Redirección solo a hosts de Mercado Pago (o del mock en pruebas).
- Mutaciones: Origin same-site, límite de tasa, rol dueño; el panel de Super Admin conserva 2FA, auditoría y motivo obligatorio.
- Sin datos de tarjeta en nuestra base (el cobro ocurre en la página de MP).
- Aislamiento: ninguna ruta de `/api/billing/*` acepta `organizationId` del cliente; siempre sale de la sesión.

## Plan de pruebas

**Unitarias** (`tests/unit/`)
- `billing.test.ts`: manifiesto de firma y `verifyMpSignature` (válida; secreto distinto; `ts` alterado; falta `v1`/`ts`/`x-request-id`; `data.id` en mayúsculas del query; longitudes distintas sin lanzar; comparación en tiempo constante); `centsToMpAmount` y `mpAmountToCents` (7900→`79.00`, 14950, redondeo, ida y vuelta); mapeos de estado de MP; `isAllowedCheckoutUrl` (hosts válidos, `evil.com`, subdominio engañoso `mercadopago.com.evil.com`, `javascript:`, http); mensajes de rechazo; Zod de los cuerpos.
- `saas.test.ts` (ampliada): **`decidePayment`** cubre toda la tabla (cada evento × cada estado de origen), incluido renovar sin perder días pagados, pago tardío sobre `canceled`, rechazado sobre `trialing`, evento atrasado = `noop`, aplicar `pending_plan_id`, conversión una sola vez; `availableActions` con `billingProvider`; `computeMetrics` desglosa conversión por origen y usa `billedAmountCents`.
- `mercadopago-client.test.ts`: clasificación de errores (401, 429 con backoff, 5xx, timeout), reintento acotado, el token no aparece en `message`/`cause`, `X-Idempotency-Key` enviada.
- `billing-guard.test.ts` (vigilancia): solo `src/server/saas/subscription.ts` escribe `mp_*`/`billed_*`/`pending_plan_id` en `subscription`; las tablas `billing_*` solo se escriben desde `src/server/billing/`; nadie fuera de `src/lib/mercadopago/` y `src/server/billing/` habla con `api.mercadopago.com`; `MP_ACCESS_TOKEN` y `MP_WEBHOOK_SECRET` no se leen fuera de `env.ts`/cliente/webhook y no aparecen en componentes de cliente; el webhook verifica la firma **antes** de tocar la base; las rutas `/api/billing/*` usan `withAuth` con rol de dueño y responden 404 apagadas; `regla-paginacion.test.ts` incluye las tablas nuevas.

**Contra Postgres real** (`tests/unit/billing-live.test.ts`, `RUN_DB_TESTS=1`)
1. La migración 0081 (columnas, tres tablas, índices únicos parciales, `ON CONFLICT`).
2. Checkout: crea la fila, reemplaza el pendiente anterior, `mp_preapproval_id` único parcial.
3. **Primer cobro aprobado** desde Demo: `trialing → active`, `converted` con `source = payment`, `converted_at`, periodo de 30 días, `billing_payment.applied_at`; `loadMetrics` sube conversión y MRR.
4. **Webhook duplicado** (mismo `x-request-id`) → una sola fila de cobro y un solo evento. **Dos notificaciones concurrentes del mismo cobro** (`Promise.all`) → una sola aplicación.
5. **Renovación**: `renewed` y el fin se extiende desde el fin vigente; pago adelantado no pierde días.
6. **Rechazo**: `active → past_due/payment_failed` y `payment_failed`; **reintento aprobado** → `reactivated`; rechazo sobre `trialing` no cambia el estado.
7. **Cancelación** del cliente: `cancel_at_period_end`, sigue activa; `closeCancelledPeriods` la pasa a `canceled` en el corte (y no antes).
8. **Cambio de plan**: subir (inmediato, `billed_amount_cents` actualizado) y bajar (`pending_plan_id`, se aplica en el siguiente cobro aprobado).
9. **Orden invertido**: cobro antes que la suscripción conocida → `orphan`, y `reconcile` lo resuelve; `rejected` tardío tras `approved` = `noop`.
10. Monto o moneda que no coinciden con el checkout → `needs_review`, no activa.
11. Contracargo: `needs_review` y evento `refunded`, sin cambiar el estado.
12. Coexistencia con el panel: `activate` sobre suscripción de MP `active` → 409 `managed_by_provider`; suspender sin conexión a MP (mock caído) → 502 y **nada cambia**.
13. Enforcement: con `SAAS_ENFORCE` y gracia, `past_due/payment_failed` no bloquea dentro de la gracia y sí al pasarla; el caché de acceso se invalida al aplicar un pago.
14. Bandeja `billing_webhook_event`: `failed` se reprocesa; poda de 60 días.

**E2E de punta a punta** (`pnpm test:e2e:mercadopago`, `scripts/e2e-mercadopago.mjs`)
Con la app viva y `WA_MOCK_ENABLED=true`, `MERCADOPAGO=on`, `MP_API_BASE` → `mp-mock`, `MP_WEBHOOK_SECRET` de prueba, `SAAS_ENFORCE=true`. El `mp-mock` expone la API (`/preapproval`, `/authorized_payments`, `/v1/payments`), una **página de pago alojada** (el `init_point`, con botones «Pagar», «Tarjeta rechazada», «Cancelar») y un endpoint de control para disparar eventos (cobro mensual, rechazo, cancelación desde MP, **reenvío duplicado**), firmando cada webhook con el secreto como lo haría MP y enviándolo a nuestra ruta.
1. **Pago exitoso**: dueño con prueba vencida → `/suscripcion-inactiva` → elige Pro → «Pagar con Mercado Pago» → página de pago del mock → aprobar → vuelve → «Confirmando…» → «Plan Pro activo» → entra a la app. El panel de Super Admin muestra +1 conversión (origen Mercado Pago) y MRR +S/ 149,00; la historia de la organización lista `converted` y el cobro.
2. **Rechazo de tarjeta**: sigue bloqueado, ve el motivo en español, reintenta y esta vez paga.
3. **Cobro mensual**: el control dispara el siguiente cobro → `renewed`, fin +30 días.
4. **Cobro mensual rechazado**: `past_due` con aviso dentro de la gracia (la app sigue usable), y bloqueo al vencer la gracia.
5. **Cancelación** desde el cliente: «se cancela al corte», el mock muestra la suscripción `cancelled`, el acceso sigue; al forzar el corte se bloquea.
6. **Cancelación desde el lado de MP** (control): la app lo refleja sin acción del usuario.
7. **Webhook duplicado**: el mismo POST dos veces → una fila de cobro, un evento.
8. **Firma inválida / ausente** → 401 y estado intacto. Sin secreto configurado → 503.
9. **Cambio de plan** Pro → Emprendedor (programado) y Emprendedor → Enterprise (inmediato).
10. **Super Admin** suspende una organización cobrada por MP → el mock queda `paused`; con el mock apagado, 502 y sin cambios.
11. **Bandera apagada**: `/api/billing/*` y el webhook 404, `/suscripcion-inactiva` con el texto manual de 045, y todo el flujo manual del panel intacto.
12. Camino infeliz: el mock responde 500/timeout al crear el checkout → mensaje «Mercado Pago no responde, intenta en unos minutos», sin checkout colgado y sin bloquear la app.

**Verificación real (no automatizable por mí sin credenciales, Q10):** lista de comprobación en `docs/mercadopago.md` para ejecutar con credenciales y usuarios de prueba de Mercado Pago Perú antes de pasar a producción: crear suscripción en PEN, pagar con tarjeta de prueba aprobada y rechazada, cancelar, cambiar monto, ver la firma real y el calendario de reintentos. Los puntos ⚠ de arriba se confirman o corrigen ahí.

## Orden de implementación

1. Migración 0081 + esquema + `ids.ts` (`bck`, `bpy`, `bwh`).
2. Puros: `billing.ts`, `decidePayment`, métricas por origen; sus pruebas unitarias.
3. Cliente `mercadopago/client.ts` + `mp-mock`; sus pruebas.
4. Puerta: `applyPaymentEvent`, `linkProvider`, `closeCancelledPeriods`; pruebas en vivo 1–14.
5. `src/server/billing/` + webhook + rutas `/api/billing/*`.
6. UI del cliente y de `/suscripcion-inactiva`; Super Admin.
7. Enforcement con gracia; avisos.
8. Docs, `.env.example`, `doctor`, mapa; E2E; verificación (typecheck, lint, build, unitarias, `test:db`, E2E).

## Fuera de alcance (a propósito)

- **Comprobantes electrónicos (boleta/factura SUNAT).** En Perú es una obligación fiscal del operador, pero es un servicio de terceros distinto; se trata aparte.
- Medios de pago no recurrentes (Yape, PagoEfectivo, transferencias): no sirven para cobro automático mensual.
- Planes anuales, cupones, periodos de gracia comerciales, prorrateo, reajuste masivo de precios.
- Reembolsos y devoluciones desde el panel (se hacen en Mercado Pago; aquí solo se ven).
- Correos de cobranza (la constitución prohíbe el email como dependencia): los avisos son dentro de la app.
- Aplicar los límites `maxStaff` / `maxMonthlyAiTurns`, y pausar el agente por falta de pago (sigue como en 045).
- Tokenizar tarjetas en el navegador (Bricks) y `MP_PUBLIC_KEY`.
- Más de una pasarela o más de una moneda por instancia.

## Preguntas de decisión (con mi recomendación)

1. **Constitución.** ¿Apruebas entrar como **conector opcional de plataforma** (bandera `MERCADOPAGO`, apagado por defecto, credenciales del operador) y registrar una enmienda menor 1.5.0? *Recomiendo sí; sin enmienda, 046 contradice la letra del Principio II.*
2. **Cuándo se activa.** ¿La suscripción pasa a `active` solo con el **primer cobro aprobado** (no al autorizarse)? *Recomiendo sí: «autorizada» no es «pagada»; evita dar el plan a quien autorizó y luego falla la tarjeta.*
3. **`external_reference`.** ¿Un id opaco del checkout (`bck_…`, con organización y plan en la base) o `organizationId:planId` como pides? *Recomiendo el id opaco: no se puede forjar ni cambiar el plan editando el texto, y se valida contra la fila. Organización y plan quedan igualmente vinculados.*
4. **Cambio de plan.** ¿Subir = inmediato y nuevo precio desde el próximo cobro; bajar = al próximo corte; **sin prorrateo**? *Recomiendo sí. El prorrateo exige cobros sueltos y complica mucho.*
5. **Cancelación del cliente.** ¿Conserva el acceso hasta el fin del periodo pagado y no hay reembolso automático? *Recomiendo sí.*
6. **Cobro fallido.** ¿**5 días de gracia** (aviso en la app, sin bloqueo) antes de aplicar el corte, configurable con `PAYMENT_GRACE_DAYS`? *Recomiendo sí: un rechazo de tarjeta suele ser transitorio y MP reintenta.*
7. **Quién paga.** ¿Solo el **dueño** de la organización (no administradores ni agentes)? *Recomiendo sí.*
8. **Precio pactado.** ¿Se congela el monto al contratar (`billed_amount_cents`) y el MRR usa ese monto, de modo que cambiar el precio de un plan no toca a los clientes actuales? *Recomiendo sí.*
9. **Acciones del Super Admin sobre suscripciones de MP.** ¿La matriz de F4 (suspender/cancelar/cambiar plan se propagan a MP; activar/asignar sobre una activa de MP dan 409)? *Recomiendo sí: el panel y la pasarela nunca deben contradecirse.*
10. **Credenciales de prueba.** ¿Me das **credenciales de prueba de Mercado Pago Perú** (token, secreto del webhook y usuarios de prueba) para validar los puntos ⚠? *Sin ellas dejo todo verificado contra el mock y te lo digo explícitamente; no declaro «hecho» lo que solo el mock confirmó.*
11. **Contracargos.** ¿Solo marcarlos «a revisar» en el panel, sin suspender automáticamente? *Recomiendo sí.*
12. **Dónde viven las credenciales.** ¿En variables de entorno del servidor (como en 045 y como pide el manejo de credenciales del proyecto) y no cifradas en base de datos desde una pantalla del panel? *Recomiendo variables de entorno: una pantalla de credenciales del operador es otra superficie sensible y puede venir después.*
