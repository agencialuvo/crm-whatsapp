# 041 — Envío robusto y reconciliación de estados

**Feature Branch**: `feat/041-envio-robusto-y-estados`

**Created**: 2026-11-17

**Status**: **Implementada** (2026-11-17), con las cuatro preguntas de revisión resueltas (Q1 dejar el texto en el compositor y la burbuja `failed`; Q2 una fila `failed` por reintento de automatización; Q3 `failed` con aviso, sin estado `unknown`; Q4 búfer en tabla). Pendiente de commit. Verificada contra el mock de Graph y Postgres real; **no contra la Graph API real**.

Ajustes que salieron al implementar (respecto del texto de abajo):
- **La prueba de 300 carreras encontró un hueco del protocolo D2** que la lectura no vio: si el emisor guardaba el id ENTRE la primera búsqueda del webhook y su comprobación de «¿existe ya?», el webhook daba el estado por aplicado (existía la fila) y lo perdía. Ahora, si tras fallar la aplicación el mensaje ya existe, el webhook **vuelve a aplicar** en vez de retornar. Sin esa segunda pasada fallaban 146 de 300 carreras; con ella, 0 en cada corrida.
- El rango SQL y `isUpgrade` salen de la MISMA tabla (`STATUS_RANK`) y una prueba recorre las 20 parejas de estados.
- `SendError` pasó a `send-error.ts` (lo reexporta `send.ts`) para que `outbox.ts` no importe `send.ts`.
- Perillas de prueba, solo para los guiones E2E: `META_GRAPH_TIMEOUT_MS` (por omisión 30 000 al enviar; las lecturas esperan el doble) y `OUTBOX_SWEEP_AFTER_MS` (por omisión 180 000). El mock de Graph gana `POST /api/dev/wa-mock/modo` (`normal`, `estadoprimero`, `fallo`, `colgado`).
- Las llamadas de lectura de la Marketing API (038–040) ganan un tiempo máximo de 60 s, que antes no tenían.
- El texto de la ambigüedad es «Meta no respondió a tiempo: el mensaje pudo haber salido. Verifica en la conversación o en Meta antes de reenviarlo»; el de la barredera, «No se pudo confirmar el envío … Posible envío incompleto: verifica en la conversación o en Meta antes de reenviar».
- Instagram, Messenger y TikTok comparten el camino (fila `pending` → `sent` al aceptar), pero no tienen búfer: no emiten acuses de salientes. Sus transportes (Zernio) siguen sin tiempo máximo propio; si uno se cuelga, la barredera cierra la fila a los 3 minutos.

**Input**: Paquete 2 del análisis de la Bandeja (hallazgos 3 y 4). El Paquete 1 (errores del compositor, códigos
HTTP de plantillas, variables) es independiente de esta spec.

**Carril**: ciclo completo (Principio VI). **Toca el modelo de datos** (una tabla y un índice, migración aditiva) y
el camino de envío de TODOS los canales. No cambia ningún contrato publicado: el DTO del mensaje, los eventos SSE
y las rutas HTTP quedan igual.

## Problema

**P1 — Un estado puede perderse y el mensaje queda con el reloj para siempre.** Hoy el `wa_message_id` solo existe
en la base DESPUÉS de que Graph responde y se hace el `INSERT` (`persistOutbound` en `send.ts`, y su copia en
`templates.ts`). Si Meta manda el webhook `sent` o `delivered` en ese intervalo, `applyStatusUpdate` hace
`SELECT … WHERE wa_message_id = …`, no encuentra nada y retorna sin guardar el estado. No hay reintento: Meta no
repite un estado entregado con 200. El mensaje se queda en `pending` aunque el cliente ya lo leyó.

**P2 — Un envío puede salir sin quedar registrado, y los fallos se tratan distinto según el tipo.**

