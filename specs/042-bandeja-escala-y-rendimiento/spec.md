# 042 — Bandeja: escala, tiempo real sin tormentas y hilo estable

**Feature Branch**: `feat/042-bandeja-escala-y-rendimiento`

**Created**: 2026-11-17

**Status**: **Implementada** (2026-11-17), con las preguntas de revisión en sus valores recomendados (Q1 40/50, Q2 `counts` en cada delta, Q3 orden por hora del evento, Q4 límite por omisión de 40, Q5 índices sin `CONCURRENTLY`). Pendiente de commit. Verificada contra Postgres real (`bandeja-escala-live`, 11 pruebas) y de punta a punta con la app y el mock (`pnpm test:e2e:bandeja-escala`, 44 comprobaciones); **no con volumen real de producción**.

Ajustes que salieron al implementar (respecto del texto de abajo):
- **El cursor lleva la llave como TEXTO de Postgres, con microsegundos.** Pasarla por un `Date` de JavaScript (milisegundos) hacía que dos conversaciones del mismo milisegundo se repitieran o se saltaran entre páginas; una prueba lo fija con seis conversaciones que difieren solo en microsegundos.
- `ConversationDto` gana también `sortKey` (la llave de orden en ISO) para que el cliente ordene y decida dónde cae una conversación que cambió.
- `humanWindow.expiresAt` se manda siempre que el canal tiene extensión humana y hubo un entrante (no solo cuando ya estaba abierta): sin eso el cliente no podría abrirla solo al cerrar la ventana normal.
- Una conversación abierta que deja de cumplir el filtro (la lees estando en «No leídas») **se queda abierta** con su propio estado (`selectedFallback`), aunque salga de la lista.
- `PATCH {markRead}` a solas responde con la conversación completa (con preview y etapa) y publica `conversation.read` **solo si el contador bajó**; combinado con otros campos sigue publicando `conversation.updated`.
- El E2E encontró dos cosas que la lectura no: el observador de «cargar más» se volvía a suscribir en cada render (el padre pasa una función nueva) y los guiones daban por cierta una lista que aún era la de la búsqueda anterior. Ambas corregidas; las funciones de scroll ahora van por una referencia estable.
- El modal de bienvenida de una cuenta nueva tapaba la pantalla en los guiones: se descarta con `PUT /api/organization/sector {action:"skip"}`, como lo haría el dueño.
- `specs/README.md` no se actualizó: su índice se detiene en la 031.

**Input**: Paquete 3 del análisis de la Bandeja (hallazgos 5, 6, 7 y los puntos críticos del 9). Sigue a la
[041](../041-envio-robusto-y-estados/spec.md), que ya dejó el envío y los estados en verde.

**Carril**: ciclo completo (Principio VI). **Cambia contratos internos de la API** (`GET /api/conversations` y
`GET …/messages` se paginan; dos DTOs ganan campos; un evento SSE nuevo), **añade una migración de índices** y
**reescribe el manejo de estado de `inbox-client.tsx`**. No toca el envío, los webhooks ni los contratos de
`/api/bot/*`. Sin bandera: es el núcleo.

## Problema

Todo lo que sigue se midió leyendo el código; ninguna cifra es de producción.

**P1 — Todo se carga completo, y varias veces.** `GET /api/conversations` devuelve TODAS las conversaciones y
`GET …/messages` el hilo ENTERO, sin límite. El parámetro `since` existe en ambas rutas y **ningún cliente lo
usa**: cada evento SSE (`message.new`, `conversation.updated`, `conversation.deleted`) y cada envío termina en
`refetchConversations()`, que vuelve a bajar la lista completa.

**P2 — La barra lateral de toda la aplicación hace lo mismo (no estaba en el análisis inicial).**
`src/components/app-nav.tsx` pide `GET /api/conversations` entero **en cada pestaña abierta, en cualquier
pantalla**, a cada `message.new` y a cada `conversation.updated`, solo para sumar `unreadCount` y pintar el
número de «Bandeja». Con 10 operadores y 5 000 conversaciones, un mensaje entrante dispara 10 descargas de 5 000
filas, y el `PATCH markRead` que ocurre al abrir una conversación (que publica `conversation.updated` a toda la
organización) dispara otras 10 **por cada conversación que alguien abra**.

