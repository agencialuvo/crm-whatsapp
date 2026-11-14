# Feature Specification: Automatizaciones — Fase 2 (etiquetas, acciones de CRM y condición)

**Feature Branch**: `main` (incremental, detrás de `AUTOMATIONS`; las etiquetas en sí no tienen bandera)

**Created**: 2026-11-14

**Status**: Fase 2 implementada; typecheck, lint, build, vitest y pruebas contra Postgres real en verde
(`automation-tags.test.ts`, `automation-tags-live.test.ts`). Sin commit (pendiente de revisión).

**Carril**: ciclo completo (Principio VI). Migración **aditiva** `0068` (dos tablas nuevas). No cambia ningún
contrato publicado (`/api/bot/*`, despacho, webhooks, `/api/health`). Construye sobre la Fase 1
([032](../032-automatizaciones-citas/spec.md)).

## El problema

Un flujo hoy solo sabe esperar y mandar mensajes. Un negocio necesita que la automatización **actúe sobre el
CRM** («al agendar, ponle la etiqueta *Cita pendiente*», «si no confirmó, pásalo a *Contactado*») y que **decida**
(«si ya confirmó, no le escribas otra vez»). Tampoco existe el concepto de **etiqueta**: no hay forma de
clasificar contactos con palabras propias del negocio, ni a mano ni desde un flujo.

## Qué entrega la Fase 2

| Pieza | Qué hace |
|---|---|
| **Etiquetas** | Tablas `tag` y `contact_tag`. Alta, lista, renombrar/color, borrado y asignación manual desde la ficha del contacto (Bandeja), con «crear al vuelo». |
| **Pasos `add_tag` / `remove_tag`** | Asigna o quita una etiqueta al contacto del flujo. Idempotentes (`ON CONFLICT DO NOTHING`; quitar lo que no está es un no-op). |
| **Paso `set_stage`** | Mueve al lead del contacto a una etapa, referenciada **estrictamente por `stageId`**. Pasa por la única puerta del embudo (`moveLeadToStage`): deja evento en la bitácora. |
| **Anti-bucle** | Un movimiento hecho por un flujo **no dispara flujos `stage_changed`** (profundidad de encadenamiento = 0). Queda en la bitácora con `source = sistema`. |
| **Paso `condition`** | Evalúa una regla (`tag_has`, `tag_missing`, `booking_confirmed`, `stage_is`) y, según el resultado, `continue` / `skip_next` / `stop`. El resultado verdadero/falso es un valor de primera clase (`NodeResult`) listo para colgar de las aristas de la Fase 3. |
| **Pantallas** | Etiquetas en el panel del contacto (ver, agregar, quitar, crear). Diálogo de pasos con «Agregar/Quitar etiqueta», «Mover de etapa» y «Condición» (regla, parámetro y acción por rama). |

## Decisiones

- **D1 — Aditivo.** Dos tablas nuevas; los enums de `step_type` son `text` con tipos de TS (sin SQL). Sin
  `AUTOMATIONS`, los pasos nuevos no corren; las etiquetas funcionan igual (son del CRM, no de las
  automatizaciones).
- **D2 — Pivote con `organization_id`.** La constitución (III) exige `organization_id` en toda tabla de dominio:
  `contact_tag` lleva la columna además de la llave compuesta `(contact_id, tag_id)`, para que toda consulta
  pase por `scoped()`. Unicidad de la etiqueta: `(organization_id, name)` exacta **y** el servicio compara sin
  distinguir mayúsculas (`Vip` y `vip` no coexisten).
- **D3 — Etapas y etiquetas por `id`.** Ningún paso compara nombres. Un paso cuyo `tagId`/`stageId` ya no
  existe **falla a la vista** (`tag_not_found`, `stage_not_found`) en vez de darse por hecho; se valida también
  al guardar (la etiqueta/etapa debe ser de la organización).
