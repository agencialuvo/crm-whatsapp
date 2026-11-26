# Historia — Google Calendar: conectar con un clic y publicar las citas (Paso 3)

Automatizado en `scripts/e2e-google-calendar.mjs` (`pnpm test:e2e:google-calendar`).

**Requisitos**: app corriendo con `AGENDA=on`, `WA_MOCK_ENABLED=true`, `GOOGLE_OAUTH_CLIENT_ID` y
`GOOGLE_OAUTH_CLIENT_SECRET` (cualquier valor), y `GOOGLE_CAL_BASE_URL`, `GOOGLE_OAUTH_BASE_URL` y
`GOOGLE_ACCOUNTS_BASE_URL` apuntando a `${APP_BASE_URL}/api/dev/google-mock`.

1. **Conectar**: Ajustes → Agenda muestra «Sin conectar» y «Conectar con Google». Al pulsarlo, el mock de la
   pantalla de permisos acepta y se vuelve con «Google Calendar conectado» y «Conectado como
   agenda@negocio.mock». La URL queda limpia y la API no devuelve secretos.
2. **Encender la publicación** desde el interruptor de la tarjeta.
3. **Una cita** (conector enlace fijo) aparece como «Cita — Ana P.», sin Meet, sin teléfono ni apellido, con
   el enlace fijo en el lugar y un id `vcr…`. Moverla mueve el MISMO evento; cancelarla lo borra.
4. **Google caído**: la cita se crea igual (201), queda «error» y se reintentará sola; al reintentar se
   publica con un único evento.
5. **Lo ocupado en Google (Paso 4)**: con un evento del dueño sembrado en el mock, encender «Tener en cuenta
   lo ocupado en Google Calendar» muestra «Última lectura … · 1 tramo ocupado». Ese horario deja de ofrecerse,
   reservar encima da 409 `slot_taken` y quitar el bloqueo desde Vocero da 409 `external_block`; lo marcado
   «Disponible» se sigue ofreciendo. Google caído + «Leer ahora» → aviso y el bloqueo se conserva. Borrado en
   Google + «Leer ahora» → el horario vuelve. 403 de permiso → «Falta permiso para leer tu calendario» con
   «Reconectar con Google», conservando lo último leído. **Mejora 1**: un evento nuevo encima de una cita ya
   agendada la marca «Choca con tu Google Calendar» (Lista y panel), llega UN aviso (leer otra vez no lo
   repite) y la cita sigue agendada; al quitar el evento en Google la marca se va sola.
6. **Varios calendarios (Mejora 2, con `GOOGLE_CALENDAR_LIST=on`)**: la primera conexión no concedió la lista
   (`_calendars {grantCalendarList:false}`, como una conexión antigua) → la tarjeta dice «Nuevo: elige tus
   calendarios» con «Reconectar con Google» y todo sigue en el principal. Al reconectar aparece el selector:
   para publicar solo los calendarios con escritura; «Socio» (libre/ocupado) no se puede marcar. Publicar en
   «Equipo» MUEVE la cita que venía (mismo evento) y la siguiente nace ahí; marcar «Personal» hace que su
   evento bloquee la agenda.
7. **Desconectar** desde la pantalla: «Google Calendar desconectado», sin conexión, el permiso revocado y sin
   bloqueos de Google.

Camino infeliz adicional (pruebas automáticas): `tests/unit/google-oauth.test.ts` (state alterado, vencido o
de otra sesión, sin cookie, permiso desmarcado, sin refresh token, prueba de escritura fallida: nada se
guarda) y `tests/unit/google-calendar-sync-live.test.ts` (respuesta perdida → 409, token revocado → pausa y
un aviso, cambio a mitad de intento, Laboratorio y sincronización apagada → cero llamadas). Paso 4:
`tests/unit/google-calendar-busy.test.ts` (reglas, anti-bucle, ventana, partir por día, diff, mock) y
`tests/unit/google-calendar-busy-live.test.ts` (crear/actualizar/limpiar, no pisar lo propio, Google caído,
lectura a medias, token revocado, 403, apagar a mitad de una lectura). Mejora 2:
`tests/unit/google-calendars.test.ts` (reglas de elección, permisos según la bandera) y
`tests/unit/google-calendars-live.test.ts` (sin permiso = como antes, roles, validación con la lista fresca,
misma/otra cuenta, mover citas y Meet, varios calendarios, calendario que dejaron de compartir, Avanzado).