**P3 — La consulta del preview no puede usar el índice.** `listConversations` calcula el último mensaje con una
subconsulta correlacionada `where m.conversation_id = … order by m.created_at desc limit 1`, pero el único
índice útil, `message_org_conv_idx`, empieza por `organization_id` y la subconsulta no lo filtra: Postgres no
puede recorrerlo y, al crecer `message`, cada fila de la lista cuesta más. Además, la lista se ordena por
`coalesce(last_message_at, created_at)`, que `conversation_org_last_idx (organization_id, last_message_at)` no
sirve (la expresión es distinta).

**P4 — Marcar leído es ruidoso.** `PATCH {markRead:true}` siempre actualiza la fila y siempre publica
`conversation.updated`, aunque el contador ya estuviera en 0. El cliente lo manda al seleccionar una conversación
y a cada mensaje entrante de la seleccionada, **también con la pestaña en segundo plano** (`document.hidden`): el
operador que dejó la pestaña abierta mientras trabaja en otra cosa «lee» todo sin haberlo visto.

**P5 — Una respuesta vieja puede pisar a una nueva.** Los refetch (`refetchConversations`, `refetchMessages`) no
se numeran ni se cancelan: si dos viajan a la vez y la primera tarda más, su resultado sobrescribe al de la
segunda. `refetchMessages` solo se protege contra cambiar de conversación, no contra el orden de llegada.

**P6 — El orden del hilo y la hora que se ve no coinciden.** El servidor ordena `listMessages` por `created_at`
(cuándo lo recibió el CRM) pero el DTO muestra `wa_timestamp ?? created_at` (cuándo lo escribió el cliente). Un
entrante que Meta retrasa minutos aparece **después** de la respuesta que el operador dio a lo siguiente, con una
hora **anterior** a la de la burbuja que tiene encima, y los separadores de día se calculan con la hora
mostrada, no con el orden. La vista previa de la lista y `last_message_at` usan, otra vez, otros criterios.

**P7 — La cuenta regresiva de la ventana está congelada.** `windowOpen` y `windowRemainingMs` se calculan en el
servidor al pedir la lista y el cliente jamás los avanza. El compositor dice «Ventana abierta · quedan 3 m» con la
ventana ya vencida hasta el siguiente refetch (que, con P1, suele no llegar). El servidor sí bloquea el envío con
409, pero el operador se entera tarde y, con el arreglo de errores del Paquete 1, ahí.

**P8 — El hilo le roba el scroll al operador.** `message-thread.tsx` baja al final con cada mensaje nuevo, aunque
quien lo lee esté arriba revisando historial.

## Decisiones

**D1 — La lista se pagina por cursor y se filtra en el servidor.**
`GET /api/conversations?limit=40&cursor=…&q=&stage=&channel=&filter=all|unread|anuncios`. El cursor es el par
`(clave de orden, id)` de la última fila vista, opaco (base64url de JSON), con la clave
`coalesce(last_message_at, created_at)` y `id` como desempate: paginación por *keyset*, sin `OFFSET`, que no se
degrada con la profundidad. Sin `limit`, 40; máximo, 100.

Hoy los filtros (búsqueda, etapa, bandeja de canal, «No leídas», «Anuncios») y todos los contadores de la
pantalla se calculan **en el cliente sobre la lista completa**; con paginación eso mentiría. Pasan al servidor,
con la misma semántica:

- `q`: nombre sin acentos ni mayúsculas, y teléfono por dígitos con mínimo 3 — la regla de `matchesQuery`, en SQL
  con el mismo `translate` que ya usa `GET /api/contacts`. Se **extrae** a `src/server/search-sql.ts` y las dos
  rutas lo comparten (sin cambiar el comportamiento de Contactos).
- `stage`: nombre de la etapa del lead. `channel`: uno de los canales. `filter`: `unread` = `unread_count > 0`;
  `anuncios` = existe `ad_attribution` de esa conversación.
