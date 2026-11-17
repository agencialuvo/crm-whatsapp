# 044 — Pipeline: tablero sólido (cursor por columna, filtros, tiempo real, orden estable y etapas automáticas)

**Feature Branch**: `feat/044-pipeline-tablero-solido`

**Created**: 2026-11-17

**Status**: **Implementada** (2026-11-17), con las siete preguntas de revisión en los valores recomendados que el dueño aprobó (Q1 no renombrar existentes, Q2 arriba, Q3 plantilla de operador y eco cuentan, Q4 sin lead no se crea, Q5 la venta pone su monto si estaba vacío, Q6 un lead perdido no se reabre, Q7 25 por columna). Pendiente de commit. Verificada contra Postgres real (`pipeline-tablero-live`, 20 pruebas) y de punta a punta con la app y el mock (`pnpm test:e2e:pipeline-tablero`, 53 comprobaciones); **no con volumen real de producción**.

Ajustes que salieron al implementar (respecto del texto de abajo):
- **Candado por organización en vez de candado de filas de etapa.** La prueba de 30 movimientos simultáneos cazó un interbloqueo: la renumeración reescribe filas de OTROS leads, que otra transacción ya tenía bloqueadas mientras esperaba la etapa. `moveLeadToStage` toma primero `pg_advisory_xact_lock` de la organización (`lockPipeline`) y después el `FOR UPDATE` del lead: un solo orden de bloqueo, sin ciclo.
- **El delta devuelve `matches` por tarjeta** (calculado en SQL con los mismos filtros) en vez de que el cliente los evalúe: el cliente no tiene el texto de los mensajes ni las etiquetas.
- **Alta «arriba» sin renumerar** (`min − 1`, posición puede ser negativa; el cursor lo admite); también un movimiento de etapa sin índice entra arriba. La reubicación al borrar una etapa usa `AL_FINAL` para conservar el orden.
- **`createSessionBooking` ya no «avanza a la siguiente etapa abierta»** (el `advanceLeadStage` privado se eliminó): ahora aplica la regla `booking`. Un negocio sin el papel «Interesado» asignado deja de mover el lead al agendar.
- El eco de la app del teléfono llama a `avanzarPorRespuesta` desde `ingest.ts`; los envíos de automatizaciones pasan `automatico: true` y no cuentan.
- La tarjeta del cajón dice «Movido automáticamente: …» con la última regla (`lastAutoRule`).
- **Pendiente de producción:** crear `lead_board_idx` y `lead_org_updated_idx` bloquea un instante las escrituras de `lead`.
- El E2E encontró que el servidor de desarrollo compila cada ruta la primera vez (hasta 8 s): las esperas son por resultado, no por reloj.

**Input**: Paquete A del análisis del módulo Pipeline, con las decisiones aprobadas por el dueño (ver «Decisiones aprobadas»). Sigue a la [042](../042-bandeja-escala-y-rendimiento/spec.md) (misma receta de cursor, deltas y estado puro en el cliente) y a la [043](../043-bandeja-busqueda-en-mensajes/spec.md) (búsqueda por mensajes, reutilizable aquí).

**Carril**: ciclo completo (Principio VI). **Cambia contratos internos de la API** (`GET /api/pipeline/board` se pagina por columna; el `PATCH` de un lead renumera), **añade una migración** (0079: columna de rol de etapa, columna de regla en la bitácora e índices), **reescribe el estado de `pipeline-client.tsx`** y **engancha tres puntos del flujo comercial** (primer envío, cita, venta) a la puerta única `moveLeadToStage`. Sin bandera: es el núcleo. Las reglas automáticas se apagan solas si la etapa de destino no existe.

## Decisiones aprobadas (no se reabren)

1. **Alcance: solo el Paquete A.** Cursor por columna, filtros de búsqueda, consultas optimizadas, deltas por SSE y orden estable.
2. **Orden de columna: renumeración transaccional** al mover o soltar una tarjeta.
3. **Fuera de este paquete:** responsable del lead, varios pipelines, fecha de cierre, tareas, notas, probabilidad por etapa, acciones en lote.
4. **Etapas automáticas** (crítico para el negocio):
   - «Nuevo» → «En conversación»: cuando un operador humano o la IA (LIA) envía el primer mensaje de respuesta al contacto.
   - «Nuevo» / «En conversación» → «Interesado»: cuando el cliente agenda una cita con éxito.
   - A «Cliente»: cuando se registra una venta o cobro vinculado a su número en Caja, incluso un salto directo desde «Nuevo» si el pago es inmediato y sin cita previa.

