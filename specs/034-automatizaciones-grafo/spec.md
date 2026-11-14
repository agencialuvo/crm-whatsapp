# Feature Specification: Automatizaciones — Fase 3 (intérprete de grafo: `automation_edge` y `automation_run`)

**Feature Branch**: `main` (incremental, detrás de `AUTOMATIONS`)

**Created**: 2026-11-14

**Status**: Fase 3 implementada; typecheck, lint, build, vitest y pruebas contra Postgres real en verde
(`automation-graph.test.ts`, `automation-graph-live.test.ts`). Sin commit (pendiente de revisión).

**Carril**: ciclo completo (Principio VI). Migración **aditiva** `0069` (dos tablas nuevas y una columna nullable en
`automation_queue`). No cambia ningún contrato publicado (`/api/bot/*`, despacho, webhooks, `/api/health`); la API de
automatizaciones solo **gana** una ruta (`GET /api/automations/[id]/graph`). Construye sobre las Fases 1
([032](../032-automatizaciones-citas/spec.md)) y 2 ([033](../033-automatizaciones-etiquetas-condiciones/spec.md)).

## El problema

El motor ejecuta un flujo **en fila**: el «siguiente» paso es el de abajo en el lienzo y las ramas de `condition` y
`wait_until` se simulan con `skip`/`stop`. Eso no escala a lo que viene: un `condition` con dos caminos reales, una
espera de respuesta con tiempo límite (Fase 4), un lienzo visual (Fase 5). Además no existe el concepto de
**ejecución de un flujo para un contacto**: hay tareas sueltas en la cola, sin un estado propio que se pueda
consultar, cancelar o proteger de carreras.

## Qué entrega la Fase 3

| Pieza | Qué hace |
|---|---|
| **`automation_edge`** | Las aristas del grafo: de qué paso sale (`source_step_id`), a cuál llega (`target_step_id`) y por qué «asa» (`source_handle`: `default`, `true`, `false`, `late`, `timeout`). Fuente de verdad del orden de ejecución. |
| **`automation_run`** | Una ejecución de un flujo para un contacto: `status` (`running`/`waiting`/`completed`/`failed`/`cancelled`), `current_step_id`, `context` (JSON), `waiting_for` (`time`/`reply`/null), `dedupe_key`, `started_at`/`ended_at`. Único por `(org, flujo, contacto, llave)`: idempotencia **a nivel de ejecución**. |
| **Cola con `run_id`** | Cada tarea de `automation_queue` apunta a su ejecución. |
| **Intérprete por aristas** | Un paso termina con un `NodeResult { handle, nextAt? }`; el motor busca la arista `(paso, handle)` y encola el destino. Sin arista = el flujo termina. |
| **`emitAutomationEvent`** | Un solo punto de entrada de eventos: busca los flujos activos del disparador, filtra, y por cada uno crea el `run` (con dedupe) y encola el primer paso. Lo usan cambio de etapa, lead nuevo y las tres citas. |
| **Modo Simple compila a aristas** | La lista lineal sigue siendo la interfaz: al crear, editar, mover o borrar pasos se **recompilan** las aristas (`compileLinearEdges`). `ifTrue`/`ifFalse` de `condition` y `lateAction` de `wait_until` se vuelven aristas `true`/`false`/`late`. |
| **`GET /api/automations/[id]/graph`** | Nodos, aristas y paso de entrada: lo que consumirá el lienzo (Fase 5). |

## Decisiones

- **D1 — Las aristas son la fuente de verdad; la lista las deriva.** Hasta la Fase 5 todo flujo es «simple»:
  cualquier cambio de pasos recompila sus aristas (borra y reinserta, en una transacción). No hay flujos que el
  usuario edite como grafo todavía, así que no existe riesgo de pisar aristas a mano. Cuando llegue el lienzo, un
  campo `mode` decidirá si se recompila.
- **D2 — Un `NodeResult`, no `skip`/`stop`.** El paso devuelve `{ handle, nextAt? }`. `condition` → `true`/`false`;
  `wait_until` tarde → `late`; el resto → `default`. Las acciones lineales (`continue`/`skip_next`/`stop`) viven
  solo en la **compilación** (`skip_next` apunta a «el de después del siguiente»; `stop` no genera arista).
