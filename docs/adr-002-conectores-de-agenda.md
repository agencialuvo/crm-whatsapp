# ADR-002 — El motor de agenda entra al core, y los proveedores entran como conectores

**Estado**: aceptado · **Fecha**: 2026-08-26 · **Feature**:
[`015-motor-agenda-universal`](../specs/015-motor-agenda-universal/spec.md)

## Contexto

El README decía que el motor de agendamiento quedaba **fuera de alcance a
propósito**, con dos razones honestas: pesa demasiado para un producto cuyo
argumento es ser ligero, y el estado de qué huecos se ofrecieron pertenece a la
conversación —o sea al agente—, no al CRM.

Mientras tanto, agendar es donde una conversación de WhatsApp se convierte en
negocio, y el fork de agencia que originó a Vocero lleva meses agendando con
Zoom en producción. La pregunta no era si el motor servía, sino dónde debía
vivir sin romper la promesa de ligereza.

[ADR-001](./adr-001-canales-opcionales.md) ya había resuelto la mitad del
problema para los canales: lo opcional se entrega **en el core, apagado, detrás
de una bandera**, porque una rama por feature no se sostiene (su cadena de
migraciones diverge sin arreglo). La prueba está en este mismo repositorio: la
rama `004-motor-agenda`, con el motor entero escrito, quedó irrescatable en 26
días —76 commits atrás y con su migración colisionada— sin que nadie hiciera
nada mal.

## Decisión

**1. El motor entra al core detrás de la bandera `AGENDA`**, apagada por
defecto, con los mismos criterios de ADR-001: superficies en 404, sin rastro en
la UI, sin tokens de prompt, sin pedir credenciales, y la migración aplicada
siempre (unas tablas vacías son inertes).

No se reutiliza `CHANNELS`: agendar no es un canal, y mezclar las dos
taxonomías haría que el contrato de capacidades por canal dejara de significar
lo que dice.

**2. La memoria de lo ofrecido baja al CRM.** El argumento del README era
correcto mientras el CRM no ofreciera la garantía. Al ofrecerla, es el CRM
quien tiene que poder probarla: con esa memoria del lado del cliente, cualquier
cerebro conectado por `/api/bot/*` podría reservar un instante que jamás se
ofreció, y el CRM lo aceptaría. Vocero promete "conecta tu propio cerebro"; una
promesa así no puede depender de que todos los cerebros se porten bien.

**3. Los proveedores entran como conectores, no como integraciones.** Un
contrato público de **cuatro operaciones** —crear, mover, borrar reunión y
probar conexión— medido del uso real del fork, más una quinta opcional
(`refreshMeeting`) que apareció al descubrir que Google crea la conferencia de
forma asíncrona. v1 trae tres: `enlace-fijo` (soberano, default), `zoom` y
`google`.

**4. La disponibilidad NO lee calendarios externos.** El contrato ni siquiera
declara la operación. Es una decisión, no un hueco: meter al proveedor en el
camino caliente acoplaría su latencia y sus caídas a la pantalla que más se
usa. Los compromisos de fuera se reflejan con bloqueos manuales.

**5. El fallo del proveedor no cuesta la conversión.** Los efectos corren
después de escribir la verdad del CRM y son best-effort: la cita se crea con
`link_pending` y el operador reintenta. Sin cola ni cron — el core no tiene
infraestructura para eso, y el reintento manual entrega el 90% del valor con el
10% de la maquinaria.

### Enmienda — Paso 3 (Google Calendar: OAuth y publicación aparte de Meet)

- **Publicar las citas en Google Calendar ya no depende de Meet.** Es una función propia,
  `calendar_settings.google_sync`, apagada por defecto, con su módulo
  (`src/server/agenda/calendar-sync/`). Meet sigue siendo el conector `google` y solo se pide cuando es el
  elegido; con otro conector (o el enlace fijo) la cita se publica igual, sin conferencia.
- **El punto 4 sigue en pie**: la sincronización es SOLO de salida (CRM → Google). La disponibilidad no lee
  Google; eso es el Paso 4 (`freeBusy` como bloqueos guardados, nunca en el camino caliente), y la marca
  `extendedProperties.private.voceroBookingId` que ya lleva cada evento es la que permitirá ignorar los
  eventos propios sin bucles.
- **El punto 5 se matiza** para esta función: hay reintentos automáticos (barrido cada 60 s, espera de
  1 min a 6 h, seis intentos) porque una cita que no aparece en el calendario no se nota en el momento,
  a diferencia de un enlace pendiente. Siguen siendo in-process, sin colas externas, y un 401/`invalid_grant`
  pausa todo hasta reconectar (avisando una vez).
- **Idempotencia por cita**: el id del evento sale de la cita (base32hex determinista) y el `requestId` de
  Meet es `vocero-<bookingId>`. Crear dos veces = 409 → actualizar.