- La respuesta trae, en la primera página y en cada delta (no al «cargar más»):
  `counts: { total, byChannel, all, unread, anuncios }` — `total` sin filtros (el «6» del encabezado);
  `byChannel` con `q` y `stage` aplicados; `all/unread/anuncios` con además el `channel` elegido, que es
  exactamente lo que el cliente calcula hoy — y `stages`: las etapas presentes, en el orden del pipeline.
- `contactId=ct_…` devuelve esa sola conversación sin paginar (enlace directo `/bandeja?contact=`, que hoy
  depende de que la conversación esté en la lista cargada).

**D2 — Los deltas usan `since`, de verdad, y vienen sin filtros.**
`GET /api/conversations?since=<ISO>` devuelve las conversaciones que **cambiaron** desde ese instante, sin
filtros y sin paginar (tope 200; si hubo más, `truncated: true` y el cliente repone la primera página). «Cambió»
= `conversation.updated_at > since` **o** `lead.updated_at > since` (mover de etapa no toca la conversación, y
hoy el cambio de etapa solo se ve porque se refetch todo) **o** una atribución de anuncio nueva. Toda respuesta
trae `serverTime`; el cliente guarda **ese** instante (menos 2 s de solape; los upserts por `id` son
idempotentes), nunca su propio reloj. Se pide sin filtros porque el cliente debe poder **sacar** de la vista una
conversación que dejó de cumplir el filtro (leída, en otra etapa) y para eso necesita su estado nuevo; el
cliente aplica los filtros localmente con `matchesFilters` (D6), que se prueba contra la versión SQL.

Un delta no sabe de borrados. Los resuelve así: el evento `conversation.deleted` (en vivo) y, tras reconectar, la
primera página se **repone** entera además del delta. Una conversación borrada fuera de la primera página que
nadie vio borrarse queda en pantalla hasta que se la abra: la apertura responde 404 y se retira sola
(`quitarConversacion`, que ya existe).

**D3 — Los eventos SSE dejan de significar «recarga todo».**
- `message.new` y `conversation.updated` disparan **un delta**, agrupado: un solo viaje en vuelo, con espera de
  250 ms que junta ráfagas. Nunca la lista completa.
- Evento nuevo **`conversation.read`** `{ conversationId, unreadCount: 0 }`. `PATCH {markRead}` ya no publica
  `conversation.updated`: lo hace solo si el contador **bajó** (`UPDATE … WHERE unread_count > 0`), y publica el
  evento ligero, que el cliente aplica parchando esa fila en memoria, sin pedir nada. Marcar leído algo ya leído
  no escribe, no bumpea `updated_at` y no publica. (Sí bumpea `updated_at` cuando cambia, para que un cliente
  que estuvo desconectado lo reciba en su delta.)
- **`AppNav` deja de bajar la lista.** Nuevo `GET /api/conversations/unread` → `{ unread: n }` (un `SUM`),
  pedido con espera de 400 ms, y solo ante `message.new` **entrante**, `conversation.read` y
  `conversation.deleted`; deja de escuchar `conversation.updated` y los salientes (ninguno cambia el contador).

**D4 — El orden es el de la hora que se ve: la hora del evento.**
Se define la **hora del evento** `t = coalesce(wa_timestamp, created_at)` y es el único criterio de orden del
hilo y del preview. Desempate: `created_at`, luego `id`. Así un entrante que Meta retrasó aparece **donde el
cliente lo escribió** y la cronología que lee el operador es la de la conversación, no la de la cola de Meta.
Consecuencia que el cliente maneja: un `message.new` puede caer **en medio** del hilo, no solo al final; se
inserta ordenado (`insertSorted`) y no se anuncia como «nuevo» si cae por encima de lo que el operador ya vio.
Los separadores de día salen de la misma lista ordenada, así que dejan de poder retroceder.

`wa_timestamp` llega en segundos y `created_at` en microsegundos: a igual segundo, gana `created_at`, que es
justo lo que ordena bien un entrante y su respuesta inmediata.

