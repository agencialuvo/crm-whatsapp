# Feature Specification: Automatizaciones — Fase 4 (`wait_reply` y disparador `ad_referral`)

**Feature Branch**: `main` (incremental, detrás de `AUTOMATIONS`; `ad_referral` además necesita que llegue un anuncio)

**Created**: 2026-11-14

**Status**: Fase 4 implementada; typecheck, lint, build, vitest y pruebas contra Postgres real en verde
(`automation-reply.test.ts`, `automation-reply-live.test.ts`). Sin commit (pendiente de revisión).

**Carril**: ciclo completo (Principio VI). Migración **aditiva** `0070` (una columna nullable en `automation_run`).
Los enums nuevos (`ad_referral`, `wait_reply`, asas `confirmed`/`declined`/`reschedule`/`other`) son `text` con tipos de
TS: sin SQL. No cambia ningún contrato publicado (`/api/bot/*`, despacho, webhooks, `/api/health`): el webhook de
WhatsApp recibe el mismo payload; lo nuevo ocurre **dentro** de la ingesta. Construye sobre las Fases 1–3
([032](../032-automatizaciones-citas/spec.md), [033](../033-automatizaciones-etiquetas-condiciones/spec.md),
[034](../034-automatizaciones-grafo/spec.md)).

## El problema

Un recordatorio de cita dice «¿confirmas?» y el flujo no se entera de la respuesta: la confirmación sigue siendo
manual (botón en la Agenda). Y un anuncio Click-to-WhatsApp ya sabe a qué servicio llevar al agente (`ad_flow`), pero
no puede arrancar una **automatización** (etiquetar al lead, mandarle un mensaje de bienvenida del servicio…).

## Qué entrega la Fase 4

| Pieza | Qué hace |
|---|---|
| **Paso `wait_reply`** | Pausa la ejecución hasta que el cliente responda **o** venza un tiempo límite. Sale por una de cinco asas: `confirmed`, `declined`, `reschedule`, `other` (según la intención de la respuesta) o `timeout`. |
| **Intercepción en la ingesta** | Al entrar un mensaje de un contacto con una ejecución esperando respuesta, se clasifica y se reanuda el flujo por el asa que toca. |
| **Clasificador de intención** | Reglas exactas para lo obvio («sí», «no puedo», «reagendar»…) y, para lo demás, el LLM del negocio con salida validada; sin confianza o sin IA → `other`. |
| **Confirmación automática** | Si la intención es `confirmed` y la ejecución viene de una cita, se llama a `confirmBooking` (la misma función del botón de la Agenda). Prometida desde la Fase 1. |
| **Disparador `ad_referral`** | Cuando una conversación registra su anuncio de origen (`source_id`), arranca cada flujo `ad_referral` activo (opcionalmente acotado a un anuncio). El `run` lleva el contexto: anuncio, servicio u oferta. `{{servicio}}` se puede usar en los mensajes. |
| **Pantallas** | «Esperar respuesta» en el diálogo de pasos (tiempo límite, qué hacer en cada caso, confirmar la cita) y el disparador «Llegó de un anuncio» al crear un flujo. |

## Decisiones

- **D1 — La espera es de la ejecución, con una tarea de «timeout».** Al ejecutarse `wait_reply`, el `run` pasa a
  `waiting` / `waiting_for = reply` y se guarda `waiting_until`; la tarea del paso se cierra y se encola **una tarea
  de timeout** (mismo paso, `scheduled_for = waiting_until`, llave `reply_timeout:<run>:<paso>:<instante>`). Cuando
  esa tarea corre, el motor la reconoce por su llave y resuelve la espera por `timeout`.
- **D2 — Siempre hay tiempo límite.** `timeoutMinutes` es opcional en el formulario pero **tiene valor por
  defecto (7 días) y tope (30)**. Así toda espera tiene una tarea en la cola: la cancelación por cita, por flujo
  apagado y la recuperación tras una caída funcionan sin casos especiales, y una respuesta tres meses después no
  reanuda un flujo olvidado.