- **D4 — Anti-bucle por diseño, no por contador.** `moveLeadToStage` recibe `viaAutomation`. Con él: el origen se
  anota como `sistema`, y **no** se llama a `onLeadStageChanged`. Así `A → set_stage → (stage_changed) → B →
  set_stage → A…` es imposible por construcción. Costo aceptado: un flujo no puede encadenar a otro a través de
  la etapa (el encadenamiento controlado, con profundidad, llega con `automation_run` en la Fase 3).
  Meta/CAPI (`reportStageChange`) sí se reporta: la conversión es real aunque la haya movido un flujo.
- **D5 — Etapa perdida.** Entrar a una etapa `lost` exige motivo en la puerta del embudo; `set_stage` manda
  `otro` con la nota «Automatización» para no fallar.
- **D6 — Contacto sin lead.** `set_stage` sobre un contacto sin lead falla con `contact_has_no_lead`: no se
  inventa un lead desde una automatización.
- **D7 — `condition` en el modo lineal (hoy).** Config: `{ rule, ifTrue, ifFalse }`, cada rama una **acción**:
  `continue` (sigue con el paso que sigue), `skip_next` (omite el paso siguiente y continúa) o `stop` (termina el
  flujo). Por defecto `ifTrue = continue`, `ifFalse = stop` («si cumple, sigue; si no, termina»). El motor no
  sabe de «ramas»: llama a `evaluateCondition` → `NodeResult { result: boolean }` y traduce la acción de la rama
  a `AdvanceOptions`. En la Fase 3, `result` elegirá la arista `true`/`false`; la acción lineal deja de usarse.
- **D8 — `booking_confirmed` necesita una cita.** Solo se acepta en flujos de disparador de cita (se valida al
  guardar el paso); en ejecución sin cita en contexto la regla es falsa. Lee `booking.confirmed_at` **al ejecutar**
  (la confirmación puede llegar mientras el flujo espera).
- **D9 — Evaluación con datos del momento.** `tag_has`/`tag_missing`/`stage_is` se leen al ejecutar el paso, no
  al disparar el flujo.

## Idempotencia

- `add_tag`: `INSERT … ON CONFLICT (contact_id, tag_id) DO NOTHING` → reintentar el paso no duplica.
- `remove_tag`: borrar lo ausente no falla.
- `set_stage`: mover a la etapa donde ya está no escribe evento (`changed = false` en la puerta).
- Todo paso se registra con la llave única de éxito por tarea (reintentos tras caída no repiten).

## Fuera de alcance

Disparador `tag_added`, grafos con `automation_edge` (F3), `wait_reply` e intención por LLM (F4), lienzo (F5),
bajas y límite de frecuencia (F6), pantalla de administración de etiquetas en Ajustes (renombrar/borrar existe en
la API; la UI de esta fase es la ficha y el diálogo de pasos).

---

# Plan de cambios por archivo

## 1. Base de datos (`drizzle/0068_…`)
| Archivo | Cambio |
|---|---|
| `src/lib/db/schema.ts` | `tag` (`id`, `organization_id`, `name`, `color`, `created_at`; único `(organization_id, name)`); `contact_tag` (`organization_id`, `contact_id`, `tag_id`, `assigned_at`; PK `(contact_id, tag_id)`; cascada en ambos FK; índice por `tag_id`); `step_type` += `set_stage`, `remove_tag` (TS). |
| `src/lib/db/ids.ts` | prefijo `tag`. |
| `drizzle/0068_*.sql`, `meta/` | Migración generada y aplicada. |

## 2. Reglas puras (`src/lib/`)
| Archivo | Cambio |
|---|---|
| `automation.ts` | `addTagConfigSchema`, `removeTagConfigSchema`, `setStageConfigSchema`, `conditionRuleSchema`, `conditionConfigSchema`, `BRANCH_ACTIONS`, **`evaluateCondition`**, `NodeResult`, `resolveBranch`, `branchAdvance`. |
| `automation-schemas.ts` | Pasos nuevos en `STEP_TYPES`, `stepCreateSchema` y `parseStepConfig`. |
| `automation-dto.ts` | Etiquetas, `describeStep` (con etiquetas/etapas), `describeCondition`, opciones de regla. |
| `tags.ts` (nuevo) | Contratos Zod de etiqueta (nombre, color), paleta, `TagDto`. |