- **Conexión con un clic**: la app OAuth es de la INSTANCIA (`GOOGLE_OAUTH_CLIENT_ID/SECRET`); de cada
  negocio solo se guarda el refresh token cifrado. El modo de pegar credenciales queda como «Avanzado».

### Enmienda — Paso 4 (lo ocupado en Google Calendar como bloqueos)

- **Entrada Google → Vocero, sin tocar el punto 4.** Con `calendar_settings.google_busy` (apagado por
  defecto), un barrido cada 5 min (y «Leer ahora») lista los eventos de la ventana reservable y deja en la
  base exactamente esos tramos como bloqueos (`booking.kind = 'block'`, `busy_source = 'google'`). Ofrecer
  horarios sigue leyendo SOLO la base: Google caído = la agenda funciona con lo último que se leyó.
- **Sin permiso nuevo.** Se usa `events.list`, que ya cubre `calendar.events` (el permiso del Paso 3): nadie
  tiene que reconectar ni la app necesita otra verificación. `freeBusy` se descartó porque no distingue los
  eventos de Vocero (no trae ids ni `extendedProperties`), así que no permitía la regla anti-bucle. Si Google
  responde 403 de permiso insuficiente (credenciales «Avanzado» viejas), queda `needs_reconnect`.
- **Anti-bucle**: se ignora todo evento con `voceroBookingId`/`voceroOrg` y todo id que una cita conoce
  (`calendar_event_id`, o el `external_ref` de un Meet anterior al Paso 3).
- **Nunca pisa lo del negocio**: solo crea/borra filas `busy_source = 'google'`; las citas y los bloqueos
  propios no se tocan, y el índice único `booking_org_active_slot_uq` excluye esas filas (migración 0095)
  para que un tramo de Google que empieza a la misma hora no choque. Desde Vocero no se mueven ni se quitan
  (409 `external_block`): se cambian en Google.
- **Fallos**: 5xx/429 → reintento 1 min→60 min sin rendirse, conservando los bloqueos; una lectura incompleta
  no escribe; 401/`invalid_grant` → la conexión pasa a «se perdió» (un aviso) y se pausa; apagar la opción o
  desconectar quita lo traído de Google.
- **Choques (Mejora 1)**: si un tramo ocupado de Google cae sobre una cita activa que viene, la cita se marca
  (`booking.google_conflict_start/end`, migración 0096) y se avisa una vez por choque (varios en una lectura =
  un aviso). Nunca se cancela ni se mueve la cita: decidirlo es del negocio. La marca se limpia sola cuando el
  choque desaparece, al reprogramar, o al apagar la lectura / desconectar.

### Enmienda — Mejora 2 (varios calendarios)

- **Elegir dónde publicar y qué leer.** `google_credentials.calendar_id` (+ `calendar_summary`) es donde se
  publican las citas (y nace el Meet); `busy_calendars` (hasta 10, null = el de publicar) es lo que se lee
  como ocupado. La lista sale de `calendarList.list` en el momento (Ajustes), nunca en el camino caliente,
  y lo elegido se valida contra la lista FRESCA (publicar exige escribir; «solo libre/ocupado» no se lee).
- **Permiso nuevo detrás de bandera.** `calendar.calendarlist.readonly` solo se pide con
  `GOOGLE_CALENDAR_LIST` encendida (apagada por defecto) para poder desplegar antes de que Google apruebe el
  permiso. `granted_scopes` guarda lo concedido: sin el permiso, todo sigue en el principal (como antes) y la
  pantalla ofrece reconectar, sin llamar a Google. Modo Avanzado: se prueba la lista; un 403 explica cómo
  generar el token con ese permiso o escribir el ID a mano.
- **Reconectar con la misma cuenta conserva lo elegido; otra cuenta lo reinicia** (los ids no sirven entre
  cuentas).
- **Cambiar el calendario de publicación MUEVE las citas que vienen** con `events.move` (mismo id, mismo Meet:
  nada se duplica). Cada cita anota dónde vive su evento (`booking.calendar_event_calendar_id`, migración 0097
  con relleno). Con la publicación apagada se mueven igual los eventos de Meet. Si el evento ya no estaba en
  el calendario anterior, se crea en el nuevo (409 → actualizar).
- **Leer varios calendarios es todo o nada**: si uno falla, no se aplica la lectura y el error lo nombra
  («dejaron de compartirlo» con 404); se conservan los bloqueos.

### Enmienda — Mejora 3 (calendario por profesional)

- **Cada profesional conecta SU Google Calendar, solo lectura** (`calendar.events.readonly`), tras la bandera
  `GOOGLE_STAFF_CALENDARS` (apagada; exige `AGENDA`, `SALON` y la app OAuth de la instancia). Conexión cifrada
  en `staff_google_connection` (migración 0098). Nada se escribe en su calendario.
- **Enlace de 24 h sin usuario en Vocero** (`staff_calendar_invite`): 256 bits aleatorios, en la base solo su
  SHA-256, uso único (marcado condicional), generar otro anula el anterior. Página pública
  `/conectar-calendario/<enlace>` y vuelta en una URI propia, `/api/calendar-invite/oauth/callback` (la del
  negocio exige sesión); `state` firmado con OTRO contexto que el del negocio + PKCE en cookie propia.
