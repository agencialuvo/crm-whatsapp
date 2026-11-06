# Vocero CRM — Resumen completo del sistema

> Versión del paquete: **1.6.0** · Licencia MIT · Una instancia = un negocio.
> Documento orientado a dueños, equipo técnico y agencias que implementan Vocero.
> Cubre: arquitectura (TI), módulos, funcionalidades, banderas de activación, seguridad, operación y bondades.

---

## 1. ¿Qué es Vocero?

Vocero es un **CRM para negocios que venden y atienden por WhatsApp**, de código abierto y **self-hosted** (los datos viven en tu propio servidor). Combina cuatro cosas:

1. **Bandeja de WhatsApp en tiempo real** (más Instagram, Messenger y TikTok como canales opcionales).
2. **Pipeline de ventas** tipo kanban.
3. **Agente de IA** que responde con el conocimiento del negocio, agenda citas y escala a una persona cuando hace falta.
4. **Laboratorio de auto-evaluación**: clientes simulados prueban al agente antes de que hable con clientes reales.

Sobre ese núcleo, el **módulo SALON** (barberías, salones, manicure) agrega agenda por sillas, catálogo de servicios y ofertas, equipo con comisiones, caja, gastos, panel ejecutivo, clientes y fidelización.

**Caso de uso en este proyecto:** Brothers Barbershop (barbería), con el módulo SALON, agenda y canales encendidos.

---

## 2. Resumen de TI (arquitectura y tecnología)

### 2.1 Stack

| Capa | Tecnología |
|---|---|
| Framework | **Next.js 15** (App Router) + **React 19**, monolito |
| Lenguaje | **TypeScript** estricto (`strict` + `noUncheckedIndexedAccess`) |
| Base de datos | **PostgreSQL 16** + **Drizzle ORM**; migraciones SQL versionadas en `drizzle/` (53 hasta hoy), aplicadas al arrancar el contenedor |
| Autenticación | **Better Auth** + plugin de organización; roles dueño / administrador / miembro |
| Validación | **Zod** en todo input externo |
| Tiempo real | **SSE** (`/api/events`) sobre un bus en proceso; latido cada ~25 s; recuperación por `since=` |
| UI | **Tailwind CSS**, tema claro/oscuro, acento white-label por organización (por defecto `#0d5bff`) |
| Fuentes | Archivo, Instrument Serif, IBM Plex Mono (autoalojadas con `next/font`) |
| IDs | nanoid con prefijo por tabla (`ct_`, `cv_`, `msg_`, `srv`, `stf`, `sls`…) |
| Gestor | pnpm |
| Pruebas | **Vitest** (133 archivos, ~1.500 pruebas unitarias) + guiones E2E (`tests/e2e/*.md`) conducidos con Playwright/fetch contra mocks |
| Empaquetado | **Docker** multi-stage (standalone), healthcheck `/api/health`; imagen publicada en GHCR por CI |

### 2.2 Principios arquitectónicos (la "constitución")

- **Soberanía:** el núcleo depende solo de PostgreSQL, la API oficial de WhatsApp Cloud y, opcionalmente, un proveedor de IA compatible con OpenRouter/OpenAI. Cualquier otro tercero (Zoom, Google, Zernio, SMTP) entra solo como **conector opcional**, apagado por defecto y con degradación definida: si falla, jamás bloquea la operación.
- **Multi-tenencia por diseño:** toda tabla de dominio lleva `organization_id NOT NULL` y toda consulta pasa por `scoped()`.
- **Idempotencia:** webhooks deduplicados por `wa_message_id` único; estados de mensaje monotónicos (nunca retroceden); seeds y migraciones re-ejecutables.
- **Seguridad de secretos:** cifrado **AES-256-GCM** en reposo; los secretos nunca viajan al navegador ni a logs; el token de WhatsApp y la llave de IA solo muestran sus últimos 4 caracteres.
- **Sandbox del Laboratorio:** las conversaciones de prueba (`is_test`) **jamás** tocan la API real; el emisor lanza excepción si algo lo intenta (es un guardarraíl, no un bug).
- **Solo API oficial de WhatsApp:** nada de sesiones web ni Baileys. Todo el tráfico a Meta pasa por un único cliente (`src/lib/meta/client.ts`).
- **Español** en código, UI y documentación.
- **Trabajo en segundo plano dentro del proceso:** sin colas externas ni Redis; el agente, el Laboratorio y el despacho corren in-process.

