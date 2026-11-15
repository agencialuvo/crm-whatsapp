# 037 — Automatizaciones: cumplimiento de Meta (bajas y límite de frecuencia) + enviar multimedia

Fase 6 (final) de la línea 032–036. Estado: **implementado y verificado** (typecheck, lint, 2 104 pruebas unitarias, 200 contra Postgres real, build y recorrido en navegador).

## Por qué

Un motor que manda mensajes solo es un riesgo si no sabe callarse. Meta bloquea o degrada números cuyos clientes piden
dejar de recibir mensajes y no se les hace caso, o que reciben ráfagas. Esta fase pone **dos frenos en el único punto por
el que sale todo mensaje automático** (el motor, justo antes de enviar) y completa el bloque que quedó «Próximamente» en
la paleta del lienzo: enviar imagen o video.

## Qué hay ya (no se rehace)

- `automation_execution_log.status` ya admite `skipped_opt_out` y `skipped_rate_limit`; el monitor (`monitor.ts`) ya los
  cuenta y filtra. Faltaba quien los escribiera.
- `sendMediaMessage` (`src/server/inbox/send.ts`) ya sube el archivo a Graph y lo manda: la ruta de las personas del CRM.
- La biblioteca de Medios (`media_library_item`) guarda imágenes y videos del negocio con sus bytes en `MEDIA_DIR`.
- **No hay** columna de baja en `contact`: se añade.

## Decisiones

**D1 — La baja vive en el contacto.** `contact.opted_out_at` (NULL = recibe) y `contact.opt_out_source`
(`keyword` | `manual`). Un timestamp en vez de un booleano: dice desde cuándo y se puede mostrar. Una sola columna de
verdad; nada de una tabla aparte.

**D2 — Qué cuenta como baja (puro, sin LLM).** `detectOptOutIntent(texto)` normaliza (minúsculas, sin acentos ni
puntuación) y decide:
- *Palabras sueltas* (`baja`, `stop`, `unsubscribe`, `cancelar`): solo si el mensaje ENTERO es esa palabra. «Tengo la
  presión baja» no es una baja.
- *Frases* (`no quiero más mensajes`, `no me escriban más`, `dar de baja`, `deja de escribirme`…): basta con que el
  mensaje corto (≤ 80 caracteres) las contenga.
- *Reactivación* (`start`, `reanudar`, `suscribirme`, `quiero recibir mensajes`): el cliente vuelve a pedirlo y la baja se
  levanta (Meta exige respetar también el «sí quiero»).
Se prefiere no detectar a detectar de más: un falso positivo calla a un cliente que sí quería los mensajes; un falso
negativo lo cubre el operador con la marca manual y el freno del motor sigue ahí.
Solo cuenta TEXTO (un sticker no es una baja), igual que `wait_reply`.

**D3 — Dónde se detecta.** `onInboundOptOut` se llama en `ingestInboundMessage` ANTES de `onInboundReply`. Así una
respuesta «STOP» a un `wait_reply` da de baja y cancela la ejecución en vez de contarse como «otra cosa». Detrás de la
bandera `AUTOMATIONS` (módulo apagado = comportamiento de siempre). Nunca lanza.

**D4 — Qué hace una baja.** En una transacción: marca el contacto (idempotente: una segunda baja no cambia la fecha) y
**cancela todas las ejecuciones vivas del contacto** (`running`/`waiting`) con sus tareas pendientes — los recordatorios
ya programados no salen. Cada ejecución cancelada deja una fila `skipped_opt_out` en el historial (`reason: 'keyword'`).
No cancela flujos futuros: un disparador nuevo puede crear una ejecución, y es el freno del motor (D5) quien la calla.

**D5 — El freno del motor (la red de seguridad real).** Antes de ejecutar un paso que ENVÍA (`send_whatsapp`,
`send_media`) el motor mira `deps.isOptedOut`. Si el contacto está dado de baja: NO envía, escribe
`skipped_opt_out` (con la foto del paso) y **termina la ejecución** (`markCancelled`, `reason: skipped_opt_out`): no se
sigue «saltando» al paso siguiente. Los pasos que no envían (etiquetas, etapa, esperas, condiciones) no se bloquean: la
baja es de mensajes, no del CRM. Se mira ANTES que la ventana de 24 h y que la plantilla: es la regla que manda.
La baja manual (`PATCH /api/contacts/[id] { optedOut }`, casilla en la ficha del contacto) usa el mismo camino que la
palabra clave.

**D6 — Límite de frecuencia.** Tope por contacto, sumando TODOS los flujos: `AUTOMATION_RATE_LIMIT = { maxMessages: 6,
windowHours: 24 }`. Se cuentan los envíos automáticos **exitosos** (filas `success` del historial cuyo paso es
`send_whatsapp` o `send_media`) de la ventana móvil. Las omisiones y los fallos no cuentan: el contador refleja lo que de
verdad salió. Constantes en código, no ajuste por negocio (ver riesgos).
- Si el envío cabe: sale.
- Si no cabe: **se pospone** al instante en que el envío más antiguo de la ventana deja de contar (`decideRateLimit`
  devuelve `retryAt`), se escribe `skipped_rate_limit` y la tarea vuelve a `pending` **sin gastar un intento** (si gastara,
  `failExhausted` la mataría por «reintentos»). Tope de espera: si la tarea lleva más de 24 h retenida, se **descarta**
  (`skipped_rate_limit` con `action: 'discarded'`, ejecución cancelada): un mensaje de «tu cita es mañana» que sale con
  un día de retraso es peor que no salir.