## Cómo está hoy (leído del código)

- `GET /api/pipeline/board` devuelve **todos** los leads de la organización en una sola respuesta (`lead` ⨝ `contact` ⟕ `conversation`), sin paginar, y el cliente (`pipeline-client.tsx`, 487 líneas) lo guarda entero y lo vuelve a pedir completo tras cada arrastre (`refetch`).
- El orden dentro de la columna es `lead.position`, pero **la calcula el cliente**: al soltar, `position = cantidad de tarjetas de esa columna` (siempre al final). No hay reordenar dentro de una columna, no se compacta la columna de origen y dos tarjetas pueden quedar con la misma posición.
- La puerta única `moveLeadToStage` (`src/server/leads/stage-history.ts`) lee el lead **sin candado** dentro de la transacción: dos movimientos simultáneos del mismo lead pueden registrar dos eventos con el mismo `from`.
- El tablero **no escucha SSE**: un movimiento del bot, del agente o de otro operador no aparece hasta recargar.
- No hay búsqueda ni filtros. Los totales por columna (conteo y suma) los calcula el cliente sobre lo que tiene.
- Las etapas sembradas son «Nuevo, Contactado, Citado, Convertido (won), No interesado (lost)» (`SEED_STAGES`, `on-signup.ts`). **Nada identifica una etapa por su nombre** (el motor y el agente trabajan con `id` y `kind`), así que hoy no hay manera fiable de saber cuál es «la etapa de conversación».
- Quién crea leads: `createLeadForContact` (`src/server/inbox/lead-activity.ts`, desde el webhook y la captura manual). Quién mueve: solo `moveLeadToStage` (lo vigila `tests/unit/stage-history-guard.test.ts`).
- Puntos donde ocurren las tres señales del negocio, todos ya centralizados:
  - **Envío:** todo saliente pasa por `enviarYRegistrar` (`src/server/inbox/outbox.ts`, 041); el eco del teléfono entra por `ingest.ts` con `origin: "manual"`. Los flujos de automatización envían con `sendText`/`sendTemplate` (`automation/worker.ts`), indistinguibles hoy de un operador (`origin: "operator"`/`"template"`).
  - **Cita:** una sola función, `createSessionBooking` (`src/server/agenda/service.ts`), usada por el operador (`/api/bookings`), el bot (`/api/bot/bookings`) y el agente (`agenda/agent.ts`).
  - **Venta:** `registerServiceSale` (`src/server/business/sales-service.ts`) resuelve el contacto por `contactId`, por la cita o **por teléfono** (`customerPhone`); `updateSale` puede reasignar el contacto.

## Diseño

### 1. Rol de etapa (cimiento de las reglas automáticas)

Una regla no puede depender del nombre que el dueño le puso a su columna. Se añade **`pipeline_stage.auto_role`** (nullable): `new` · `conversation` · `interested` · `client`.

- **Único por organización** (índice parcial `where auto_role is not null`): a lo sumo una etapa por rol.
- **Backfill de la migración**, solo si el rol es inequívoco en esa organización (exactamente una etapa coincide); si no, queda `NULL` y el dueño lo asigna:
  - `new` ← «Nuevo» · `conversation` ← «En conversación» o «Contactado» · `interested` ← «Interesado» o «Citado» · `client` ← «Cliente» o «Convertido» (solo si es `won`).
- **Negocios nuevos** (`SEED_STAGES`): «Nuevo» (`new`), «En conversación» (`conversation`), «Interesado» (`interested`), «Cliente» (`won`, `client`), «No interesado» (`lost`). Los negocios existentes **no se renombran** (Q1).
- **UI:** en el gestor de etapas, un `SearchSelect` «Etapa automática» por etapa (con ayuda: «Los leads llegan aquí solos cuando…»). Una etapa sin rol no recibe movimientos automáticos.

