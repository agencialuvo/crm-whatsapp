# Feature Specification: Automatizaciones — Fase 5 (constructor visual con `@xyflow/react`)

**Feature Branch**: `main` (incremental, detrás de `AUTOMATIONS`)

**Created**: 2026-11-14

**Status**: Fase 5 implementada; typecheck, lint, build, vitest y pruebas contra Postgres real en verde
(`automation-canvas.test.ts`, `automation-canvas-ui.test.ts`, `automation-canvas-live.test.ts`) y el lienzo verificado
renderizado en un navegador real (carga, paleta, panel, conexión, guardado y bloqueo de «volver a Simple»).
Sin commit (pendiente de revisión).

**Carril**: ciclo completo (Principio VI). Migración **aditiva** `0071`: tres columnas en `automation_flow` (`editor_mode`
con valor por defecto, `viewport` y `entry_step_id`, ambas nullable). Todo flujo existente nace `simple` y se comporta
exactamente igual. No cambia ningún contrato publicado (`/api/bot/*`, despacho, webhooks, `/api/health`); la API de
automatizaciones **gana** `PUT /api/automations/[id]/graph` y `POST /api/automations/[id]/mode`. Construye sobre las
Fases 1–4 ([032](../032-automatizaciones-citas/spec.md) · [033](../033-automatizaciones-etiquetas-condiciones/spec.md) ·
[034](../034-automatizaciones-grafo/spec.md) · [035](../035-automatizaciones-espera-respuesta-anuncios/spec.md)).

## El problema

El motor ya ejecuta un **grafo** (aristas por asa, ejecuciones, esperas), pero la única forma de armarlo es una lista
lineal: la condición solo puede «continuar / saltar uno / terminar» y no hay forma de decir «si confirma ve al paso 5;
si no responde, ve al paso 8». Un negocio quiere **dibujar** el flujo, ver las ramas y reorganizarlas.

## Qué entrega la Fase 5

| Pieza | Qué hace |
|---|---|
| **Modo de edición del flujo** | `automation_flow.editor_mode` (`simple` por defecto · `canvas`), más `viewport` (JSON) y `entry_step_id`. |
| **Modo Visual** | Lienzo `@xyflow/react`: paleta con arrastrar y soltar, nodos por tipo con sus asas etiquetadas, panel de configuración a la derecha, mapa, zoom, cuadrícula, «cambios sin guardar». |
| **`PUT /api/automations/[id]/graph`** | Guarda nodos, aristas, disparador y viewport en **una transacción**, con control de concurrencia optimista (`updated_at`) y validación de topología. |
| **`POST /api/automations/[id]/mode`** | Cambia entre Modo Simple y Visual. Simple → Visual convierte con las aristas compiladas y un auto-orden; Visual → Simple **solo si la topología es representable en lista** (si no, se bloquea y se explica por qué). |
| **Validación compartida** | `validateGraph` (función pura en `src/lib/`) corre en vivo en el cliente y otra vez en el servidor antes de guardar. |
| **Nodos y panel** | Disparador, mensaje, espera, condición, esperar respuesta, acción. El panel reutiliza el formulario de `step-dialog.tsx` (sin modal). |

## Decisiones

- **D1 — Dos modos, una sola fuente de verdad (las aristas).** En `simple`, las aristas se **derivan** de la lista
  (`compileLinearEdges`, como hasta ahora) y la posición `y` de los pasos **es** el orden de ejecución. En `canvas`, las
  aristas son lo que el usuario dibuja y las posiciones son **solo visuales**.
- **D2 — Coordenadas: `automation_step.position_x/y` (ya existen, enteros) y `automation_flow.viewport`.** El motor
  jamás lee las posiciones para ejecutar en modo `canvas`: sigue las aristas y entra por `entry_step_id`. Por eso un
  paso puede estar en cualquier `(x, y)` sin afectar la ejecución. Compatibilidad en los dos sentidos: (a) el orden por
  posición solo se usa en `simple` (entrada del flujo y compilación); (b) al volver a `simple` las posiciones se
  **normalizan** a una columna en el orden de ejecución (`x = 0`, `y = i × 100`), así que el orden por posición coincide
  con la topología. (c) El disparador no es un paso: su posición vive en `viewport.trigger = { x, y }` junto con
  `{ x, y, zoom }` de la cámara. Las coordenadas se redondean a entero y se acotan a ±100 000 (el contrato que ya tenía
  `automation_step`).
- **D3 — El disparador es un nodo virtual.** Hoy el disparador es `trigger_type` + `trigger_config` del flujo, no un
  paso. En el lienzo aparece como el nodo `trigger`; su única arista de salida marca **el paso de entrada**
  (`entry_step_id`). «Único disparador» se valida contando nodos `trigger` (exactamente uno). Soltar otro disparador de la
  paleta **reemplaza** el actual (cambia `trigger_type`/`trigger_config` al guardar).
- **D4 — Entrada del flujo.** `simple`: el primer paso en el orden del lienzo (igual que antes). `canvas`:
  `entry_step_id` (FK `ON DELETE SET NULL`); sin entrada, el flujo no arranca nada (el disparador no tiene a dónde ir).