### 2.3 Estructura del código

| Carpeta | Contenido |
|---|---|
| `src/app/(app)/` | Pantallas autenticadas |
| `src/app/(auth)/` | Login, registro, recuperar contraseña |
| `src/app/api/` | ~145 route handlers (REST, webhooks públicos, SSE, API de servicio `bot`, mocks de desarrollo) |
| `src/server/` | Lógica de dominio (agenda, ai, analytics, attribution, auth, bot, brains, business, channels, dispatch, inbox, lab, leads, loyalty, notifications, onboarding, whatsapp, zernio, etc.). Nunca se importa desde componentes de cliente |
| `src/lib/` | Fronteras y utilidades: `env`, `db` (schema, `tenant`), `auth`, `crypto`, `meta`, `ai`, `api`, `rate-limit`, `salon`, `loyalty`, `time`, `money` |
| `src/components/` | React por pantalla (`inbox`, `pipeline`, `contacts`, `agent`, `lab`, `results`, `bookings`, `negocio`, `settings`, `medios`, `onboarding`, `ui`) |
| `drizzle/` | Migraciones generadas (no se editan a mano) |
| `specs/` | Especificaciones por feature (001–031) con contratos |
| `tests/` | `unit/` y `e2e/` |
| `docs/` | ADR-001 (canales opcionales), ADR-002 (conectores de agenda), guías |

### 2.4 Flujo de un mensaje de WhatsApp

1. Meta envía `POST /api/webhooks/wa/<token>`. El segmento secreto debe coincidir con `META_WEBHOOK_VERIFY_TOKEN`; la firma HMAC se valida si hay `META_APP_SECRET`. Responde 200 al instante y procesa en segundo plano.
2. **Ingesta:** identifica credenciales por `phone_number_id`, resuelve el contacto, deduplica, descarga adjuntos, guarda el anuncio de origen (si vino de un Click-to-WhatsApp), crea el lead en la primera etapa y publica el evento en vivo.
3. **Decisión de quién responde:** si hay cerebro externo configurado, se despacha allá y el agente incluido calla; si no, corre el agente incluido (si hay IA configurada y está encendido).
4. **Envío:** `inbox/send.ts` rechaza conversaciones de prueba y ventanas de 24 h cerradas, consulta las capacidades del canal, llama a la Graph API, persiste y publica.
5. Los **estados** (enviado, entregado, leído) llegan por webhook y nunca degradan.
6. La UI recibe todo por SSE, con recuperación tras desconexiones.

### 2.5 Despliegue

- **Ruta A:** Coolify (PaaS autoalojado).
- **Ruta B:** `docker compose` + Caddy (HTTPS automático).
- **Otras plataformas:** `render.yaml`, `fly.toml`, `railway.toml`. En este proyecto se usa **Render** (`render.build.yaml`), con repo oficial `agencialuvo/crm-whatsapp`.
- Healthcheck `/api/health`: base de datos, versión, banderas activas, escritura en `MEDIA_DIR`.
- Utilidades de operación: `pnpm init-env` (genera `.env` con secretos), `pnpm doctor` (valida entorno, base, disco y token de Meta), `pnpm crear-usuario`, `pnpm seed:demo`.

### 2.6 Variables de entorno

