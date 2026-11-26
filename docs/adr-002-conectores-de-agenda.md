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