- **D3 — Una arista por asa.** Único `(source_step_id, source_handle)`: un asa lleva a un solo destino (sin
  abanicos en esta fase). Es el contrato que necesitan `true`/`false` y simplifica la concurrencia.
- **D4 — Entrada del flujo = el primer paso en el orden del lienzo.** Igual que hoy; sin columna nueva.
- **D5 — Compatibilidad con flujos existentes por lectura perezosa.** No hay backfill en SQL: `ensureEdges`
  (al arrancar un `run`, al pedir el grafo) compila y guarda las aristas de un flujo que tiene ≥ 2 pasos y ninguna
  arista. Mientras tanto, el intérprete usa la compilación en memoria como respaldo, así que una tarea en vuelo
  durante el despliegue sigue su camino. Tareas viejas sin `run_id` terminan igual (sin crear run).
- **D6 — El `run` refleja la cola; la cola sigue mandando.** `running` mientras hay un paso listo; `waiting` +
  `waiting_for = time` cuando el siguiente paso es futuro; `completed` cuando no hay arista; `failed` cuando una
  tarea falla definitivamente o se agotan sus intentos; `cancelled` al cancelar (cita, flujo apagado). `reply`
  queda reservado para la Fase 4.
- **D7 — Concurrencia con candados de fila.** Avanzar un `run` toma `SELECT … FOR UPDATE` sobre la fila del
  `run` **antes** de tocar la cola; cancelar un `run` actualiza el `run` **antes** que la cola. Mismo orden de
  candados → sin interbloqueo, y quien llega segundo ve el estado del primero: un `run` cancelado **no** encola
  el siguiente paso aunque su tarea en vuelo termine después. Es la misma garantía que necesitará «llegó la
  respuesta» contra «venció el temporizador» (Fase 4). Reclamar tareas sigue siendo `FOR UPDATE SKIP LOCKED`.
- **D8 — Cancelar toca también lo que está en vuelo.** `cancelPendingForBooking` cancela los `run` de la cita
  (`pending` **y** `processing`) y sus tareas pendientes; una tarea ya tomada, antes de ejecutar, comprueba que su
  `run` siga vivo (`run_cancelled`) y se cancela sola.
- **D9 — Idempotencia en dos niveles.** El `run` es único por `(org, flujo, contacto, llave)`; la cola conserva su
  índice único de siempre. Si la tarea inicial choca (llave vieja de antes de esta fase), el `run` recién creado se
  borra en la misma transacción: no quedan `run` huérfanos.
- **D10 — Borrar un paso cancela los `run` que estaban en él** (si no, quedarían `running` para siempre); borrar un
  flujo se lleva sus `run` y aristas por cascada.
- **D11 — `context` guarda lo estable del arranque** (`{ bookingId }` en flujos de cita). La cita sigue viajando
  también en `automation_queue.booking_id` (de ahí cuelgan la cancelación por cita y su cascada de borrado).

## Idempotencia y resiliencia

- Disparo repetido (reintento, dos pestañas, reinicio): el índice único del `run` decide; la segunda inserción no
  hace nada.
- Éxito repetido de una tarea: el índice único parcial del historial (Fase 0) sigue siendo la llave.
- Caída del worker a mitad: la toma vence y se reclama; `failExhausted` cierra la tarea **y su `run`**.
- Dos avances de la misma tarea: el segundo ve la tarea ya `completed` bajo el candado del `run` y no encola otro paso.

## Fuera de alcance

`wait_reply`, intención por LLM y disparador `ad_referral` (F4) · lienzo React Flow y edición de aristas (F5) ·
bajas y límite de frecuencia (F6) · abanicos (varias aristas por asa) · `PUT` del grafo.

---

# Plan de cambios por archivo

## 1. Base de datos (`drizzle/0069_…`)
| Archivo | Cambio |
|---|---|
| `src/lib/db/schema.ts` | `automation_edge` (único `(source_step_id, source_handle)`, índice por flujo, cascadas); `automation_run` (único `(org, flow, contact, dedupe_key)`, índices por estado y flujo; `current_step_id` `ON DELETE SET NULL`); `automation_queue.run_id` (FK `ON DELETE CASCADE`, nullable) + índice. |
| `src/lib/db/ids.ts` | prefijos `edg` y `arn`. |
| `drizzle/0069_*.sql`, `meta/` | Migración generada y aplicada. |