**D5 — El hilo se pagina hacia arriba.**
`GET …/messages?limit=50&before=<cursor>` devuelve `{ messages, hasMore, nextBefore }`: los 50 más recientes
(o los 50 anteriores al cursor), **en orden ascendente**. La carga inicial es la última página. Arriba del hilo
hay un centinela (`IntersectionObserver`, con botón «Cargar mensajes anteriores» de respaldo) que pide la
siguiente y **conserva la posición**: al anteponer filas se compensa el cambio de `scrollHeight`, para que el
operador no vea saltar lo que estaba leyendo. `since` se mantiene en la ruta (mensajes con `created_at`
posterior), pero **el cliente no la usa para el hilo**: tras reconectar repone la última página y la **fusiona
por `id`** (los acuses de entrega no cambian `created_at`, así que un delta por fecha no los traería; la última
página, 50 filas, sí). Las páginas antiguas ya cargadas no se tocan.

**D6 — El estado del cliente deja de ser «lo que devolvió el último fetch».**
`inbox-client.tsx` deja de hacer `setConversations(respuesta)` y pasa a un almacén por `id` con operaciones puras
y probadas (`src/lib/inbox-state.ts`): `upsertMany`, `patch`, `remove`, `applyFilters(matchesFilters)`,
`insertSorted` (mensajes), `mergeById`. Reglas:
- **Nada llega fuera de orden.** Cada tipo de petición (cabeza de lista, delta, más-lista, hilo, hilo-anterior)
  lleva un número de secuencia; al volver, si hay uno más reciente aplicado, el resultado se **descarta**, y al
  cambiar filtros o conversación se cancela la petición anterior con `AbortController`. Es el arreglo de P5, y
  vive en una utilidad (`latestOnly`) que se prueba aparte.
- Una fila que ya está en memoria solo se **reemplaza** por una respuesta cuyo `serverTime` sea posterior a su
  último parche, y los parches locales (`conversation.read`) sobreviven a un delta anterior a ellos.
- Los filtros cambian → se reinicia la lista y se pide la cabeza con los nuevos; la búsqueda espera 250 ms tras
  teclear. El campo conserva su rescate del texto tecleado antes de hidratar.
- «Cargar más» al llegar al final de la lista (centinela), con el mismo cuidado de scroll.
- Reconexión SSE: cabeza de la lista + delta + última página del hilo abierto; nada más.

**D7 — Marcar leído solo si de verdad se está viendo.**
Un solo punto en el cliente decide: `puedeMarcarLeido() = document.visibilityState === "visible"` (y
`document.hasFocus()` no se exige: ver una pantalla secundaria es leer). Con la pestaña oculta no se manda
nada; al volver a verse (`visibilitychange`) se marca la conversación abierta si tiene contador > 0. Seleccionar
una conversación sin contador no manda `PATCH`. Además, solo si el hilo está **en el fondo** (D9) los entrantes
nuevos cuentan como leídos; si el operador está arriba leyendo historial, quedan sin leer hasta que baje o
pulse el aviso.

**D8 — La ventana corre en el cliente.**
Los DTO ganan **instantes absolutos**: `windowExpiresAt` (ISO o `null`) y `humanWindow.expiresAt`, y las
respuestas traen `serverTime` para calcular el desfase entre relojes una vez. `src/lib/inbox-window.ts` (puro,
espejo de `replyWindow`) deriva `{ standardOpen, humanOpen, remainingMs }` para cualquier `ahora`. Un único reloj
(`useInboxClock`) late cada 60 s y **cada segundo en los últimos 5 minutos** de la conversación abierta; a la
hora de cierre el compositor pasa solo a «ventana cerrada» (plantilla / aviso de la ventana humana) y el punto
verde de la lista se apaga. Los campos viejos `windowOpen`/`windowRemainingMs` **se conservan** (los lee el
servidor y los guiones) y dejan de usarse en pantalla. Un canal sin ventana (`windowMs` infinito) manda
`windowExpiresAt: null` con `windowOpen: true`: no vence jamás.

**D9 — Scroll inteligente.**
El hilo mide si el operador está «cerca del fondo» (≤ 120 px). Mensaje nuevo: **cerca del fondo** → baja; **lejos**
→ no se mueve y aparece una pastilla «↓ N mensajes nuevos» que, al pulsarla, baja y marca leído. El **envío
propio** siempre baja. Cambiar de conversación empieza en el fondo. Los mensajes anteriores que se anteponen
(D5) no cuentan como nuevos.