| Variable | Obligatoria | Para qué |
|---|---|---|
| `APP_BASE_URL` | Sí | URL pública; de ella sale la URL del webhook |
| `DATABASE_URL` | Sí | PostgreSQL (zona horaria fija en UTC) |
| `BETTER_AUTH_SECRET` | Sí | Firma de sesiones (≥16 caracteres) |
| `ENCRYPTION_KEY` | Sí | 32 bytes en base64; cifra tokens y llaves |
| `META_WEBHOOK_VERIFY_TOKEN` | Sí | Verificación y segmento secreto del webhook |
| `META_GRAPH_API_VERSION` | No | Por defecto `v25.0` |
| `META_APP_SECRET` | Recomendada | Valida la firma del webhook |
| `OPENROUTER_API_TOKEN` / `OPENROUTER_MODEL` | No | Respaldo de la IA (lo normal es Ajustes → IA) |
| `BOT_API_KEY` | No | Abre la API de servicio `/api/bot/*` |
| `BRAIN_DISPATCH_URL` | No | Despacha cada turno a un cerebro externo |
| `ALLOW_SIGNUP` | No | Registro público de propietarios con verificación por correo |
| `SMTP_*` | No | Correo saliente (recuperar contraseña, verificación de registro) |
| `AGENT_COALESCE_MS` | No | Espera para agrupar ráfagas (6000 por defecto) |
| `NEXT_PUBLIC_NAV_V2` | No | Menú completo (se lee al construir) |

---

## 3. Banderas de módulos opcionales

Apagadas por defecto; su código viaja siempre en `main` y la migración se aplica igual. Apagada, cada superficie responde **404**.

| Bandera | Qué enciende |
|---|---|
| `AGENDA=on` | Motor de citas, pantalla Citas, Ajustes → Agenda, API `/api/bookings`, `/api/calendar/*`; el agente puede ofrecer y reservar horarios |
| `SALON=on` | Módulo barbería/salón: Panel, Caja, Servicios, Equipo, Gastos, Clientes, agenda por sillas, Marketing (cumpleaños y fidelización) |
| `CHANNELS=whatsapp,instagram,messenger,tiktok` | Canales adicionales con webhooks y pantallas de ajustes propios |
| `ATRIBUCION=on` | Guarda el `ctwa_clid` y reporta conversiones a la Conversions API de Meta (CAPI); Ajustes → Anuncios |
| `NEXT_PUBLIC_NAV_V2=on` | Muestra en el menú Bandeja, Pipeline, Guía de inicio, Agente, Laboratorio y Resultados |
| `SMTP_HOST` + `SMTP_FROM` | Correo saliente |

---

## 4. Módulos y funcionalidades

### 4.1 Núcleo de comunicación

#### Bandeja de WhatsApp (`/bandeja`)
- Tres columnas: conversaciones, hilo y panel del contacto.
- Mensajes entrantes en ≤2 s sin recargar.
- Estados enviado / entregado / leído.
- **Ventana de 24 h** visible y respetada: con la ventana cerrada solo se envían plantillas aprobadas.
- Adjuntos en ambos sentidos: imagen, audio, video, documento, ubicación y contacto, con vista previa; se guardan en tu servidor.
- Respuestas del agente marcadas como IA; **traspaso a humano** con un clic.
- Insignia por canal y, si la conversación vino de un anuncio, "Anuncio · titular" con filtro "Anuncios".
- Eliminar una conversación (mensajes, adjuntos y memoria del agente) desde el panel del contacto.

#### Contactos (`/contactos`)
- Alta automática de quien escribe; búsqueda, notas, archivado.
- **Importación masiva por CSV** con vista previa, sin duplicar y sin llenar el pipeline.
- Marca **"sin agente"** por contacto: sus mensajes llegan a la bandeja pero el agente no contesta.
- Identidad estable (`wa_identity`) compatible con la migración de Meta a identificadores por usuario (BSUID): no se asume que todo contacto tiene teléfono.

#### Pipeline kanban (`/pipeline`)
- Etapas editables (por defecto: Nuevo → En conversación → Interesado → Cliente → Perdido).
- Arrastrar tarjetas, notas, prioridad; el agente mueve leads cuando detecta intención de compra.
- Bitácora de movimientos (quién movió cada lead: persona o bot).