### 2. Reglas de avance automático

Función pura `decideAutoStage({ rule, current: { kind, role } }) → rolDestino | null` en `src/lib/lead-auto-stage.ts` (compartida y probada sin red):

| Regla | Se dispara cuando | Mueve a | Solo si el lead está en |
|---|---|---|---|
| `first_reply` | un **operador** o la **IA** envía un mensaje al contacto y se confirma el envío | `conversation` | etapa abierta con rol `new` |
| `booking` | se **agenda** una cita con éxito (`agendada`) | `interested` | etapa abierta con rol `new` o `conversation` |
| `sale` | se **registra una venta** vinculada al contacto | `client` | **cualquier** etapa abierta (con o sin rol) que no sea ya `client` |

Principios:
- **Solo hacia adelante.** Nunca retrocede un lead, nunca lo saca de una etapa `won`/`lost` y nunca toca una etapa abierta sin rol en las dos primeras reglas (el dueño la puso a propósito). Cancelar una cita, borrar una venta o un reembolso **no deshacen** el movimiento (el embudo cuenta lo que pasó).
- **No cuentan como «respuesta»:** los envíos de un flujo de automatización (`first_reply`), las conversaciones del Laboratorio (`is_test`) ni los mensajes fallidos. Sí cuentan: operador, IA, plantilla enviada por un operador y el eco de la app de WhatsApp Business (`origin: "manual"`).
- **Idempotente y a prueba de carreras.** Se evalúa **dentro de la transacción de la puerta**, con el lead bloqueado (`FOR UPDATE`): si otro camino ya lo movió, el segundo no hace nada y no escribe un evento falso.
- **Trazable.** El evento de bitácora lleva `source = 'sistema'` y la nueva columna **`lead_stage_event.auto_rule`** (`first_reply` | `booking` | `sale`), para que Resultados y el cajón digan «movido automáticamente: primera respuesta».
- **Efectos secundarios normales.** Un movimiento automático dispara lo mismo que uno manual: automatizaciones `stage_changed` y, al entrar a `won`, el reporte a Meta (`reportStageChange`, 016). No hay bucle posible: las reglas solo avanzan y los flujos que envían mensajes no cuentan como `first_reply`.
- **Nunca rompe a quien la llama.** El gancho no lanza: un fallo se registra y el envío, la cita o la venta siguen en firme (el movimiento ya no es parte de su transacción).
- Si el contacto **no tiene lead**, no se crea uno (Q4).

Ganchos (tras el commit de cada operación):

| Dónde | Archivo | Detalle |
|---|---|---|
| Envío confirmado | `src/server/inbox/outbox.ts` (`enviarYRegistrar`, camino de éxito) | Parámetro `automatico?: boolean` (default `false`) que fija el worker de automatizaciones. Origen `ai` / `operator` / `template` de operador. |
| Eco del teléfono | `src/server/inbox/ingest.ts` (rama `origin: "manual"`) | Operador humano desde la app de WhatsApp Business. |
| Cita agendada | `src/server/agenda/service.ts` (`createSessionBooking`) | Cubre operador, bot y agente. No en bloqueos (`createBlock`) ni en reprogramaciones. |
| Venta registrada | `src/server/business/sales-service.ts` (`registerServiceSale`; `updateSale` si cambia el contacto) | El contacto ya se resuelve por id, cita o **teléfono**. Si el lead no tiene monto, se le pone el de la venta (Q5). |

Módulo nuevo `src/server/leads/auto-stage.ts`: `advanceLeadForContact({ organizationId, contactId, rule, amountCents? })` — busca el lead por contacto, resuelve el rol destino a un `stageId`, y llama a `moveLeadToStage` con `onlyIf`.

### 3. Puerta única `moveLeadToStage` (cambios)