- **D3 — Una sola función resuelve la espera (`resolveReplyWait`), la llamen la respuesta o el temporizador.**
  Toma `FOR UPDATE` la fila del `run`; si ya no está `waiting/reply`, no hace nada. Si lo está: cierra la(s)
  tarea(s) pendiente(s) del paso, sigue la arista `(paso, asa)` y encola el destino (o completa la ejecución). Es el
  mismo orden de candados de la Fase 3 (`run` y luego la cola), así que **la carrera «respuesta vs. vencimiento» la
  gana exactamente uno**: el otro ve el `run` ya resuelto y termina sin efectos. Esa es la garantía que se prueba.
- **D4 — Solo el texto cuenta.** Un sticker, reacción, imagen o audio sin texto **no** reanuda la espera (el
  cliente sigue pendiente de responder). Un botón o respuesta rápida cuenta con su texto.
- **D5 — Intención: reglas primero, LLM después, `other` si hay duda.** Reglas = coincidencia **exacta** con una
  lista corta y normalizada (sin acentos, mayúsculas ni puntuación); nada de «contiene» (un «no sé si sí» no puede
  ser `confirmed`). El LLM recibe el texto como DATO delimitado (instrucción de ignorar órdenes dentro de él), debe
  devolver `{ intent, confidence }` validado por Zod, tiene tope de tiempo, y una confianza < 0,6, una salida
  inválida, un fallo del proveedor o IA sin configurar dan `other`. Clasificar **nunca** lanza ni demora el mensaje
  del cliente más allá del tope.
- **D6 — Solo cuando hay alguien esperando.** Si el contacto no tiene una ejecución `waiting/reply`, la ingesta no
  llama a nada ni al LLM (una consulta indexada).
- **D7 — El agente no se silencia.** La respuesta del cliente sigue su camino normal (el agente de IA contesta
  como siempre); el flujo la usa como señal. Si el negocio no quiere dos voces, lo resuelve en el contenido del
  flujo o pausando la IA de esa conversación. (Silenciar al agente ante una respuesta «consumida» es una decisión
  de producto aparte.)
- **D8 — Modo Simple compila las cinco ramas.** `wait_reply` lleva `onConfirmed` (continuar), `onDeclined`,
  `onReschedule`, `onOther` y `onTimeout` (terminar) — cada una `continue` / `skip_next` / `stop` — que
  `compileLinearEdges` vuelve aristas `confirmed`/`declined`/`reschedule`/`other`/`timeout`. Sin arista, el flujo
  termina.
- **D9 — `confirmBooking` solo en flujos de cita y con confirmación.** Config `confirmBooking` (por defecto sí).
  Va **después** de resolver la espera y es best-effort (un fallo se registra, no revierte la resolución).
- **D10 — `ad_referral`: una vez por contacto y anuncio.** Llave `ad_referral:<source_id>`; el `run` es único por
  `(flujo, contacto, llave)`. Se emite solo cuando la atribución es **nueva o reemplazada** (no en reentregas del
  webhook ni cuando «el primero gana»). Un flujo con `sourceId` solo reacciona a ese anuncio; sin él, a cualquiera.
  Requiere un chat de WhatsApp real (igual que los demás disparadores).
- **D11 — Contexto del anuncio en el `run`.** `context = { adSourceId, headline, serviceName | comboName }`, tomados
  del `ad_flow` activo del anuncio (si lo hay). Se guarda como **foto** (no se relee): el flujo ve lo que valía al
  llegar el lead.
- **D12 — Una ejecución sin `run` no puede esperar.** Una tarea anterior a los `run` que llegue a `wait_reply` falla
  a la vista (`wait_reply_requires_run`).
- **D13 — Idempotencia.** Entrar a la espera es idempotente (un reintento tras caída no duplica la tarea de
  timeout: lo impide la llave única); resolver es idempotente por el estado del `run`; el historial de la resolución
  por respuesta se escribe sin tarea propia (`queue_id` NULL).

## Fuera de alcance

Lienzo y edición de aristas (F5) · bajas y límite de frecuencia (F6) · silenciar al agente ante una respuesta
consumida · transcripción de audios · varios `wait_reply` simultáneos para el mismo contacto con intenciones
distintas (se resuelven todos con la misma respuesta) · intenciones configurables por el negocio.

---

# Plan de cambios por archivo

## 1. Base de datos (`drizzle/0070_…`)
| Archivo | Cambio |
|---|---|
| `src/lib/db/schema.ts` | `automation_run.waiting_until`; `trigger_type` += `ad_referral`; `step_type` += `wait_reply`; `source_handle` += `confirmed`/`declined`/`reschedule`/`other` (TS). |
| `drizzle/0070_*.sql`, `meta/` | Migración generada y aplicada. |