#### Plantillas (`Ajustes → Plantillas`)
- Plantillas de WhatsApp con sincronización de estado y envío desde la bandeja.

#### Canales opcionales (`CHANNELS`)
- **Instagram**, **Messenger** (por Meta o por la API unificada Zernio) y **TikTok** (solo Zernio).
- Cada canal con sus capacidades: duración de ventana, plantillas, longitud de mensaje y tope de mensajes desde el último entrante.
- Ajustes → Estado reúne la salud de todos los canales.

### 4.2 Agente de IA

Descripción técnica detallada en la sección 5.

- Perfil configurable: nombre, tono, instrucciones, reglas de escalado, saludo e interruptor.
- Base de conocimiento: preguntas/respuestas y bloques de texto.
- Acciones: responder, guardar nota del lead, mover de etapa, escalar a humano, y (con `AGENDA`) ofrecer y reservar horarios.
- **Detección de palabra clave de oferta** (con `SALON`): si el cliente llega por un anuncio con el texto precargado de un combo, el agente saluda reconociendo la promoción con su descripción y precio reales.
- Tarjeta **"Quién responde a tus clientes"**: avisa si hay doble respuesta (agente incluido y cerebro externo a la vez) o si nadie puede responder.
- Aviso al dueño cuando el agente está encendido pero sin IA válida (llave faltante, rechazada o sin saldo).

### 4.3 Laboratorio (`/laboratorio`)
- Seis clientes simulados guionados conversan contra el agente real en un sandbox sin envíos reales.
- Un **juez LLM independiente** evalúa cada conversación: veredicto verde / amarillo / rojo y hallazgos (alucinación, fuera de conocimiento, debió escalar, tono).
- **Score 0–100** (verde = 1, amarillo = 0,5, rojo = 0), historial con comparación entre corridas y **sugerencias aplicables con un clic** a la base de conocimiento.
- Corre en segundo plano con progreso en vivo; máximo una corrida por organización; tope de 10 minutos.

### 4.4 Resultados (`/resultados`)
- Prospectos nuevos, tratos ganados y perdidos, dinero cerrado y embudo, contra el periodo anterior.
- Desempeño del agente: rapidez y tasa de traspaso a humano.
- Origen de las ventas por canal y por **anuncio** (con miniatura del creativo).
- Higiene: leads en silencio, mensajes no entregados, ventanas por cerrarse.
- Con agenda: citas realizadas, no asistidas y canceladas.
- No cuenta el Laboratorio; los días se cortan en la zona horaria del negocio.

### 4.5 Atribución de anuncios (`ATRIBUCION`)
- Guarda el `ctwa_clid` de los anuncios Click-to-WhatsApp.
- Reporta conversiones a la **Conversions API de Meta** para optimizar campañas con ventas reales.
- Tarjeta del anuncio de origen siempre visible en la conversación; copia del creativo solo desde hosts de Meta.

### 4.6 Agenda (`AGENDA`)
- Motor de citas universal: horarios por día, huecos disponibles, ofertas de horarios con registro de lo ofrecido y reservas.
- **Conectores de reunión** opcionales: enlace fijo, Zoom y Google Meet. Una cita de prueba nunca llega a un conector.
- El agente solo puede reservar horarios que el sistema le ofreció (sin inventarlos).
- API para cerebros externos: `/api/bot/availability` y `/api/bot/bookings`.

### 4.7 Módulo SALON (barberías, salones, manicure)