- **D5 — Convivencia Simple ⇄ Visual.**
  - *Simple → Visual*: automático al abrir el lienzo. `editor_mode = canvas`, `entry_step_id` = primer paso, las aristas
    compiladas pasan a ser las dibujadas, los pasos reciben posiciones del auto-orden por niveles.
  - *Visual → Simple*: `toLinear` recorre el camino principal desde la entrada, deriva `ifTrue`/`ifFalse`/`lateAction`/
    `onX` de cada rama (siguiente = `continue`, el de después = `skip_next`, sin arista = `stop`), y **comprueba** que
    recompilar esa lista reproduce EXACTAMENTE las aristas. Si no (hay saltos hacia atrás o a pasos lejanos, un paso
    inalcanzable, un ciclo…), responde 409 `graph_not_linear` con los motivos y **no toca nada**. No existe «forzar»:
    destruir la topología dibujada no tiene vuelta atrás.
- **D6 — Mientras un flujo es `canvas`, la API de pasos de la lista se bloquea (409 `canvas_mode`)** para crear,
  editar o borrar pasos: si no, una edición desde la lista dejaría un paso huérfano o desfasado. La lista (Modo Simple)
  muestra un aviso con el botón de volver a Simple. Renombrar, encender/apagar y editar los ajustes del disparador (PATCH
  del flujo) siguen funcionando.
- **D7 — Guardado atómico y optimista.** El `PUT` toma `FOR UPDATE` la fila del flujo, compara `updated_at` con el
  `expectedUpdatedAt` que el cliente cargó (409 `stale_graph` si alguien guardó antes) y, dentro de la misma
  transacción: valida, inserta/actualiza/borra pasos, **reescribe** las aristas, actualiza disparador, entrada, viewport
  y `updated_at`. Un fallo a la mitad no deja nada a medias. Se compara en JS (no en SQL) porque `now()` de Postgres
  tiene microsegundos y un `Date` de JS, milisegundos.
- **D8 — Ids de nodos nuevos.** El cliente crea nodos con ids temporales (`new_…`); el servidor les asigna ids reales,
  remapea las aristas y devuelve el grafo guardado. Los ids existentes se conservan (las ejecuciones en curso apuntan a
  ellos). Un paso que ya no está en el payload se borra y **cancela las ejecuciones que estaban en él** (igual que
  `deleteStep`).
- **D9 — Validación de topología (errores bloquean, avisos no).**
  - *Errores* (422 `invalid_graph`): no hay exactamente un disparador; ids repetidos; una arista a un nodo inexistente o
    desde un asa que ese tipo no tiene (`condition`: `true`/`false`; `wait_reply`: cinco intenciones; `wait_until`:
    `default`/`late`; el resto: `default`); dos aristas por la misma asa; el disparador con más de una salida; **un ciclo
    que no atraviesa ninguna espera** (`delay`, `wait_until`, `wait_reply`: sin esa condición, el ciclo giraría sin parar
    en la cola); `wait_until` o «la cita está confirmada» en un flujo cuyo disparador no es de cita; más de 50 nodos;
    una configuración que su esquema rechaza o una etiqueta/etapa/plantilla ajena.
  - *Avisos* (se guarda igual, se muestran claros): nodos **inalcanzables** desde el disparador (nunca se ejecutan); una
    salida de un nodo ramificado sin conectar («la rama “No” termina el flujo»); un ciclo (repite pasos hasta que algo lo
    corte); sin paso de entrada.
  Un ciclo con espera es válido: «si no responde, recuérdale y vuelve a esperar».
- **D10 — Reglas de la API de ejecución no cambian.** El intérprete, las ejecuciones, `resolveReplyWait` y
  `completeAndAdvance` ya trabajan sobre aristas: el lienzo solo escribe las aristas y la entrada.
- **D11 — `ensureEdges`, `syncEdges` y el respaldo de `resolveNextStep` solo actúan en `simple`.** En `canvas` las
  aristas guardadas son la verdad, incluso si están vacías.
- **D12 — «Enviar multimedia» aparece en la paleta como «Próximamente».** El motor aún no envía medios; un bloque que
  se guarda y no hace nada es peor que no ofrecerlo (misma regla que la Fase 1).
- **D13 — Cargado dinámico.** `@xyflow/react` (12.12) se importa con `next/dynamic(..., { ssr: false })` solo al abrir el
  Modo Visual: el resto de Automatizaciones no paga su peso.
- **D14 — Edición en el panel = el mismo formulario.** `StepDialog` gana un modo `inline` (sin `Modal`, con
  `onApply(config)` en vivo cuando la configuración es válida): una sola fuente de reglas de formulario para el diálogo
  y el panel.

## Idempotencia y resiliencia

