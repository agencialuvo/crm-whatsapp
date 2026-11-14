# Feature Specification: Automatizaciones de citas — Fase 1

**Feature Branch**: `main` (incremental, detrás de `AUTOMATIONS` y `AGENDA`)

**Created**: 2026-11-14

**Status**: Fase 1 implementada; gates (typecheck, lint, build, vitest) y pruebas contra Postgres real en verde
(`automation-bookings.test.ts`, `automation-bookings-live.test.ts`). Fases 2–6 descritas abajo; no se construyen aquí.

**Carril**: ciclo completo (Principio VI). Migración **aditiva** `0067` (una columna en `booking`, una en
`automation_queue`). No cambia ningún contrato publicado (`/api/bot/*`, despacho, webhooks, `/api/health`).

## El problema

El motor de automatizaciones (cola en Postgres, worker en el proceso) solo conoce tres disparadores
—cumpleaños, cambio de etapa, lead nuevo— y un `delay` **relativo al instante en que corre el paso**. Un
negocio de citas necesita lo que el motor no sabe decir: «recuérdale la cita **un día antes**», «**2 horas
antes**», «no le escribas de madrugada: a las 10:00», y que el recordatorio **no salga si la cita se
canceló o se movió**. Tampoco hay forma de marcar que el cliente **confirmó** su asistencia.

## Qué entrega la Fase 1

| Pieza | Qué hace |
|---|---|
| **Disparadores de cita** | `booking_created`, `booking_confirmed`, `booking_no_show`. Se disparan desde `agenda/service.ts` (una sola puerta: crear, reprogramar, cancelar, marcar resultado, confirmar). |
| **Paso `wait_until`** | Espera hasta una hora **anclada a la cita** (`anchor: booking.scheduledAt`, `offsetMinutes`: −1440 = un día antes). Si la hora ya pasó (la cita se creó con menos anticipación), aplica `lateAction`: `skip_next` (omite el mensaje ligado a esa espera; por defecto), `continue` o `stop`. |
| **Ventana horaria** | `applySendWindow` (función pura): `at` (forzar a una hora, p. ej. 10:00) o `between` (solo dentro de un horario, p. ej. 09–21). Disponible en `delay` y en `wait_until`, en la zona del negocio (Ajustes → Marca). |
| **Revalidación y cancelación** | Antes de ejecutar cualquier paso de una tarea de cita se revisa que la cita siga vigente; al cancelar, reprogramar o cerrar una cita se cancelan sus tareas pendientes. Reprogramar **rearma** los flujos con la hora nueva. |
| **Confirmación híbrida** | `booking.confirmed_at`. Manual: botón «Confirmar asistencia» en la agenda. Automática: la usará `wait_reply` (Fase 4) por la misma función `confirmBooking`. |
| **Variables de cita** | `{{fecha}}` y `{{hora}}` (zona del negocio) además de `{{name}}`, para que un recordatorio diga cuándo es. |
| **Pipeline de 5 etapas** | Los negocios **nuevos** nacen con Nuevo, Contactado, Citado, Convertido (ganada) y No interesado (perdida). Los existentes no se tocan. |

## Decisiones

- **D1 — Aditivo y detrás de banderas.** Sin `AUTOMATIONS` no hay disparadores ni worker; sin `AGENDA` no hay
  citas. Nada de lo anterior cambia para flujos de cumpleaños, etapa o lead nuevo.
- **D2 — La tarea lleva la cita.** `automation_queue.booking_id` (nullable, `ON DELETE CASCADE`) es el
  contexto de la tarea; `completeAndAdvance` lo copia al paso siguiente. (La Fase 3 lo generaliza con
  `automation_run.context`.)
- **D3 — La vigencia depende del disparador.** `booking_created` y `booking_confirmed` exigen cita
  `agendada`; `booking_no_show` exige `no_show`. Una cita cancelada, realizada o movida corta los recordatorios.
- **D4 — Reprogramar rearma, y desconfirma.** Se cancelan las tareas pendientes, se limpia `confirmed_at` (el
  cliente debe confirmar la hora nueva) y se vuelve a disparar `booking_created` con una llave nueva (incluye
  la hora). Un recordatorio ya enviado para la hora vieja no se «des-envía».
- **D5 — La ventana nunca adelanta.** `at` mueve hacia **adelante** al próximo `HH:MM`; `between` hacia el
  próximo inicio de horario. Un recordatorio que la ventana empujaría a la hora de la cita o después se trata
  como tarde (`lateAction`): un recordatorio jamás sale después de la cita.
- **D6 — Sandbox.** Una cita de prueba (`is_test`) y un contacto sin chat de WhatsApp real jamás disparan
  nada. La ventana de 24 h de Meta y la exigencia de plantilla aprobada siguen igual (los recordatorios casi
  siempre caen fuera de la ventana: **piden plantilla aprobada**).
- **D7 — Un fallo aquí nunca cuesta la cita.** Los disparadores no lanzan hacia arriba; apagado no consultan
  la base.
- **D8 — Etapas por `id`.** El motor nunca compara nombres de etapa. El seed solo cambia los nombres de los
  negocios nuevos; el `ai-mock`, la demo y los colores de la bandeja se alinean.