| Pantalla | Quién la ve | Qué hace |
|---|---|---|
| **Panel** (`/panel`) | Dueño / administrador | Panel ejecutivo: ingresos, comisiones y gastos del periodo, embudo financiero con gráfica por día, filtros por profesional y servicio, ticket de ventas con oferta vs. servicios sueltos, citas del periodo y clientes que cumplen años |
| **Citas** (`/citas`) | Todo el equipo | **Agenda por sillas**: una columna por profesional, franjas con cupos libres, en vivo; asignar profesional, agendar y cobrar desde la cita. Pestaña de calendario general y bloqueos |
| **Caja** (`/caja`, `/caja/historial`) | Dueño / administrador | Cierre por rango (hoy, ayer, 7 días, mes, personalizado): ingresos, comisiones, ganancia neta, pago por profesional, cuadre por método (efectivo, Yape, Plin, tarjeta, otro), tabla de ventas, exportación CSV, edición y anulación de ventas, **turnos de caja** (apertura con efectivo inicial y cierre con efectivo contado) |
| **Clientes** (`/clientes`) | Dueño / administrador | Ficha única del cliente (ojo/nombre abre la misma ficha), historial, cumpleaños, tarjeta de fidelidad |
| **Servicios** (`/servicios`) | Dueño / administrador | Catálogo de servicios (precio, duración, comisión por defecto, imagen) y **ofertas/combos** con palabra clave única para anuncios (ej. `COMBO_FRESH`); definir qué profesionales dan cada servicio u oferta |
| **Equipo** (`/equipo`) | Dueño / administrador | Profesionales, estado, comisión global, **pactos por servicio**, horario semanal y días libres |
| **Gastos** (`/gastos`) | Dueño / administrador | Egresos fijos y variables, con detalle de compra (paquetes y unidades) |
| **Medios** (`/medios`) | Todos | Biblioteca de imágenes y videos subidos desde el dispositivo, con límites de peso, renombrar y borrado en lote |
| **Notificaciones** (`/notificaciones`) | Todos | Campanita en vivo; las de ventas y caja solo las ven dueño y administrador |

**Reglas de dinero del módulo:**
- Todo en **centavos enteros**; el reparto se calcula en el servidor: `comisión + neto = monto` siempre (una restricción de la base lo exige).
- **Qué porcentaje manda**, de lo más específico a lo más general: el de la venta → el pactado profesional × servicio → el global del profesional → el por defecto del servicio → 50 %. Los porcentajes se limitan a 0–100.
- Las ventas son **historia financiera**: no se borran al eliminar un servicio, combo, profesional o contacto (la API responde `409 in_use` y se ofrece desactivar). Un cobro erróneo se anula (solo dueño/administrador). Una cita se cobra una sola vez.
- **Multicupo garantizado por la base de datos:** una franja se llena cuando coinciden tantas citas como profesionales activos; asignar a alguien ocupado da `409 staff_busy`.
- El "hoy" y los cortes de día salen de la zona horaria del negocio, y los montos de la moneda definida en Ajustes → Marca (soles por defecto).
- **CSV a prueba de fórmulas:** las celdas que empiezan con `= + - @` se neutralizan.
- **Carga masiva desde Excel (.xlsx):** valida cada fila, reporta errores por fila y columna, e inserta las válidas en una sola transacción.

### 4.8 Marketing y fidelización (SALON)

**Campaña de cumpleaños** (`Ajustes → Marketing`)
- Interruptor para activar el descuento; porcentaje (0–100).
- Se aplica **durante todo el mes de cumpleaños** del cliente, no solo el día.
- Se puede restringir a servicios y ofertas específicos; si el servicio no aplica, Caja muestra una alerta.
- **Una vez por año por cliente**; el interruptor de Caja solo aparece si el cliente está en su mes de cumpleaños.
- Una venta con descuento de cumpleaños no suma sello.

**Tarjeta de fidelización**
- Programa activable, con **monto mínimo de venta** para ganar 1 sello (una sola regla para todos los servicios y ofertas; vacío = cualquier venta con cliente).
- **Premios por hito** (cantidad de sellos), con título opcional y canje restringible a ciertos servicios u ofertas.
- Se puede **ajustar sellos** manualmente con contador −/+, con vista previa y tope en la meta de la tarjeta.
- Un canje en una venta evita el sello de esa misma venta.
- Al **editar o anular** una venta, el sello se retira, se otorga o pasa al nuevo cliente según el monto y el cliente resultantes, en la misma transacción.
- Banner de fidelidad en "Editar venta" que explica qué pasará con el sello antes de guardar.