- Guardar dos veces el mismo grafo no cambia nada (ids estables, aristas reescritas a lo mismo).
- Dos pestañas: la segunda recibe 409 `stale_graph` y recarga; nunca se pisan en silencio.
- Un flujo en vuelo no se rompe al editar: las ejecuciones siguen las aristas **de ese momento** al avanzar su siguiente
  paso; una ejecución parada en un paso borrado se cancela.

## Fuera de alcance

Deshacer/rehacer · copiar y pegar nodos · «Enviar multimedia» (D12) · abanicos (varias aristas por asa) · varias
entradas · edición colaborativa en vivo · modo de solo lectura para miembros sin permiso (la ruta ya exige dueño o
administrador) · pruebas E2E de arrastre (regla del proyecto: sin E2E).

---

# Plan de cambios por archivo

## 1. Base de datos (`drizzle/0071_…`)
`automation_flow.editor_mode` (`simple`|`canvas`, default `simple`, NOT NULL) · `viewport` (jsonb) · `entry_step_id`
(FK a `automation_step`, `ON DELETE SET NULL`). Migración generada y aplicada.

## 2. Reglas puras (`src/lib/automation-graph.ts`, nuevo)
`graphPayloadSchema` (Zod, contrato del `PUT`) · `HANDLES_BY_STEP` · **`validateGraph`** (errores y avisos) ·
**`toLinear`** (grafo → lista, con verificación) · **`autoLayout`** (niveles) · `normalizeColumn`.

## 3. Servidor (`src/server/automation/`)
| Archivo | Cambio |
|---|---|
| `graph.ts` | `entryStepId` por modo; `ensureEdges`/`resolveNextStep`/`syncEdges` respetan `canvas`; `getGraph` devuelve modo, viewport, disparador y `updatedAt`; **`saveGraph`** (el `PUT`); **`setEditorMode`**. |
| `flows.ts` | Bloqueo de la API de pasos en `canvas` (D6); `serializeFlow` expone `editorMode`. |
| `api/automations/[id]/graph/route.ts` | `PUT`. |
| `api/automations/[id]/mode/route.ts` (nuevo) | `POST`. |

## 4. Pantallas (`src/components/automatizaciones/canvas/`)
`flow-canvas.tsx` · `node-palette.tsx` · `use-flow-graph.ts` · `nodes/{trigger,message,wait,condition,wait-reply,action}-node.tsx`
(+ `node-shell.tsx`) · `inspector/{inspector-panel,trigger-inspector}.tsx` · `flow-detail-client.tsx` (selector
Simple/Visual) · `step-dialog.tsx` (modo `inline`).

## 5. Pruebas (Vitest; sin E2E por regla del proyecto)
`automation-canvas.test.ts` (validación de topología, ciclos con/sin espera, `toLinear`, `autoLayout`, esquema del
payload) · `automation-canvas-live.test.ts` (Postgres real: `PUT` atómico y concurrencia optimista, ids nuevos,
borrado que cancela ejecuciones, el motor ejecuta un grafo dibujado con ramas y ciclo, conversión Simple ⇄ Visual,
bloqueo de la API de pasos, aislamiento entre organizaciones).

# Puntos de acoplamiento con las Fases 1–4

| Punto | Qué pasa |
|---|---|
| `compileLinearEdges` / `syncEdges` (F3) | Siguen siendo el Modo Simple; `syncEdges` se hace inerte en `canvas`. |
| `entryStepId` (F3) | Pasa a depender del modo; el resto del intérprete no cambia. |
| `step-dialog.tsx` (F1–F4) | Se reutiliza tal cual en el panel (modo `inline`); sus validaciones no se duplican. |
| `condition` `ifTrue`/`ifFalse`, `wait_reply` `onX`, `wait_until` `lateAction` (F2–F4) | En `canvas` las aristas mandan y esos campos quedan como están; al volver a Simple se **re-derivan** de las aristas. |
| `deleteStep` cancela ejecuciones (F3) | El `PUT` hace lo mismo con los pasos que desaparecen. |
| `assertTemplateOwned`/`assertRefsOwned`/`assertConditionFitsFlow` (F2) | El `PUT` las aplica a cada nodo. |
| `flowPatchSchema` no cambia `triggerType` (F0) | El `PUT` sí puede, **solo** desde el nodo disparador del lienzo (D3). |

# Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Bucle infinito en la cola | D9: un ciclo sin espera es un error de validación en cliente y servidor; con espera, solo aviso. |
| Pisar cambios de otra pestaña | D7: `FOR UPDATE` + `updated_at` esperado; 409 `stale_graph`. |
| Guardado a medias | Todo en una transacción; prueba de que un grafo inválido no deja rastro. |
| Destruir la topología al volver a Simple | D5: `toLinear` verifica por recompilación; sin «forzar». |
| Ejecuciones en curso al editar | D8: ids estables; las parados en pasos borrados se cancelan. |
| Una edición desde la lista rompe un flujo `canvas` | D6: la API de pasos se bloquea con un mensaje claro. |
| Peso del lienzo en el resto de la app | D13: carga dinámica sin SSR solo al abrir el Modo Visual. |
| El formulario del panel diverge del diálogo | D14: un solo componente con dos presentaciones. |