## 2. Reglas puras (`src/lib/automation.ts`)
`EDGE_HANDLES`, `NodeResult { handle, nextAt? }` (el `NodeResult` de la Fase 2 pasa a llamarse `ConditionOutcome`),
`conditionHandle`, **`compileLinearEdges`**, `RUN_STATUSES`/`WAITING_FOR`. Se retiran `resolveBranch`/`branchAdvance`
(su lógica es ahora la compilación).

## 3. Motor y cola (`src/server/automation/`)
| Archivo | Cambio |
|---|---|
| `engine.ts` | `AdvanceOptions { handle? }`; cada ejecutor devuelve su `NodeResult` y avanza una sola vez; `Deps.runStatus` (opcional) para detectar un `run` cancelado en vuelo. |
| `queue.ts` | `completeAndAdvance` por aristas bajo candado del `run`; `markFailed`/`markCancelled`/`failExhausted` cierran el `run`; `resolveNext`. |
| `graph.ts` (nuevo) | `compileFlowEdges`, `syncEdges`, `ensureEdges`, `getGraph`. |
| `trigger-store.ts` | `enqueueFirstStep` crea el `run` + la tarea en una transacción (con `ensureEdges`); `cancelPendingForBooking` cancela `run` y tareas en el orden de candados de D7. |
| `triggers.ts` + `events.ts` | `emitAutomationEvent`; `onLeadCreated`/`onLeadStageChanged`/`onBooking*` delegan en él. |
| `flows.ts` | Recompila aristas al crear/editar/borrar pasos; cancela `run` al borrar un paso. |
| `src/app/api/automations/[id]/graph/route.ts` (nuevo) | `GET` del grafo. |
| `worker.ts` | Cableado de `runStatus`. |

## 4. Pruebas (Vitest; sin E2E por regla del proyecto)
`automation-graph.test.ts` (compilación pura) · se actualizan las pruebas de motor, citas y etiquetas
(`handle` en vez de `skip`/`stop`) · `automation-graph-live.test.ts` (Postgres real: aristas sincronizadas, ciclo de
vida del `run`, ramas `true`/`false` con aristas reales, idempotencia por `run`, cancelación en vuelo vs avance en
paralelo, flujo viejo sin aristas, borrado de paso, aislamiento entre organizaciones, `GET graph`).

# Puntos de acoplamiento con las Fases 1 y 2

| Punto | Qué pasa |
|---|---|
| `completeAndAdvance(row, at, {skip, stop})` (F1) | Pasa a `{ handle }`. `skip_next` de `wait_until` = arista `late` hacia «el de después»; `stop` = sin arista. |
| `condition` `ifTrue`/`ifFalse` (F2) | Siguen siendo la configuración del Modo Simple; se **compilan** a aristas `true`/`false`. El motor ya no las lee. |
| `booking_id` en la cola (F1) | Se conserva (cancelación por cita, cascada de borrado); el `run.context` lo repite como dato del arranque. |
| `bookingGuard` (F1) | Corre antes de cada paso, igual: un `run` no resucita una cita cancelada. |
| `cancelPendingForBooking` (F1) | Además cancela `run` (incluidos los de tareas en vuelo); `exceptTrigger` se respeta. |
| `viaAutomation` (F2) | Sin cambios: el anti-bucle sigue siendo «un `set_stage` no emite `stage_changed`». El encadenamiento con profundidad queda para cuando haga falta. |

# Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Flujos existentes sin aristas | Lectura perezosa (`ensureEdges`) + compilación en memoria como respaldo; prueba con un flujo viejo real. |
| Aristas desfasadas de los pasos | Toda mutación de pasos recompila en la misma operación; `ensureEdges` y `GET graph` curan los flujos viejos. |
| Carrera cancelar vs avanzar | D7: mismo orden de candados + prueba con avance y cancelación en paralelo. |
| `run` huérfano si la tarea inicial choca | D9: se borra en la transacción; prueba de idempotencia. |
| `run` colgado al borrar un paso | D10 + prueba. |
| Churn de pruebas por el cambio de `skip`/`stop` a `handle` | Se actualizan las aserciones; el comportamiento observable (qué pasos corren) no cambia y las pruebas de Postgres de las Fases 1 y 2 lo prueban sin tocar. |