| Tipo | Si Graph falla | Si Graph acepta pero la base falla |
|---|---|---|
| Texto (`sendText`) | No queda fila. El texto vuelve al compositor | Salió y la bandeja no lo tiene |
| Plantilla (`sendTemplate`) | No queda fila | Igual |
| Ubicación y contacto (`sendStructured`) | No queda fila | Igual (y el adjunto no se guarda) |
| Adjunto (`sendMediaMessage`) | Fila `failed` con el motivo | Fila no guardada, archivo sí |

Efecto secundario: la tarjeta de higiene de Resultados (`hygiene.ts`) cuenta mensajes `failed`, así que hoy
subcuenta los fallos de texto, plantilla, ubicación y contacto.

## Por qué «insertar primero en pending» NO basta por sí solo

Conviene decirlo antes del diseño porque cambia el plan. Insertar la fila antes de llamar a Graph deja la fila
con `wa_message_id = NULL`. El `wa_message_id` solo se conoce cuando Graph responde, y hay que escribirlo con un
`UPDATE`. Si el webhook llega entre la respuesta de Graph y ese `UPDATE`, el `SELECT … WHERE wa_message_id = …`
sigue sin encontrar la fila: **la ventana se queda igual de corta, pero existe.** Insertar primero arregla P2
(nada se pierde, todo intento queda registrado), no P1. Para P1 hace falta además un mecanismo de reconciliación
(D2).

## Decisiones

**D1 — Intención primero: la fila existe antes de llamar a nadie.**
Tras el pre-vuelo (`prepareSend`) y antes de la llamada al transporte se inserta la fila `out` en `pending`, con
`wa_message_id` NULL, su texto o adjunto, y se publica `message.new`. Reglas:

- **Un rechazo del pre-vuelo no crea fila** (`window_closed`, `text_too_long`, `message_limit`, `not_connected`,
  `reconnect_required`, `sandbox_violation`): no se intentó nada, y el operador ya ve el motivo. Es el
  comportamiento de hoy.
- **Un intento que falla deja fila `failed`** con el motivo ya traducido (`describeSendError` / mensajes de
  `SendError`), en los cuatro tipos y en los cuatro canales. `SendError.messageId` se llena siempre.
- **Un intento que acepta** guarda el `wa_message_id` en la misma fila (`UPDATE … WHERE id = … AND wa_message_id
  IS NULL`). Hasta que llegue un acuse, WhatsApp queda en `pending`; Instagram, Messenger y TikTok (sin acuses,
  `deliveryReceipts: false`) pasan a `sent` en ese mismo `UPDATE` y publican `message.status`.
- La hora del mensaje (`created_at`) pasa a ser la de la **intención**, no la de la respuesta de Meta: el orden
  del hilo ya no depende de cuánto tarde Graph.
- `conversation.last_message_at` se actualiza al insertar la intención.
- Si el `UPDATE` que guarda el `wa_message_id` falla, se reintenta 3 veces (0, 150 y 600 ms). Si sigue fallando
  se registra en el log con el id de Meta y la fila queda como la de un intento sin confirmar (D6). Es el único
  hueco que queda, y exige que la base falle justo después de aceptar Meta.

**D2 — Estados que llegan antes de tiempo se guardan y se aplican después (búfer de huérfanos).**
Tabla nueva `message_status_orphan` (D8). Protocolo, con cada lado «escribe y luego lee» para que al menos uno
de los dos vea al otro, sin transacciones ni candados largos:

- **Webhook** (`applyStatusUpdate`): intenta aplicar el estado a la fila con ese `wa_message_id`. Si no hay fila,
  **guarda el estado en el búfer y VUELVE a buscar la fila.** Si ahora existe (el emisor ganó la carrera
  mientras tanto), lo aplica y borra el huérfano.
- **Emisor** (tras guardar el `wa_message_id`): lee el búfer de ese id; si hay un estado esperando, lo aplica
  con la misma función y lo borra.
- Si los dos lados llegan a verlo, el estado se aplica dos veces: es inocuo porque la aplicación es monótona
  (D3).