---

## 5. El agente de IA: cómo funciona

### 5.1 Un turno

1. Tras cada mensaje entrante real, si hay IA configurada, se **espera `AGENT_COALESCE_MS`** (6 s) para agrupar ráfagas. Hay un turno por conversación; si llega algo durante el turno, se re-encola un único turno más, sin contestar dos veces.
2. **Cortes antes de llamar al modelo:** sin IA, IA apagada en esa conversación, traspaso a humano activo, interruptor global apagado (el Laboratorio lo ignora), o una persona ya contestó.
3. **Ventana de 24 h cerrada:** el agente nunca manda texto libre; traspasa a humano.
4. **Patrón de respaldo:** si el cliente pide "hablar con un asesor/humano/persona", se envía un acuse fijo y se traspasa sin esperar al modelo.
5. **Prompt:** perfil + base de conocimiento completa ("tu única fuente de verdad") + etapas del pipeline + últimas 20 mensajes + mapa de horarios (con agenda) + instrucción de combo (con SALON) + recordatorio final de responder en JSON.
6. **Llamada al modelo** con extracción robusta de JSON, validación Zod y hasta 3 intentos. Un 401/402 del proveedor pausa la llave; un 429/500 reintenta.
7. **Ejecución de UNA acción:** `none`, `reply`, `update_lead`, `move_stage`, `handoff`, y con agenda `offer_slots` / `book_slot`. Lo que no valida contra las listas permitidas se degrada, nunca se ejecuta a ciegas.
8. **Fallo persistente del proveedor → traspaso a humano** (motivo `error`): el cliente nunca queda sin atención.

### 5.2 Proveedores de IA
- **OpenRouter** (URL fija) u **cualquier API compatible con OpenAI** (OpenAI, Groq, vLLM propio…).
- Configuración desde **Ajustes → IA**: proveedor, modelo (con lista traída del proveedor), llave cifrada y botón **"Probar conexión"**. Las variables `OPENROUTER_*` son solo respaldo.
- Protección contra SSRF: la base URL no puede apuntar a redes internas o locales.

### 5.3 Cerebro externo ("trae tu propio agente")
- Con `BOT_API_KEY`, un microservicio propio conversa por `/api/bot/*` (contexto, mensajes, perfil, ficha, traspaso, escribiendo…, adjuntos, reinicio, disponibilidad y citas) **sin que el token de WhatsApp salga del CRM**.
- Con `BRAIN_DISPATCH_URL`, el CRM le entrega cada turno firmado (outbox en Postgres, tres intentos, caída a humano) y el agente incluido calla: la doble respuesta no puede ocurrir.
- Límites: 1.200 llamadas por minuto con llave válida; 30 fallos por minuto por IP y luego 429.

### 5.4 Configuración recomendada
Ajustes → IA (proveedor, modelo, llave, probar) → pantalla Agente (perfil e interruptor) → base de conocimiento → correr el Laboratorio → encender.

---

## 6. Seguridad y control de acceso

| Tema | Medida |
|---|---|
| Secretos | Cifrado AES-256-GCM; solo se muestran los últimos 4 caracteres |
| Roles | Dueño y administrador configuran; miembros del equipo operan (cobran, ven citas) sin acceso a caja, equipo, comisiones ni catálogo |
| Aislamiento | `organization_id` obligatorio y consultas por `scoped()` |
| Webhooks | Segmento secreto en la URL + firma HMAC (con `META_APP_SECRET`) + deduplicación |
| API de servicio | `X-API-Key` (≥16 caracteres), limitación de tasa y de fallos por IP |
| Registro | Cerrado tras la primera organización; opcional registro público de propietarios con verificación por código al correo (`ALLOW_SIGNUP`) |
| Contraseña | Recuperación por código de 6 dígitos al correo (con SMTP) |
| Mocks | Solo en desarrollo; 404 incondicional en producción |
| Dinero | Enteros en centavos, reparto calculado en el servidor, restricciones en la base |