- **Anti-bucle**: las reglas del Paso 4 (marca de Vocero / id conocido) y además se RECHAZA conectar la cuenta
  de Google del negocio como calendario de un profesional.
- **Lo ocupado bloquea SOLO a ese profesional**: bloqueos `busy_source = 'google'` con `staff_id`. El motor de
  cupos (`evaluateSlot`, `staffBusy`) lo saca a él del tramo; los demás siguen; el tablero lo pinta en su silla.
  Los bloqueos del negocio (sin profesional) siguen apagando el tramo para todos. La disponibilidad sigue sin
  llamar a Google.
- **Conectado = cuenta**, sin interruptor extra. Desconectar, desactivar o borrar al profesional revoca el
  permiso, borra su conexión y SUS bloqueos (antes de borrarlo: `booking.staff_id` pasa a null y quedarían
  bloqueando a todos) y anula sus enlaces. Los choques (Mejora 1) se cruzan con lo del negocio y lo de SU
  profesional.
- **Publicación**: fuera de alcance; las citas se siguen publicando solo en el calendario del negocio.

### Enmienda — Mejora 4 (avisos al instante, `events.watch`)

- **Google avisa, Vocero lee**: un canal `events.watch` por cada calendario que se lee como ocupado (los del
  negocio y el de cada profesional de la Mejora 3), tras la bandera `GOOGLE_CALENDAR_WATCH` (apagada; exige
  `AGENDA` y que `APP_BASE_URL` sea https con un dominio público). El aviso NO es dato: solo dispara la lectura
  de siempre (`events.list`), con el mismo candado y el mismo anti-bucle. El barrido de 5 min sigue de respaldo.
- **Canales** en `google_watch_channel` (migración 0099): `pending` → `active` (con `resource_id` y vencimiento a
  7 días) o `failed` (reintento 1 min → 6 h; un rechazo permanente, 6 h). Renovación con solapamiento: a menos
  de 24 h se abre otro y el viejo se detiene cuando el nuevo responde. Apagar la lectura, desconectar (negocio o
  profesional), desactivar o borrar al profesional detienen sus canales con `channels.stop` ANTES de revocar el
  permiso. El temporizador de 60 s los mantiene (máx. 20 llamadas a Google por vuelta).
- **Webhook público** `/api/webhooks/google-calendar`: el token del canal es un HMAC del `channel_id` con el
  secreto de la instancia (contexto propio, no se guarda) y se verifica en tiempo constante ANTES de tocar la
  base; luego canal existente, no fallido y con el mismo `resource_id`. Responde 200 enseguida; como mucho una
  lectura por fuente cada 10 s (las ráfagas se juntan) y un aviso que llega con una lectura en curso provoca otra.
- **Sin HTTPS público o con Google fallando**: no se crea nada (o se reintenta) y todo sigue cada 5 min.

## Lo que se descartó

- **Dejarlo fuera y documentar el contrato en un issue** (lo que decía el
  README). Traslada al usuario el trabajo de implementar dos endpoints con dos
  garantías sutiles; el resultado previsible es cada quien reinventándolas mal,
  y la peor de las dos fallas —confirmar una cita que no se creó— es
  silenciosa.
- **Una rama con el motor.** ADR-001 explica por qué; la rama `004` lo
  demuestra.
- **Una skill que parchea el código al instalar.** Blanco móvil: cada
  instalación acaba siendo distinta e irreproducible.
- **Una integración de Zoom cableada, como en el fork** (`zoom_meeting_id` en
  la tabla de citas, cliente propio, sin abstracción). Funciona para un
  proveedor y bloquea al siguiente: el segundo obliga a migrar el esquema.
- **Una segunda bandera para los conectores** (`AGENDA_CONNECTORS=zoom,google`).
  El opt-in real ya lo da la configuración: sin conector seleccionado Y
  credenciales pegadas, ningún código llama a nadie. Sería ceremonia sin
  garantía nueva.

## Consecuencias

- Una instancia default sigue necesitando exactamente lo mismo que antes: un
  VPS, un dominio, credenciales de Meta y un token de LLM opcional.
- La constitución subió a **1.4.0**: el Principio II admite conectores
  opcionales bajo cinco condiciones. Sin esa enmienda, `zoom` y `google` no
  podrían existir en el core ni apagados.
- La CI corre ahora en **dos configuraciones** (todo apagado / todo encendido).
  Es la matriz que ADR-001 prometió y nunca se implementó: se paga aquí, y
  cubre las dos banderas a la vez.
- Van dos banderas (`CHANNELS`, `AGENDA`). El criterio de revisión de ADR-001
  sigue vigente: **a la tercera** conviene sentarse a ver si merecen una
  interfaz común, y del orden de quince es señal de que hace falta un mecanismo
  de extensiones de verdad.