## 3. Servidor
| Archivo | Cambio |
|---|---|
| `src/server/tags/store.ts` (nuevo) | CRUD de etiquetas y asignación (todo con `scoped`). |
| `src/server/leads/stage-history.ts` | `viaAutomation` en `MoveInput` (origen `sistema`, sin `onLeadStageChanged`). |
| `src/server/automation/actions.ts` (nuevo) | `applyTag`, `moveContactToStage`, `contactFacts`: lo que el motor necesita del CRM. |
| `src/server/automation/engine.ts` | `Deps` += `contactFacts`, `applyTag`, `moveContactToStage`; ejecutores de `add_tag`, `remove_tag`, `set_stage`, `condition`; `BookingInfo.confirmedAt`. |
| `src/server/automation/queue.ts`, `worker.ts` | `loadBooking` trae `confirmedAt`; cableado. |
| `src/server/automation/flows.ts` | Valida que `tagId`/`stageId` sean de la organización y que `booking_confirmed` solo vaya en flujos de cita. |
| `src/app/api/tags/`, `src/app/api/contacts/[id]/tags/` (nuevos) | CRUD de etiquetas y asignación; `GET /api/contacts/[id]` devuelve `tags`. |

## 4. Pantallas
| Archivo | Cambio |
|---|---|
| `src/components/tags/tag-picker.tsx` (nuevo) | Chips con ✕, selector con buscador y «crear al vuelo». |
| `src/components/inbox/contact-panel.tsx` | Sección «Etiquetas». |
| `src/components/automatizaciones/step-dialog.tsx`, `flow-detail-client.tsx` | Formularios de `add_tag`/`remove_tag`/`set_stage`/`condition`; el detalle carga etiquetas. |

## 5. Pruebas (Vitest; sin E2E por regla del proyecto)
`automation-tags.test.ts` (reglas puras, esquemas) · motor con dobles (ejecutores, ramas, errores) ·
`automation-tags-live.test.ts` (Postgres real: etiquetas idempotentes, cascadas, aislamiento, `set_stage` por la
puerta sin disparar `stage_changed`, `condition` con cita confirmada) · se actualizan `automation-ui`/`-api`.

# Puntos de acoplamiento con la Fase 1

| Punto | Qué pasa |
|---|---|
| `completeAndAdvance(row, at, {skip, stop})` | `condition` lo reutiliza tal cual: `skip_next` → `{skip:1}`, `stop` → `{stop:true}`. Sin cambios en la cola. |
| `booking_id` en la tarea | `booking_confirmed` lee la cita de `row.bookingId`; `BookingInfo` gana `confirmedAt`. |
| `bookingGuard` | Corre antes de cualquier paso: una condición no puede «resucitar» una cita cancelada. |
| `confirmBooking` | Confirmar mientras el flujo espera cambia el resultado de un `condition` posterior (se lee al ejecutar). |
| Seed de 5 etapas | Los flujos se configuran por id; ningún paso nombra «Citado» ni «Convertido». |
| `moveLeadToStage` | Único escritor de `lead.stage_id` (guardián en `stage-history-guard.test.ts`): `set_stage` pasa por él. |

# Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Bucle `stage_changed` ↔ `set_stage` | D4: los movimientos de automatización no disparan flujos; prueba con Postgres real. |
| Paso con etiqueta/etapa borrada | Falla visible en el historial + validación al guardar; borrar una etiqueta limpia sus asignaciones por cascada. |
| Etiquetas duplicadas por mayúsculas | Búsqueda sin distinguir mayúsculas en el servicio; el índice único protege el caso exacto y la carrera. |
| `condition` con `booking_confirmed` fuera de citas | Rechazado al guardar; en ejecución sin cita → falso. |
| Dos pestañas asignan la misma etiqueta | `ON CONFLICT DO NOTHING`; la respuesta dice si cambió algo. |