- **Candado:** `select … for update` sobre la fila del lead (y de las etapas origen/destino en orden de `id`, para no provocar interbloqueos).
- **`onlyIf(current)`** opcional, evaluado dentro de la transacción tras el candado; si devuelve `false` → `{ ok: true, changed: false }`.
- **`autoRule`** opcional → columna `auto_rule` del evento.
- **`position`** pasa a significar «índice destino en la columna» (0-based, acotado), y la puerta **renumera** (decisión 2):
  - mismo-columna `i → j`: reescribe solo el tramo `[min(i,j), max(i,j)]`;
  - otra columna: la destino desde `j` hasta el final y la origen desde `i` hasta el final (compacta);
  - una sola sentencia `UPDATE lead SET position = v.p FROM unnest($ids, $pos) …`, con `IS DISTINCT FROM` para no reescribir lo que no cambia.
- Tras el commit publica el evento SSE (ver §5). Sigue siendo la **única** que escribe `stage_id` (el guardián `stage-history-guard` se mantiene; la renumeración escribe `position`, no `stageId`).
- **Altas:** `createLeadForContact` pone el lead **arriba** de su columna (`position = min(position) − 1`, O(1), sin renumerar; Q2). La renumeración posterior lo normaliza a 0…n−1.

### 4. API

- **`GET /api/pipeline/board`**
  - Query: `limit` (por columna; default 25, máx 50), `q`, `priority` (`alta|media|baja|sin`), `tag`, `channel`, `since`.
  - Respuesta: `{ currency, serverTime, stages: [{ id, name, position, kind, autoRole, count, sumCents, leads: [...], nextCursor }] }`. `count` y `sumCents` **respetan los filtros** y los calcula el servidor en **una** consulta agrupada (suma solo de leads con la moneda del negocio, como hoy).
  - Con `since`: solo las tarjetas cambiadas (`lead.updated_at > since`, máx 200; `truncated: true` si hay más → el cliente recarga) más `count`/`sumCents` actualizados.
- **`GET /api/pipeline/stages/[id]/leads`**: `cursor`, `limit`, mismos filtros → siguiente página de una columna. Cursor opaco `{p, id}` sobre `(position, id)`, validado con Zod, 422 si está manipulado (misma forma que `inbox-cursor.ts`: `src/lib/pipeline-cursor.ts`).
- **`PATCH /api/pipeline/leads/[id]`**: `position` es el índice destino; la respuesta devuelve `{ lead, stages: [{id, count, sumCents}] }` de las columnas tocadas.
- **`PATCH/POST /api/pipeline/stages`**: aceptan `autoRole` (validado; 409 `role_taken` si otra etapa ya lo tiene; una etapa `won` solo puede ser `client`, una `lost` no tiene rol).
- **Búsqueda (`q`):** `busquedaDeContacto` + `busquedaEnMensajes` (043), las mismas reglas de la Bandeja (nombre, teléfono por dígitos, texto de mensajes con mínimo de 3 letras).
- **Fila de la tarjeta:** misma forma de hoy, sin el `LEFT JOIN conversation` multiplicador: `conversationId` por subconsulta `limit 1` (índice `conversation_org_contact_real_uq`).

### 5. Tiempo real

Eventos nuevos en `src/server/events/bus.ts`:
- `pipeline.lead` `{ leadId, stageId, fromStageId | null }`: lo publica `moveLeadToStage` (todos los caminos: dueño, bot, agente, reglas automáticas, reubicación al borrar etapa), `createLeadForContact` y el `PATCH` de campos (monto/prioridad).
- `pipeline.reordered` `{ stageIds }`: tras una renumeración.
- **No** se publica por la «última actividad» de cada mensaje (provocaría una tormenta con la bandeja activa); esa marca se ve en el siguiente delta o al volver a enfocar la pestaña.

Cliente (`use-events.ts`): `onPipelineLead`, `onPipelineReordered`. Con cualquiera: **un delta agrupado** (250 ms) con `since`; las columnas de `pipeline.reordered` se vuelven a pedir con tantos leads como tengan cargados (máx 200). Con la pestaña oculta no se pide nada; al volver, un delta.

### 6. Cliente