- Se evalúa DESPUÉS de las comprobaciones que harían fallar al paso (sandbox, canal, ventana de 24 h, plantilla): no se
  retiene lo que de todos modos no iba a salir.
- El control es por contacto, no global: un flujo masivo a muchos contactos no se frena entre sí.

**D7 — `send_media`.** Paso nuevo `{ mediaId, caption?, name? }`.
- `mediaId` es un elemento de la biblioteca de Medios (la misma que usan servicios y logo). El servidor valida que sea de
  la organización al guardar (`assertRefsOwned`), en la API y en el `PUT /graph`.
- Se envía con `sendMediaMessage` (el mismo camino de las personas: archivo → Graph → mensaje persistido en el hilo con su
  vista previa). Una sola vía de envío de adjuntos.
- `caption` admite `{{name}}`, `{{fecha}}`, `{{hora}}`, `{{servicio}}` (`renderVars`), tope 1024 (el de Meta).
- **Solo dentro de la ventana de 24 h**: una imagen o video no tiene plantilla. Fuera de ella el paso falla con
  `out_of_window_media_requires_open_window` (definitivo, no se reintenta). Documentado en la pantalla.
- Falla definitiva `media_not_found` si el elemento se borró; `media_file_missing` si la fila existe pero el archivo no.
- Los dos frenos (D5, D6) y la idempotencia por `hasSuccessLog` aplican igual que en `send_whatsapp`.
- **Tipos soportados hoy: imagen y video**, porque es lo que guarda la biblioteca. El paso y el motor no distinguen el
  tipo: lo deciden los bytes/MIME al enviar (`validateOutgoing`). Documento PDF y audio quedan para cuando la biblioteca
  los admita (formatos, firma por bytes, vista previa): es trabajo de la biblioteca, no del motor, y no se simula aquí.

**D8 — Borrar un medio en uso.** Borrar de la biblioteca un medio que un flujo usa dejaría el paso fallando en silencio.
`borrarMedio` lo rechaza (`in_use`, 409) y dice qué flujos lo usan. Las tareas ya en cola de un paso cuyo medio se borró
igual fallan a la vista (`media_not_found`), por si se borró antes de esta fase.

**D9 — Lienzo.** El bloque «Enviar multimedia» pasa de «Próximamente» a arrastrable. Nodo propio (`MediaNode`) con vista
previa (miniatura de imagen, o un fotograma del video), leyenda y las mismas salidas que un envío. El panel lateral
reutiliza el formulario de `step-dialog.tsx` en modo `inline`: un selector de la biblioteca con vista previa + leyenda.
`send_media` no ramifica: salida `default` (`handlesOf` ya lo cubre).

## Datos

Migración 0072: `contact.opted_out_at timestamp`, `contact.opt_out_source text`. `automation_step.step_type` es texto
con `enum` solo en TypeScript: añadir `send_media` no genera SQL. Índice: el conteo del límite usa
`automation_log_org_contact_idx` (org, contacto) y filtra por fecha; con ≤ miles de filas por contacto es barato.

## Riesgos

1. **Falsos positivos de baja** → D2 conservador + marca manual para corregir + reactivación por palabra.
2. **Carrera baja / envío en vuelo**: una tarea ya tomada puede enviar un instante después de la baja. El freno se mira
   justo antes de enviar (no al encolar), y la baja cancela las ejecuciones bajo el candado del `run`; la ventana que
   queda es la de milisegundos entre la comprobación y la llamada a Meta. Se acepta y se documenta.
3. **Límite como constante**: un negocio con un caso legítimo de >6 mensajes al día no puede subirlo sin tocar código.
   Se decidió así para no inventar una pantalla de ajustes en la última fase; está en un solo lugar
   (`src/lib/automation-compliance.ts`).
4. **Espacio en disco**: `sendMediaMessage` guarda una copia del archivo por mensaje (para su vista previa en el hilo). Un
   video de 50 MB a 1 000 contactos son 50 GB. Mitigación futura: compartir el archivo entre mensajes; no se toca el
   envío de las personas en esta fase.
5. **El agente de IA no se calla con la baja.** La baja frena las AUTOMATIZACIONES (lo que Meta penaliza como mensajes no
   pedidos); el agente solo contesta lo que el cliente le escribe. Si se quisiera, es pausar `ai_paused` aparte.
6. **Sin acuse de baja**: no se responde «te dimos de baja» (sería un mensaje más). Decisión de producto pendiente.

## Pruebas

- Puras: `detectOptOutIntent` (positivos, negativos, acentos, mayúsculas, frases largas), `decideRateLimit`
  (vacío, justo en el tope, ventana móvil, `retryAt`), `sendMediaConfigSchema`, paleta y nodo del lienzo.
- Motor con dobles: baja → `skipped_opt_out` y ejecución cancelada, sin enviar; el orden (baja antes de ventana); rate
  limit → pospone sin gastar intento y descarta pasadas 24 h; `send_media` (éxito, fuera de ventana, medio borrado,
  leyenda con variables, idempotencia).
- Postgres real: la palabra clave da de baja y cancela ejecuciones (con su historial); reactivar; baja manual por API;
  el motor real no envía a un contacto dado de baja; el conteo del límite sobre el historial real; `PUT /graph` con un
  `send_media` de otra organización rechazado; borrar un medio en uso rechazado; aislamiento entre organizaciones.