## 2. Reglas puras (`src/lib/`)
| Archivo | Cambio |
|---|---|
| `automation.ts` | `REPLY_INTENTS`, `waitReplyConfigSchema`, `compileLinearEdges` para `wait_reply`, asas nuevas, llaves (`replyTimeoutKey`, `adReferralDedupeKey`), `{{servicio}}`. |
| `automation-schemas.ts` | `ad_referral` y `wait_reply` aceptados por la API. |
| `automation-dto.ts` | Textos de los dos. |

## 3. Servidor
| Archivo | Cambio |
|---|---|
| `src/server/automation/intent.ts` (nuevo) | `classifyByRules`, `classifyReplyIntent` (reglas → LLM → `other`). |
| `src/server/automation/queue.ts` | `enterReplyWait`, `resolveReplyWait`, `runContext`; `cancelPendingForBooking` intacta (la espera siempre tiene tarea). |
| `src/server/automation/engine.ts` | Ejecutor de `wait_reply` (entrar / vencer); `{{servicio}}`. |
| `src/server/automation/reply.ts` (nuevo) | `onInboundReply`: busca ejecuciones esperando, clasifica, resuelve, confirma la cita. |
| `src/server/inbox/ingest.ts` | Gancho `onInboundReply` tras guardar el mensaje (best-effort). |
| `src/server/automation/ad-referral.ts` (nuevo) + `attribution/store.ts` | `emitAdReferral` al registrarse un anuncio nuevo. |
| `events.ts`, `trigger-store.ts` | `context` del evento llega al `run`. |
| `flows.ts` | Valida el `sourceId` de `ad_referral`. |
| `worker.ts` | Cableado. |

## 4. Pantallas
`step-dialog.tsx` (formulario de «Esperar respuesta»), `flow-dialog.tsx` (disparador «Llegó de un anuncio» y su
anuncio), `flow-detail-client.tsx` (icono).

## 5. Pruebas (Vitest; sin E2E por regla del proyecto)
`automation-reply.test.ts` (reglas de intención, LLM simulado, esquemas, compilación, motor con dobles) ·
`automation-reply-live.test.ts` (Postgres real: entrar a la espera, resolver por cada asa, timeout, **carrera
respuesta/vencimiento**, texto vs sticker, confirmar la cita, cancelación por cita, flujo apagado, `ad_referral`
de punta a punta con contexto).

# Puntos de acoplamiento con las Fases 1–3

| Punto | Qué pasa |
|---|---|
| `confirmBooking` (F1) | Lo llama la resolución `confirmed`; dispara `booking_confirmed` como el botón. |
| `automation_run` y candados (F3) | `resolveReplyWait` usa el mismo orden de candados; `waiting_for = reply` ya estaba reservado. |
| `cancelPendingForBooking` (F1/F3) | Cancela el `run` esperando (su tarea de timeout lleva `booking_id`). |
| `NodeResult`/asas (F3) | Se amplía el catálogo de asas; el intérprete no cambia. |
| `ad_flow` y `registrarAnuncioDeOrigen` (ad-flow) | El enrutamiento del agente sigue igual; se **añade** la emisión del evento. |
| `emitAutomationEvent` (F3) | `ad_referral` es un tercer cliente del punto de entrada único. |

# Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Carrera respuesta / vencimiento | D3 + prueba con las dos operaciones en paralelo muchas rondas. |
| El LLM tumba o demora la ingesta | D5/D6: solo si hay alguien esperando, con tope de tiempo y fallback `other`; nunca lanza. |
| Falso positivo de «confirmado» | Reglas exactas (no «contiene») y umbral de confianza; ante duda, `other`. |
| Inyección de instrucciones en la respuesta | El texto va como dato delimitado y la salida se valida con Zod. |
| Espera eterna / flujo olvidado | D2: tiempo límite siempre. |
| `ad_referral` dispara dos veces | D10: llave por anuncio y emisión solo en atribución nueva. |
| Un fallo en la automatización cuesta el mensaje del cliente | `onInboundReply` y `emitAdReferral` atrapan todo; el mensaje y la atribución ya están guardados. |
