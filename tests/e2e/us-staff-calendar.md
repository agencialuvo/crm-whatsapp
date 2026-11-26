# Historia — Calendario por profesional (Mejora 3)

Automatizado en `scripts/e2e-staff-calendar.mjs` (`pnpm test:e2e:staff-calendar`).

**Requisitos**: app corriendo con `AGENDA=on`, `SALON=on`, `GOOGLE_STAFF_CALENDARS=on`, `WA_MOCK_ENABLED=true`,
`GOOGLE_OAUTH_CLIENT_ID` y `GOOGLE_OAUTH_CLIENT_SECRET` (cualquier valor), y `GOOGLE_CAL_BASE_URL`,
`GOOGLE_OAUTH_BASE_URL` y `GOOGLE_ACCOUNTS_BASE_URL` apuntando a `${APP_BASE_URL}/api/dev/google-mock`.

1. **El dueño genera el enlace**: Equipo muestra la columna «Google Calendar». En Carla, el diálogo «Google
   Calendar de Carla» → «Generar enlace (24 h)» muestra el enlace (una sola vez) con «Copiar» y «Enviar por
   WhatsApp» (wa.me a su teléfono).
2. **Carla conecta sin usuario en Vocero**: en otro navegador, sin sesión, el enlace dice qué negocio lo pide
   y que solo se leen sus horarios ocupados; «Conectar con Google» (el mock entra con su cuenta personal y
   solo concede leer) vuelve con «Listo».
3. **Uso único**: reabrir el enlace dice «Este enlace ya no sirve» (ya se usó).
4. **Solo ella queda ocupada**: Equipo la muestra «Conectado»; con un evento en SU calendario y «Leer ahora»,
   reservar con Carla en ese tramo da 409, «cualquiera disponible» entra y queda con Beto, y el tablero pinta
   su celda «Ocupado en Google» (la de Beto, libre).
5. **Desactivarla** desde Equipo revoca su permiso en Google y libera su tramo.

Caminos infelices adicionales (pruebas automáticas): `tests/unit/staff-calendar-routes.test.ts` (403 a un
miembro, 404 con la bandera apagada, enlace vencido, permiso cancelado, `state` alterado: nada se guarda) y
`tests/unit/staff-calendar-live.test.ts` (generar otro anula el anterior, vencido a las 24 h, profesional
inactivo, permiso desmarcado, la cuenta del negocio se rechaza, choques solo con SUS citas, borrar al
profesional no deja bloqueos para todo el negocio, permiso revocado con un aviso, Google caído).