- El búfer guarda **un solo estado por mensaje**: el de mayor rango (`failed` gana a todo). Un `sent` seguido de
  un `delivered` antes del registro deja `delivered`.
- Lo mismo sirve para los **ecos de coexistencia** (`ingestManualEcho`): su fila también se inserta tras el
  evento, así que tras insertarla se reclaman estados huérfanos.
- Los huérfanos de más de 24 h se borran (D6): son estados de mensajes que nunca existieron aquí.

**D3 — Aplicar un estado es una sola sentencia atómica.**
Hoy `applyStatusUpdate` hace `SELECT` (compara en JavaScript) y luego `UPDATE`: dos acuses simultáneos
(`delivered` y `read`) pueden pisarse y dejar el menor. Pasa a un `UPDATE … WHERE` con el rango del estado
actual comparado en SQL (`CASE status WHEN 'pending' THEN 0 …`), `RETURNING id, conversation_id`.
La regla no cambia —monótona, `failed` desde cualquier estado una sola vez—; solo deja de depender de quién
llega primero. `isUpgrade` se conserva como la fuente de la regla (la prueba de SQL la contrasta).

**D4 — Un solo camino para todo envío.**
Un helper `enviarYRegistrar` (en `src/server/inbox/outbox.ts`) encapsula D1: inserta la intención, llama al
transporte que le pasan, y confirma o marca el fallo. `sendText`, `sendMediaMessage`, `sendStructured` y
`sendTemplate` lo usan; desaparecen `persistOutbound` y la copia de `templates.ts`. El adjunto y la ubicación
guardan su `media_asset` ANTES de la llamada (como hoy lo hace el adjunto), de modo que la burbuja `failed`
también los muestra.

**D5 — Un tiempo de espera donde hoy no hay ninguno, y un fallo ambiguo se dice como tal.**
`graphRequest` (`src/lib/meta/client.ts`) no tiene tiempo máximo: una llamada colgada deja la fila en `pending`
sin límite. Se le pone `AbortSignal.timeout(30 s)`. Un tiempo agotado es **ambiguo** (Meta pudo haber aceptado el
mensaje): `MetaApiError` gana `ambiguous: true` y el mensaje de la fila `failed` dice «Meta no respondió a tiempo;
el mensaje pudo haber salido. Revisa la conversación en el teléfono antes de reenviarlo». Un error de conexión
(DNS, rechazo) NO es ambiguo y conserva su texto actual.

**D6 — Una barredera rescata lo que ninguna respuesta va a cerrar.**
`sweepOutbox()` corre cada 60 s (siempre encendida: es del núcleo, no un módulo opcional; se arranca desde
`instrumentation-node.ts` como los demás temporizadores y un fallo nunca tumba el arranque):

- Filas `out`, `pending`, `wa_message_id IS NULL`, de más de **3 minutos** (el doble del tiempo máximo de D5),
  de conversaciones reales → `failed` con «No se pudo confirmar el envío (el servidor se reinició o Meta no
  respondió). Puede que sí haya salido: revisa antes de reenviar». Cubre el reinicio del proceso entre la
  intención y la respuesta.
- Huérfanos de más de 24 h → borrados.
- Idempotente y sin candado largo (un `UPDATE … RETURNING` por tanda de hasta 200); publica `message.status`
  por cada fila rescatada.

**D7 — Los reintentos de las automatizaciones dejan rastro.**
Un paso de automatización que falla con error transitorio se reintenta (`engine.ts`), y cada intento fallido
dejará ahora su fila `failed` en el hilo, como ya pasa con los adjuntos. Es lo honesto (fue un intento real) y
lo más simple, a costa de algo de ruido. Si resulta molesto se añade una opción `registrarFallo: false` al
worker en otra spec; no se hace ahora.

**D8 — Datos.**