**D10 — La consulta del preview y los índices (migración 0077).**
La subconsulta del preview pasa a filtrar por `organization_id` **y** `conversation_id` y a ordenar por la hora
del evento. Dos índices nuevos, aditivos:

```sql
-- el hilo, el preview y la paginación hacia arriba: una sola llave de orden (D4)
create index message_event_idx on message
  (organization_id, conversation_id, (coalesce(wa_timestamp, created_at)) desc, created_at desc, id desc);
-- la lista y su cursor: la expresión EXACTA por la que se ordena
create index conversation_list_idx on conversation
  (organization_id, (coalesce(last_message_at, created_at)) desc, id desc) where is_test = false;
```
`message_org_conv_idx` se **conserva** (lo usan el tope de TikTok y los deltas por `created_at`).
`conversation_org_last_idx` queda sin uso en la bandeja; se conserva por ahora (otras consultas) y se revisa en
una limpieza aparte. Sin columnas nuevas.

Costo conocido: `CREATE INDEX` toma un candado que bloquea escrituras en `message` mientras dura; drizzle corre
las migraciones dentro de una transacción y no admite `CONCURRENTLY`. En una instancia con millones de mensajes
son segundos a minutos al arrancar el contenedor; se documenta en el CHANGELOG (pregunta Q5).

## Cambios de contrato

| Endpoint | Antes | Después |
|---|---|---|
| `GET /api/conversations` | Todas las conversaciones; `since` opcional sin uso | Página de 40 (máx. 100) con `nextCursor`; filtros `q`, `stage`, `channel`, `filter`; `contactId`; `since` = delta sin filtros (≤ 200, `truncated`); `counts` y `stages`; `serverTime` |
| `GET /api/conversations/unread` | — | **Nuevo** `{ unread }` |
| `GET /api/conversations/[id]/messages` | Hilo entero | Página de 50 con `hasMore`/`nextBefore`, `before`, orden por hora del evento; `since` se conserva |
| `PATCH /api/conversations/[id]` `{markRead}` | Siempre escribe y publica `conversation.updated` | Solo escribe y publica si el contador bajó; evento `conversation.read` |
| DTO `ConversationDto` | `windowOpen`, `windowRemainingMs` | + `windowExpiresAt`, `humanWindow.expiresAt` (los viejos se conservan) |
| SSE | `conversation.updated` para todo | + `conversation.read`; `conversation.updated` sigue para el resto, ahora disparador de un delta |

Los consumidores internos son pocos y están todos en este repositorio: `inbox-client.tsx`, `app-nav.tsx` y dos
guiones E2E (`e2e-anuncio-origen-ui.mjs`, `e2e-bandeja-envio.mjs`) que leen la lista sin parámetros y buscan por
nombre; pasan a usar `q`. `/api/bot/*` no usa estas rutas.

## Plan por archivo