- **`src/lib/pipeline-state.ts`** (puro, sin React): `placeAt(ids, id, index)`, `upsertLead`, `removeLead`, `applyBoardDelta`, `matchesBoardFilters`, `mergeColumnPage`; reutiliza `latestOnly` de `inbox-state.ts` (una respuesta vieja nunca pisa a una nueva).
- **`pipeline-client.tsx`:** estado por columna `{ rows, nextCursor, count, sumCents, loading }`; «Cargar más» al final de cada columna (IntersectionObserver con refs estables, como en la 042); arrastre **optimista** con reordenar dentro de la columna y entre columnas (`SortableContext` de dnd-kit por columna); en error se revierte y se recargan las dos columnas; el diálogo de motivo de pérdida y el de monto siguen igual.
- **Filtros** (barra encima del tablero): búsqueda con debounce (250 ms, input no controlado: no pierde el foco), prioridad, etiqueta y canal con `SearchSelect` (regla del sistema: desplegables con buscador). Los filtros acotan conteos y sumas de cada columna.
- **Cabecera de columna:** conteo y suma desde el servidor (ya no del cliente).
- **Cajón y tarjeta:** muestran «Movido automáticamente: primera respuesta / cita agendada / venta» cuando el último evento tiene `auto_rule`.
- La paginación por «Mostrando X a Y» (`useDataTable`) es para tablas; un kanban pagina por columna con cursor (excepción deliberada, igual que la lista de la Bandeja).

## Migración 0079

- `pipeline_stage.auto_role text null` + `uniqueIndex("stage_org_auto_role_uq").on(organization_id, auto_role).where(auto_role is not null)`.
- `lead_stage_event.auto_rule text null`.
- Backfill de `auto_role` por nombre solo cuando es inequívoco (ver §1).
- Índices: `lead_board_idx (organization_id, stage_id, position, id)` (reemplaza a `lead_org_stage_idx`, que queda cubierto), `lead_org_updated_idx (organization_id, updated_at)` (deltas), y comprobación con `EXPLAIN` de que `contact_tag` y `conversation` ya cubren los filtros.
- **Renumeración de datos existentes:** un `UPDATE` con `row_number() over (partition by stage_id order by position, id)` deja `position` contiguo 0…n−1 en cada columna (hoy puede haber empates).
- Crear índices sin `CONCURRENTLY` bloquea escrituras de `lead` unos instantes; `lead` es una tabla pequeña frente a `message`, riesgo bajo (se avisa igual en el CHANGELOG).

## Plan por archivo

**Base de datos**
- `src/lib/db/schema.ts`: `pipelineStage.autoRole`, `leadStageEvent.autoRule`, índices nuevos; `drizzle/0079_*.sql` + snapshot (generado con `pnpm db:generate`, SQL de backfill y renumeración a mano).
- `src/lib/types.ts`: `AutoStageRole`, `AutoStageRule`, DTOs de tablero paginado.

**Servidor**
- `src/lib/lead-auto-stage.ts` (nuevo, puro): `decideAutoStage`, constantes de reglas y textos.
- `src/lib/pipeline-cursor.ts` (nuevo): codificar/decodificar el cursor.
- `src/server/leads/stage-history.ts`: candado, `onlyIf`, `autoRule`, renumeración, evento SSE.
- `src/server/leads/auto-stage.ts` (nuevo): `advanceLeadForContact`.
- `src/server/leads/board.ts` (nuevo): consultas del tablero (página por columna, conteos/sumas agrupados, delta).
- `src/server/inbox/lead-activity.ts`: alta arriba de la columna; evento SSE de alta.
- `src/server/inbox/outbox.ts`, `src/server/inbox/send.ts`, `src/server/automation/worker.ts`: parámetro `automatico` y gancho `first_reply`.
- `src/server/inbox/ingest.ts`: gancho en el eco.
- `src/server/agenda/service.ts`: gancho `booking`.
- `src/server/business/sales-service.ts`: gancho `sale` (registrar y reasignar).
- `src/server/auth/on-signup.ts`: `SEED_STAGES` con nombres y roles nuevos.
- `src/server/events/bus.ts`: `pipeline.lead`, `pipeline.reordered`.
- `src/app/api/pipeline/board/route.ts` (reescrita), `src/app/api/pipeline/stages/[id]/leads/route.ts` (nueva), `leads/[id]/route.ts` y `stages/route.ts`, `stages/[id]/route.ts` (rol y respuesta con conteos).