```ts
// message_status_orphan: un estado que llegó antes que su mensaje.
id            text pk              // prefijo "mso"
organization_id text not null → organization (cascade)
wa_message_id text not null        // único: un estado por mensaje
status        text not null        // sent | delivered | read | failed
error         text                 // ya traducido, solo con failed
received_at   timestamp not null default now()
unique (wa_message_id)
index (received_at)                // la poda
```

Más un índice parcial en `message` para la barredera:
`(created_at) WHERE direction = 'out' AND status = 'pending' AND wa_message_id IS NULL`.
Migración `0076` generada con `pnpm db:generate`; aditiva (tabla e índice nuevos), re-ejecutable, se aplica al
arrancar el contenedor. Sin bandera: no es un módulo opcional.

## Plan por archivo

| Archivo | Cambio |
|---|---|
| `src/lib/db/schema.ts` | Tabla `messageStatusOrphan` e índice parcial en `message`. |
| `src/lib/db/ids.ts` | Prefijo `messageStatusOrphan: "mso"`. |
| `drizzle/0076_*.sql` + snapshot | Generada. |
| `src/lib/meta/client.ts` | Tiempo máximo de 30 s en `graphRequest`; `MetaApiError.ambiguous`. |
| `src/server/inbox/outbox.ts` (**nuevo**) | `registrarIntento`, `confirmarEnvio` (con los 3 reintentos y la reclamación de huérfanos), `registrarFallo`, `enviarYRegistrar`, `sweepOutbox`. |
| `src/server/inbox/status.ts` | `applyStatusUpdate` atómico (D3) con `parkOrphan` + nueva búsqueda (D2); `reclaimOrphanStatus(org, waMessageId)`; `isUpgrade` se conserva. |
| `src/server/inbox/send.ts` | `sendText`, `sendMediaMessage` y `sendStructured` sobre `enviarYRegistrar`; se elimina `persistOutbound`. `callGraphSend` y los tres transportes de canal no cambian de firma; la clasificación de errores sí propaga `ambiguous`. |
| `src/server/whatsapp/templates.ts` | `sendTemplate` sobre `enviarYRegistrar`; se elimina el `INSERT` propio. |
| `src/server/inbox/ingest.ts` | Tras insertar un eco, `reclaimOrphanStatus`. |
| `src/instrumentation-node.ts` | `resumeOutboxSweeper()`: arranca el temporizador de `sweepOutbox`. |
| `src/app/api/dev/wa-mock/graph/[...path]/route.ts` | Comportamientos de prueba (abajo). |
| `src/components/inbox/inbox-client.tsx` | Sin cambios de lógica: la fila `failed` llega por SSE y la burbuja provisional se empareja con ella por texto, como con cualquier mensaje real. A comprobar en el E2E. |
| `CLAUDE.md`, `CHANGELOG.md`, `AGENTS.md` | La fila de «ingesta/envío de mensajes» pasa a nombrar `outbox.ts`, el búfer y la barredera. |

No se tocan: los webhooks de Instagram/Messenger/TikTok (no emiten acuses de salientes), las rutas HTTP, el DTO,
`message-thread.tsx` (ya pinta `failed` con su motivo).

## Pruebas

**Unitarias puras** (`tests/unit/envio-robusto.test.ts`, entran en `pnpm test`):

- Qué rechazos del pre-vuelo NO crean fila y cuáles intentos sí (tabla de códigos de `SendError`).
- `MetaApiError.ambiguous` solo para el tiempo agotado; el texto de cada caso.
- El rango SQL y `isUpgrade` coinciden para todas las parejas de estados (se genera la tabla en la prueba).
- Reintentos de `confirmarEnvio`: éxito al segundo intento, fracaso tras tres, con reloj simulado.

**Contra Postgres real** (`tests/unit/envio-robusto-live.test.ts`, `RUN_DB_TESTS=1`, mismo patrón que las suites
`*-live`; crea sus datos y los borra):

1. **Estado antes del id.** Fila `pending` sin id; llega `delivered`; no hay fila → queda en el búfer; se guarda
   el id → se reclama y la fila queda `delivered`; el búfer vacío.