| Archivo | Cambio |
|---|---|
| `src/lib/db/schema.ts` · `drizzle/0077_*.sql` + snapshot | Los dos índices de D10 (generados con `pnpm db:generate`; las expresiones se escriben con `sql\`\``). |
| `src/server/search-sql.ts` (**nuevo**) | `likeNormalizado(col, q)` y `coincideTelefono(col, q)` extraídos de `contacts/route.ts`. |
| `src/app/api/contacts/route.ts` | Usa `search-sql.ts`; comportamiento idéntico (lo prueba `search.test.ts` ampliado). |
| `src/server/inbox/queries.ts` | `listConversations` → `listConversationsPage` (cursor, filtros, `counts`, `stages`), `listConversationsDelta`, `unreadTotal`; preview con la subconsulta de D10; `listMessages` → `listMessagesPage` (orden por hora del evento, `before`); `updateConversation` marca leído condicionado (`unread_count > 0`) y devuelve si cambió; `serializeConversation` agrega `windowExpiresAt`. |
| `src/lib/inbox-cursor.ts` (**nuevo**) | Codifica/decodifica los cursores de lista y de hilo (base64url, validados con Zod; uno inválido → 422). Puro. |
| `src/app/api/conversations/route.ts` | Parámetros nuevos (Zod), `serverTime`. |
| `src/app/api/conversations/unread/route.ts` (**nuevo**) | `{ unread }`. |
| `src/app/api/conversations/[id]/route.ts` | `GET` (una conversación completa, para el enlace directo) y `PATCH` con `conversation.read`. |
| `src/app/api/conversations/[id]/messages/route.ts` | `limit`/`before`/`since`, respuesta paginada. |
| `src/server/events/bus.ts` · `src/components/use-events.ts` | Evento `conversation.read` y su `onConversationRead`. |
| `src/lib/types.ts` | `ConversationDto` (+ campos), `ConversationsPageDto`, `MessagesPageDto`, `InboxCountsDto`. |
| `src/lib/inbox-state.ts` (**nuevo**) | Operaciones puras del almacén y `matchesFilters` (D6); `latestOnly` (secuenciación y descarte). |
| `src/lib/inbox-window.ts` (**nuevo**) | `windowStateAt(dto, nowMs, offsetMs)` y `nextTickMs` (D8). Puro. |
| `src/components/inbox/use-inbox-clock.ts` (**nuevo**) | El reloj de 60 s / 1 s. |
| `src/components/inbox/inbox-client.tsx` | Reescritura del estado (D2, D3, D6, D7): almacén por `id`, cursor, `syncedAt`, secuencias y `AbortController`, deltas agrupados, `puedeMarcarLeido`, reconexión mínima, enlace directo por `contactId`. Sigue siendo el único dueño del estado; sus hijos reciben props. |
| `src/components/inbox/conversation-list.tsx` | Sin filtrado local: emite `onFiltersChange` (con espera de 250 ms) y recibe `counts`/`stages`; centinela de «cargar más»; punto verde y estado de ventana derivados del reloj. |
| `src/components/inbox/message-thread.tsx` | Centinela superior, anteposición con scroll conservado, decisión de «cerca del fondo», pastilla «↓ N mensajes nuevos» (D9). |
| `src/components/inbox/composer.tsx` | Estado de ventana derivado del reloj (D8); sin otros cambios. |
| `src/components/app-nav.tsx` | `GET …/unread` con espera de 400 ms y solo ante los eventos de D3. |
| `CLAUDE.md`, `AGENTS.md`, `CHANGELOG.md`, `specs/README.md` | La fila de la bandeja, el contrato de la lista, el aviso del índice y el renglón de las specs 041 y 042. |

No se tocan: el envío (`send.ts`, `outbox.ts`), los webhooks, `status.ts`, `eliminar.ts`, `/api/bot/*`.

## Pruebas

**Unitarias puras** (`pnpm test`): `inbox-cursor` (ida y vuelta, cursor inválido, manipulado), `inbox-state`
(`upsertMany` no pisa un parche más nuevo; `insertSorted` con empates y con un mensaje que cae en medio;
`mergeById` conserva las páginas antiguas; `applyFilters`), **`latestOnly`** (la respuesta vieja se descarta;
cancelar al cambiar de filtro), `matchesFilters` contra `matchesQuery`, `inbox-window` (abre/cierra a la hora
exacta, desfase de reloj, canal sin ventana, ventana humana, `nextTickMs` pasa a 1 s en los últimos 5 min),
la decisión de «cerca del fondo» y de qué cuenta como nuevo, `puedeMarcarLeido`.

**Contra Postgres real** (`tests/unit/bandeja-escala-live.test.ts`, `RUN_DB_TESTS=1`):
1. **Paginación sin huecos ni repetidos**: 500 conversaciones con claves de orden **empatadas a propósito**;
   recorrer las páginas junta exactamente las 500, sin duplicados, en orden.
2. **Filtros y contadores** idénticos a los del cliente de hoy (se compara con `matchesFilters` sobre el mismo
   conjunto): `q` con acentos, con teléfono tecleado «+52 555…», con un `%` suelto; etapa; canal; no leídas;
   anuncios; `counts` y `stages`.
3. **Delta**: detecta un mensaje nuevo, un `markRead`, **un cambio de etapa** (solo `lead.updated_at`) y una
   atribución nueva; no devuelve lo que no cambió; `truncated` por encima de 200; `serverTime`.