**Cliente**
- `src/lib/pipeline-state.ts` (nuevo, puro).
- `src/components/use-events.ts`: dos suscripciones.
- `src/components/pipeline/pipeline-client.tsx` (reescrito), `pipeline-filters.tsx` (nuevo), `stage-manager.tsx` (rol), `lead-drawer.tsx` (traza de la regla).

**Docs:** `CLAUDE.md` (fila del mapa), `AGENTS.md`, `CHANGELOG.md` (incluye el aviso de índices y el cambio de nombres de las etapas sembradas), este `spec.md` al terminar.

## Plan de pruebas

**Unitarias (sin base de datos)**
- `tests/unit/pipeline-auto-stage.test.ts`: `decideAutoStage` en la tabla completa de reglas × etapa × rol × tipo (open/won/lost): solo avanza, `sale` salta desde `new`, no toca `won`/`lost` ni etapas abiertas sin rol (reglas 1 y 2), no retrocede, sin rol destino → `null`.
- `tests/unit/pipeline-cursor.test.ts`: ida y vuelta, rechazo de cursor manipulado.
- `tests/unit/pipeline-state.test.ts`: `placeAt` (mismo lugar, extremos, índice fuera de rango), `applyBoardDelta` (mueve, retira lo que deja de cumplir filtros, no repite), `latestOnly`, conteos locales tras un movimiento optimista.
- `tests/unit/pipeline-seed.test.ts` (existente): nombres y roles sembrados nuevos.
- `tests/unit/stage-history-guard.test.ts` (existente): sigue verde; añade que **ningún otro archivo escribe `autoRole` de un lead ni `position` fuera de la puerta**.

**Contra Postgres real** (`tests/unit/pipeline-tablero-live.test.ts`, con `RUN_DB_TESTS=1`)
1. Cursor por columna sin huecos ni repetidos con 600 leads y posiciones empatadas.
2. Renumeración: 30 movimientos simultáneos (`Promise.all`) a la misma columna dejan `position` contiguo 0…n−1, **sin duplicados**, y un evento de bitácora por cambio de etapa.
3. Mover dentro de la misma columna reescribe solo el tramo afectado (se cuenta cuántas filas cambiaron).
4. Dos movimientos simultáneos del mismo lead: un solo evento válido (candado).
5. Filtros (`q` por nombre, teléfono y texto de mensaje; prioridad; etiqueta; canal) y que conteos/sumas del servidor coinciden con lo que devuelve la lista.
6. Delta con `since`: detecta movimiento, monto, prioridad y alta; no devuelve lo que no cambió; `truncated` con más de 200.
7. **Reglas automáticas de punta a punta** con las funciones reales: primer envío de operador → `conversation`; envío de automatización → no mueve; Laboratorio (`is_test`) → no mueve; cita agendada desde «Nuevo» y desde «En conversación» → `interested`; venta por teléfono desde «Nuevo» → `client` (salto directo); venta en lead ya `client`/`lost` → no mueve; las tres dos veces seguidas → un solo evento (idempotencia); evento con `auto_rule` y `source = 'sistema'`; etapa sin rol → no mueve; sin etapa destino → no mueve y no falla.
8. Multi-tenencia: un rol de otra organización jamás se usa; el cursor de una organización no lee otra.
9. Planes (`EXPLAIN`) con 5 000 leads: la página de columna usa `lead_board_idx` sin `Sort`; el delta usa `lead_org_updated_idx`.
10. Migración: el backfill asigna roles solo cuando es inequívoco y renumera columnas con empates.