2. **Las dos interleavings del protocolo D2.** Con ganchos de prueba que pausan cada lado en el punto exacto:
   (a) el webhook pierde el `SELECT`, el emisor guarda el id y lee el búfer vacío, el webhook estaciona y vuelve a
   buscar → debe encontrarla; (b) el emisor guarda el id ANTES de que el webhook estacione → el webhook encuentra
   la fila en el primer intento. En ambas, estado final correcto.
3. **Carrera aleatoria**: 300 pares (webhook, confirmación) lanzados con `Promise.all` y retrasos aleatorios;
   todas terminan con el estado esperado y ningún huérfano vivo.
4. **Monotonía bajo concurrencia**: `delivered` y `read` simultáneos, 200 veces, siempre `read`. `failed` tras
   `read` se aplica una sola vez; un `sent` tardío no degrada.
5. **Un solo estado por mensaje en el búfer**: `sent` → `delivered` → `read` antes del registro dejan `read`;
   `failed` gana siempre.
6. **Fallos por tipo** (Graph simulado que rechaza): texto, plantilla, ubicación, contacto y adjunto dejan una
   fila `failed` con el motivo y `SendError.messageId`; ningún rechazo de pre-vuelo deja fila; el adjunto y la
   ubicación fallidos conservan su `media_asset`.
7. **Graph acepta, la base falla al guardar el id**: la fila no se pierde, queda como intento sin confirmar y el
   log lleva el id de Meta.
8. **Barredera**: voltea la fila vieja sin id; deja la reciente, la que ya tiene id, la de conversación de prueba
   y la de otra organización con estado ajeno; poda huérfanos de más de 24 h; dos pasadas seguidas no repiten
   eventos.
9. **Eco de coexistencia con estado anticipado**: el estado llegó antes del eco → queda aplicado.
10. **Multi-tenancy**: un estado de un `wa_message_id` ajeno no toca filas de otra organización.

**E2E contra el mock** (`pnpm test:e2e:bandeja-envio`, `scripts/e2e-bandeja-envio.mjs`, mismo estilo que
`e2e-medios.mjs`/`e2e-meta-ads.mjs`; cuentas con `pnpm e2e:cuentas`). El mock de Graph gana comportamientos por
sufijo del número, como ya hace con `-sinads` o `-ratelimit`:

- `…-estadoprimero`: el mock dispara el webhook `delivered` ANTES de responder a `POST /messages`. Verifica que
  el texto, la plantilla y la ubicación terminan con ✓✓ y no con el reloj.
- `…-fallo`: Graph responde 4xx. Verifica la burbuja roja con el motivo para texto, plantilla, ubicación,
  contacto y adjunto; que el texto vuelve al compositor; y que el pre-vuelo (ventana cerrada) sigue sin dejar
  burbuja.
- `…-colgado`: Graph no responde. Con la barredera acelerada por variable de entorno de prueba, la burbuja pasa a
  `failed` con el texto de ambigüedad.
- Instagram/Messenger/TikTok con el mock de Zernio: el envío exitoso queda `sent` y el fallido, `failed`.
- Se repasan los guiones existentes que envían mensajes (`pnpm test:e2e`, automatizaciones, bot) para detectar
  regresiones por las filas extra.

**Compuertas**: typecheck, lint, build, `pnpm test`, `pnpm test:db` (las suites live, incluidas las existentes
de automatizaciones, que envían mensajes), E2E nuevo y `pnpm test:e2e`. Prohibido delegar la prueba.

## Riesgos y cómo se cubren