4. **Orden del hilo por hora del evento**: un entrante con `wa_timestamp` de hace 10 min insertado ahora queda
   entre los mensajes que le tocan; paginación hacia arriba coherente con empates de `wa_timestamp`; el preview
   de la lista es el último **por la misma llave**.
5. **`markRead` idempotente**: con contador > 0 baja, bumpea `updated_at` y reporta cambio; con 0 no escribe.
6. **El plan usa los índices**: con 30 000 mensajes en una conversación y 300 conversaciones (y `ANALYZE`),
   `EXPLAIN (FORMAT JSON)` del preview y de la página de hilo no contiene `Seq Scan` sobre `message`, y la
   lista de la primera página usa `conversation_list_idx`.
7. **Multi-tenancy**: un cursor de otra organización no revela filas; los contadores no mezclan organizaciones.
8. `GET /unread` suma solo la organización y excluye conversaciones de prueba.

**E2E contra la app y el mock** (`pnpm test:e2e:bandeja-escala`, `scripts/e2e-bandeja-escala.mjs`; datos
sembrados por SQL para que sea rápido: 300 conversaciones y un hilo de 400 mensajes):
- La primera carga trae 40 filas y los contadores correctos; al llegar al final se cargan más; la búsqueda por
  nombre y por teléfono, la etapa y «No leídas» filtran y cuentan en el servidor.
- El hilo abre con los 50 últimos; al subir carga los anteriores **sin que salte la posición**.
- **Sin tormenta**: con la bandeja abierta, entran 10 mensajes por el webhook mientras se cuentan las peticiones:
  ninguna es una descarga de lista completa, y `AppNav` solo llama a `/unread`.
- **Scroll**: arriba del hilo, un entrante no mueve el scroll y aparece «↓ 1 mensaje nuevo»; al pulsarla baja;
  cerca del fondo, baja solo.
- **Pestaña oculta**: con `document.visibilityState` simulado en `hidden`, un entrante no genera `PATCH
  markRead`; al volver a `visible` sí.
- **Carrera de red**: Playwright retrasa la primera respuesta de la lista y deja pasar la segunda; la pantalla
  conserva la **segunda**.
- **Reloj**: una conversación a 70 s de cerrar la ventana pasa sola a «ventana cerrada» (plantilla) sin ninguna
  petición, y a 1 s de resolución en el tramo final.
- **Orden**: un entrante con hora anterior (`wa_timestamp` atrasado) cae en su lugar y los separadores de día no
  retroceden.
- Regresión: `pnpm test:e2e:bandeja-envio` (041) sigue en verde, y se revisa la tarjeta de anuncio de origen.

**Compuertas**: typecheck, lint, build, `pnpm test`, `pnpm test:db` (todas las suites live), los dos E2E y
capturas revisadas a mano (lista, hilo con pastilla, compositor cerrándose).

## Riesgos y cómo se cubren

| Riesgo | Mitigación |
|---|---|
| Reescribir el estado del cliente rompe algo sutil (selección, borrador, panel de detalles) | El almacén es puro y probado; el borrador sigue por conversación (`key={selected.id}` del compositor, ya existe); el E2E recorre abrir, enviar, borrar y cambiar de conversación. |
| `counts` en cada delta cuesta una agregación sobre la organización | Una consulta con `FILTER`, sobre un índice por organización; con 50 000 conversaciones son decenas de ms y está agrupada por la espera de 250 ms. Si algún día pesa, contadores materializados (otra spec). |
| La clave de la lista cambia mientras se pagina (llega un mensaje) | La clave solo crece: una conversación que sube ya no está bajo el cursor, y las que ya se cargaron se deduplican por `id`. No puede saltarse ninguna. |
| El filtro local y el SQL divergen | `matchesFilters` y el SQL se prueban contra los mismos conjuntos (prueba 2). |
| Bloqueo al crear los índices en una base grande | Documentado (D10, Q5); los índices son aditivos y se pueden retirar sin tocar datos. |
| El orden por hora del evento mueve un mensaje de sitio ante los ojos del operador | Solo ocurre con un entrante retrasado; se inserta en su lugar y no se anuncia como nuevo si queda por encima de lo visto. |