**De punta a punta** (`scripts/e2e-pipeline-tablero.mjs`, `pnpm test:e2e:pipeline-tablero`; con la app viva y los mocks)
- Siembra 400 leads en 4 columnas: cada columna abre con 25, «Cargar más» trae las siguientes sin repetir y los contadores dicen el total real.
- Arrastrar dentro de una columna y entre columnas: el orden sobrevive a recargar; conteos y sumas correctos.
- Búsqueda por nombre y por una palabra que solo vive en un mensaje; filtros de prioridad y etiqueta; el input conserva el foco.
- Tiempo real: un movimiento hecho por la API desde otro contexto aparece sin recargar; ráfaga de 10 movimientos = pocas peticiones (no una por evento).
- **Reglas automáticas con la app real:** el operador responde desde el compositor de la Bandeja → el lead pasa de «Nuevo» a «En conversación»; agendar una cita (API del bot) → «Interesado»; cobrar en Caja con el teléfono del contacto → «Cliente»; un lead en «Nuevo» con pago inmediato salta a «Cliente».
- Camino infeliz: un envío fallido no mueve; una venta sin lead no crea uno ni falla.
- Regresión: `e2e-bandeja-escala` y `e2e-bandeja-envio` siguen verdes.

**Puerta final:** `pnpm typecheck && pnpm lint && pnpm build && pnpm test`, `pnpm test:db` (los 7 fallos previos de `meta-ads-live` no cuentan), E2E del paquete y de regresión, y revisión de capturas.

## Riesgos y compatibilidad

- **Cambio de contrato** de `GET /api/pipeline/board` (paginado por columna) y de `position` (índice, no «cantidad»). El único consumidor es `pipeline-client.tsx`; el bot y el agente mueven por `moveLeadToStage` sin pasar posición.
- **Costo de renumerar:** O(tramo afectado) por movimiento. Con columnas de miles de leads sigue siendo una sola sentencia indexada; las altas no renumeran (entran arriba con `min − 1`).
- **Etapas existentes:** el backfill por nombre puede no reconocer columnas con nombres propios; esas organizaciones quedan sin reglas automáticas **hasta que el dueño asigne los roles** (un aviso en el gestor de etapas lo indica). Es el comportamiento seguro: preferimos no mover que mover mal.
- **Reporte a Meta:** un salto automático a «Cliente» (`won`) dispara el evento de compra de CAPI como cualquier movimiento a `won`; si el lead no tenía monto, la venta se lo pone (Q5) para que el evento lleve valor.
- **Eco y plantillas:** contar el eco del teléfono y las plantillas de operador como «respuesta» es una decisión de negocio (Q3).
- Todo se probará contra el mock de Meta y con datos sembrados, no con volumen real de producción.

## Fuera de alcance (fases posteriores)

Responsable del lead; varios pipelines; fecha de cierre y seguimiento; tareas y notas; probabilidad por etapa y total ponderado; acciones en lote; vistas guardadas; reapertura automática de un lead ganado/perdido que vuelve a escribir; retroceso automático de etapa.

## Preguntas de revisión (con el valor que usaré si no se contestan)

- **Q1.** ¿Renombrar las etapas de los negocios existentes a «Nuevo / En conversación / Interesado / Cliente»? **Recomendado: no** (solo asignarles el rol por equivalencia: Contactado→En conversación, Citado→Interesado, Convertido→Cliente); los negocios nuevos nacen con los nombres nuevos.
- **Q2.** ¿Un lead nuevo entra **arriba** o **abajo** de su columna? **Recomendado: arriba** (con paginación, abajo quedaría en la última página y las altas no costarían renumeración).
- **Q3.** ¿Cuenta como «primera respuesta» una **plantilla de un operador** y el **eco** de la app del teléfono? **Recomendado: sí** (son respuestas humanas); los flujos automáticos y el Laboratorio no cuentan.
- **Q4.** Una venta en Caja de un contacto **sin lead** (cliente de mostrador): ¿crear el lead directamente en «Cliente»? **Recomendado: no** (hoy esos clientes no están en el embudo; crearlos inflaría «prospectos» y cambiaría Resultados).
- **Q5.** Si el lead no tiene monto, ¿la venta le pone el suyo al pasar a «Cliente»? **Recomendado: sí, solo si estaba vacío** (el evento de compra a Meta lleva valor y el total de la columna es real).
- **Q6.** Un lead **perdido** (`lost`) que agenda una cita o paga: ¿se reabre solo? **Recomendado: no** en este paquete (queda como reapertura manual; propuesta para la fase de gestión comercial).
- **Q7.** Tamaño de página por columna: **25** (máx 50). ¿Prefieres otro?