---

## 7. Bondades del sistema

1. **Tus datos son tuyos:** self-hosted; sin SaaS intermedio ni facturación por mensaje del CRM.
2. **Agente medible, no una promesa:** el Laboratorio da un score y hallazgos concretos antes de exponerlo a clientes, y permite comparar corridas tras cada cambio.
3. **Nunca deja a un cliente sin respuesta:** si falla la IA, el proveedor o la ventana de 24 h, la conversación pasa a una persona con motivo registrado.
4. **Sin lock-in de IA:** cualquier modelo compatible con OpenAI/OpenRouter; puedes cambiarlo desde la app sin tocar código, o conectar tu propio cerebro.
5. **De anuncio a venta:** el anuncio de origen queda visible en la conversación y las conversiones se reportan a Meta, cerrando el ciclo de publicidad.
6. **Operación completa de barbería/salón:** agenda por sillas, comisiones exactas al centavo, caja con cuadre, gastos, panel ejecutivo y fidelización en una sola herramienta.
7. **Retención integrada:** descuento de cumpleaños y tarjeta de sellos con reglas por monto mínimo, sin hojas de cálculo.
8. **Tiempo real:** bandeja, citas, notificaciones y progreso del Laboratorio se actualizan sin recargar.
9. **Multicanal opcional:** WhatsApp primero; Instagram, Messenger y TikTok se activan con una bandera, sin otra rama de código.
10. **Marca propia (white-label):** logo, color de acento y tema por organización.
11. **Operable y verificable:** `pnpm doctor`, healthcheck, migraciones automáticas al arrancar, ~1.500 pruebas unitarias y guiones E2E con mocks.
12. **Resiliente por diseño:** idempotencia en webhooks, estados monotónicos, reintentos con extracción robusta de la salida del modelo, degradación definida de los conectores.
13. **Escalable por instancia:** una instancia por negocio; ideal para agencias que implementan y entregan con evidencia de calidad.

---

## 8. Estado actual y puntos a tener en cuenta

Observaciones de la revisión del código, para planificar:

- **El catálogo de servicios, precios y barberos todavía no llega al prompt del agente.** Existe `getBarbershopAiContext` (`src/server/ai/barbershop-context.ts`) que arma ese texto, pero ningún código lo invoca. Hoy el agente solo conoce lo que esté en la base de conocimiento y, con `SALON`, la oferta cuya palabra clave dispare el mensaje. Hasta conectarlo, los precios y horarios deben cargarse a mano en la base de conocimiento.
- **Los clientes simulados del Laboratorio son de una ferretería** (taladros, martillos, pintura). Conviene reemplazarlos por escenarios de barbería para que el score sea representativo.
- **El saludo automático de cumpleaños por WhatsApp no está operativo.** `src/server/business/marketing-automations.ts` es un esqueleto con el envío comentado y nadie lo invoca. Lo que sí funciona es el **descuento** de cumpleaños en Caja.
- **Estado de la agenda y SALON en producción:** se activan por variables de entorno en Render (`AGENDA`, `SALON`, `CHANNELS`, `ATRIBUCION`, `NEXT_PUBLIC_NAV_V2`). La última se lee al construir, por lo que requiere reconstruir sin caché.
- **Pendientes del lado del negocio:** definir el monto mínimo de sello, configurar Ajustes → IA y WhatsApp en producción (con un token nuevo), cargar la base de conocimiento y rotar las credenciales de Meta que se compartieron por chat.

---

## 9. Referencias internas

- Guía de modificación y mapa del código: `AGENTS.md` y `CLAUDE.md`
- Constitución del proyecto: `.specify/memory/constitution.md`
- Especificaciones por feature: `specs/001` … `specs/031`
- ADR de canales opcionales y conectores de agenda: `docs/adr-001-canales-opcionales.md`, `docs/adr-002-conectores-de-agenda.md`
- Guías: `docs/agenda-conectores.md`, `docs/atribucion-capi.md`, `INSTALL-IA.md`