| Riesgo | Mitigación |
|---|---|
| La burbuja aparece antes de que Graph responda y se duplica con la provisional del cliente | La provisional ya se empareja por texto y hora con el mensaje real; el E2E lo comprueba con el envío lento. |
| El conteo de TikTok (`salientesDesdeElUltimoEntrante`) incluye ahora filas `pending` de envíos en vuelo | Cuenta de más, no de menos: el tope se respeta con envíos simultáneos. Queda fijado en una prueba. |
| La barredera marca `failed` un mensaje que SÍ salió | Es el costo de no tener un estado «desconocido»; el texto lo dice y pide revisar. Umbral de 3 min contra un máximo de 30 s. |
| Más filas `failed` en Resultados → Higiene | Es la cuenta correcta; se documenta en el CHANGELOG. |
| El agente (`pipeline.ts`) o las automatizaciones ven una fila `out` antes de que se confirme | Lo que decide hoy el agente (`handoffAt`, `aiEnabled`) no depende del estado del último saliente; se revisa en la implementación y se prueba. |
| Migración en una base con mucho `message` | El índice parcial es sobre un conjunto casi vacío (solo `pending` sin id); se crea sin bloquear lecturas relevantes. |

## Fuera de alcance

| Qué | Por qué |
|---|---|
| Botón «Reintentar» en la burbuja `failed` | Otra spec; aquí solo se deja de perder el mensaje. |
| Estado `unknown` propio | Cambia el DTO y la UI; el texto de `failed` basta por ahora (pregunta Q3). |
| Acuses de entrega de Instagram, Messenger y TikTok | Zernio no los manda para salientes. |
| Paginar la lista y el hilo, `markRead` sin difusión | Paquete 3. |
| Cola persistente de reintentos de envío | El reintento sigue siendo del operador, del agente o del motor de automatizaciones. |

## Criterios de aceptación

- **AC1** Un `delivered` que llega antes de que se guarde el `wa_message_id` deja el mensaje en `delivered`, no en
  `pending`. Probado con las dos interleavings y con 300 carreras aleatorias.
- **AC2** `delivered` y `read` simultáneos terminan siempre en `read`.
- **AC3** Texto, plantilla, ubicación, contacto y adjunto que fallan en Graph dejan una burbuja `failed` con el
  motivo y `SendError.messageId`. Un rechazo del pre-vuelo no deja burbuja.
- **AC4** Si Graph acepta y la base falla al guardar el id, el mensaje sigue en la bandeja y el log lleva el id
  de Meta.
- **AC5** Una llamada a Graph colgada termina en 30 s; el mensaje queda `failed` con el aviso de ambigüedad.
- **AC6** Una fila `pending` sin id de más de 3 minutos pasa a `failed` sin tocar las recientes, las de prueba ni
  las ajenas. Dos barridas seguidas no repiten nada.
- **AC7** Los huérfanos de más de 24 h se borran; ninguno queda vivo tras reclamarse.
- **AC8** Instagram, Messenger y TikTok: envío exitoso → `sent`; fallido → `failed`.
- **AC9** El DTO del mensaje, los eventos SSE y las respuestas HTTP no cambian; todas las suites existentes
  siguen en verde.

## Preguntas para la revisión

- **Q1** Un texto de la bandeja que falla deja ahora burbuja `failed` Y devuelve el texto al compositor. Si el
  operador lo reenvía, el hilo muestra el fallo y el éxito (como WhatsApp). ¿Lo dejamos así, o el texto ya no se
  devuelve al compositor? *Recomiendo dejarlo: no se pierde nada y el historial es honesto.*
- **Q2** D7: ¿aceptas una fila `failed` por cada reintento fallido de una automatización? *Recomiendo sí, por
  consistencia con los adjuntos; el ruido se trata aparte si aparece.*
- **Q3** D6: ¿«sin confirmar» como `failed` con aviso, o un estado nuevo `unknown`? *Recomiendo `failed` con aviso
  ahora (sin tocar el DTO) y `unknown` solo si en la práctica confunde.*
- **Q4** D2: ¿búfer en tabla (recomendado: sobrevive a un reinicio, una instancia o varias) o en memoria (sin
  migración, pero se pierde con un reinicio justo en la ventana)?