## Idempotencia

Llaves de deduplicación (`automation_queue.dedupe_key`, índice único por organización, flujo y contacto):
`booking_created:<id>:<epoch de la hora>`, `booking_confirmed:<id>`, `booking_no_show:<id>`. Reintentar un
disparo, o que dos pestañas confirmen a la vez, no encola dos veces.

## Fuera de alcance (fases siguientes)

`wait_reply` con clasificación de intención por LLM (F4) · `condition`, `add_tag`, `set_stage` y etiquetas
(F2) · `automation_run` y `automation_edge` (F3) · disparador `ad_referral` (F4) · lienzo React Flow (F5) ·
bajas y límite de frecuencia (F6).

---

# Plan de cambios por archivo

## 1. Base de datos (`drizzle/0067_…`)
| Archivo | Cambio |
|---|---|
| `src/lib/db/schema.ts` | `booking.confirmedAt` (timestamp, null); `automation_queue.bookingId` (FK `booking`, cascade) + índice; amplía los enums de TS de `trigger_type` y `step_type` (columnas `text`: sin SQL). |
| `drizzle/0067_*.sql`, `meta/` | Migración generada. |
| `src/server/auth/on-signup.ts` | `SEED_STAGES` → las 5 etapas. |
| `src/server/dev/ai-mock.ts`, `src/server/seed/demo.ts`, `src/components/inbox/conversation-list.tsx`, `src/server/ai/prompts.ts` | Alineados a los nombres nuevos (sin comparar nombres en la lógica del motor). |

## 2. Reglas puras (`src/lib/`)
| Archivo | Cambio |
|---|---|
| `automation.ts` | `sendWindowSchema`, **`applySendWindow`**, `waitUntilConfigSchema`, **`decideWaitUntil`**, **`bookingGuard`**, llaves de dedupe de cita, `renderVars` con `{{fecha}}`/`{{hora}}`; `delayConfigSchema` admite `window`. |
| `automation-schemas.ts` | Disparadores y paso `wait_until` aceptados por la API; `parseStepConfig` por tipo. |
| `automation-dto.ts` | Etiquetas, pistas, `describeTrigger` y `describeStep` de lo nuevo. |

## 3. Motor y disparadores (`src/server/automation/`)
| Archivo | Cambio |
|---|---|
| `engine.ts` | `Row.bookingId`; revalidación antes de cada paso; ejecutor de `wait_until`; `delay` con ventana; `Deps` += `loadBooking`, `flowTriggerType`, `timezone`; `completeAndAdvance(row, at, { skip, stop })`. |
| `queue.ts` | `completeAndAdvance` copia `booking_id` y soporta `skip`/`stop`; `loadBooking`, `flowTriggerType`. |
| `trigger-store.ts` | `enqueueFirstStep` con `bookingId`; `cancelPendingForBooking`. |
| `triggers.ts` | `onBookingCreated`, `onBookingConfirmed`, `onBookingNoShow`, `onBookingRescheduled`, `onBookingClosed`. |
| `worker.ts` | Cableado de las dependencias nuevas. |

## 4. Agenda (`src/server/agenda/`, `src/app/api/bookings/`)
| Archivo | Cambio |
|---|---|
| `service.ts` | Ganchos en `createSessionBooking`, `rescheduleBooking` (limpia `confirmed_at`), `cancelBooking`, `markBookingStatus`; nueva **`confirmBooking`** (idempotente). |
| `queries.ts` | `BookingListItem.confirmedAt`. |
| `api/bookings/[id]/route.ts` | `PATCH { action: "confirm" }`. |

## 5. Pantallas
| Archivo | Cambio |
|---|---|
| `components/bookings/booking-drawer.tsx`, `booking-look.ts` | Botón «Confirmar asistencia» y estado «Confirmada». |
| `components/automatizaciones/step-dialog.tsx` | Paso «Esperar hasta la cita» y ventana horaria (también en «Esperar»). |
| `components/automatizaciones/flow-dialog.tsx` | Se alimenta de `CREATABLE_TRIGGERS` (sin cambios de lógica). |

## 6. Pruebas (Vitest; sin E2E por regla del proyecto)
`automation.test.ts` (ventana, `wait_until`, guarda, esquemas) · `automation-engine.test.ts` (revalidación,
`wait_until`, ventana) · `automation-triggers.test.ts` (disparadores de cita con dobles) ·
`automation-bookings-live.test.ts` (Postgres real: cola, cancelación y confirmación) · se actualizan
`automation-ui.test.ts` y el helper de `Deps`.

# Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Recordatorio duplicado tras reprogramar | Llave de dedupe con la hora; cancelación de pendientes antes de rearmar. |
| Recordatorio tras cancelar/realizar | Cancelación al instante + revalidación al ejecutar (red de seguridad, también cubre el cobro en Caja). |
| Reprogramar choca con la carrera de dos pestañas | Todo es idempotente; el índice único decide. |
| Pipeline: los 5 nombres rompen mocks/demos | Se alinean (D8); el motor no compara nombres. |