## Fuera de alcance

| Qué | Por qué |
|---|---|
| Virtualizar el DOM de la lista y del hilo | Con páginas de 40/50 y «cargar más» el DOM crece despacio; se revisa si alguien carga miles de filas. |
| Buscar dentro del texto de los mensajes | Otra spec (índice de texto); hoy solo nombre y teléfono, como ahora. |
| Contadores de no leídas por operador | El contador es de la conversación, como hoy. |
| Un bus de eventos entre procesos | Una instancia = un proceso (`bus.ts`). |
| Materializar el preview en `conversation` | Con el índice nuevo la subconsulta basta; se reabre si el plan lo desmiente en producción. |
| Tocar `eliminar.ts`, el envío o los webhooks | Ya cerrados en 026 y 041. |

## Criterios de aceptación

- **AC1** `GET /api/conversations` devuelve 40 filas y `nextCursor`; recorrer los cursores entrega todas las
  conversaciones sin repetir ni omitir ninguna, aun con claves empatadas.
- **AC2** Búsqueda, etapa, canal, «No leídas» y «Anuncios» filtran en el servidor con la misma semántica que el
  cliente tenía, y los contadores del encabezado y de los chips coinciden con ella.
- **AC3** Con la bandeja abierta, un mensaje entrante produce **un** delta (≤ 200 filas) y nunca la descarga
  completa; la barra lateral solo llama a `/unread`.
- **AC4** Abrir una conversación sin mensajes por leer no escribe ni publica nada; abrir una con mensajes por
  leer publica `conversation.read` y no `conversation.updated`.
- **AC5** Con la pestaña oculta no se marca leído; al volver a verse, sí.
- **AC6** Una respuesta de red vieja nunca sustituye a una más reciente (lista ni hilo).
- **AC7** El hilo y la vista previa se ordenan por la hora del evento; los separadores de día no retroceden; un
  entrante retrasado cae en su lugar.
- **AC8** El hilo abre con 50 mensajes, carga los anteriores al subir sin que la posición salte, y lo hace
  también con 5 000 mensajes.
- **AC9** La ventana abierta pasa sola a cerrada a la hora exacta, con el compositor reflejándolo sin refetch.
- **AC10** Con el operador leyendo arriba, un mensaje nuevo no mueve el scroll y muestra «↓ N mensajes nuevos»;
  cerca del fondo, baja solo; enviar siempre baja.
- **AC11** `EXPLAIN` de la lista, del preview y de la página del hilo usa los índices nuevos.
- **AC12** Contactos busca igual que antes (`search.test.ts` y su E2E), y las suites existentes siguen en verde.

## Preguntas para la revisión

- **Q1** Tamaño de página: 40 conversaciones y 50 mensajes (máximos 100). ¿Te parece bien, o prefieres 30/30,
  o 50/100? *Recomiendo 40/50.*
- **Q2** `counts` va en cada delta (pocos ms, siempre exactos). ¿O prefieres que los chips se actualicen solo al
  cambiar de filtro y al reconectar, ahorrando esa consulta a costa de que lleguen a estar desactualizados?
  *Recomiendo en cada delta.*
- **Q3** D4: ordenar por **hora del evento** (recomendado: la cronología que ve el operador es la de la
  conversación, aunque Meta entregue tarde) o conservar el orden de **llegada** y cambiar lo que muestra la
  burbuja. Cambiar lo mostrado haría que una burbuja diga «10:02» habiendo sido escrita a las 10:00.
- **Q4** `GET /api/conversations` pasa a devolver 40 por omisión en lugar de todo. Hoy solo la leen la bandeja,
  la barra lateral y dos guiones de este repositorio. ¿Aceptas ese cambio de contrato interno (sin versionarlo)?
  *Recomiendo sí.*
- **Q5** D10: los índices se crean sin `CONCURRENTLY` (límite de drizzle). ¿Aceptas el bloqueo breve de
  escrituras en `message` al arrancar tras actualizar? Si tu instancia ya tiene millones de mensajes, dímelo y
  planeo una migración manual aparte.
