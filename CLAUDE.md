# Vocero CRM — Guía para Claude

Lee primero [AGENTS.md](AGENTS.md): el mapa del código y las reglas de
modificación viven ahí; este archivo solo añade lo específico de Claude Code.

Vocero es un CRM de WhatsApp open source (MIT), self-hosted, con agente de IA y
Laboratorio de auto-evaluación. Una instancia = un negocio. Este archivo guía a
Claude Code (u otro asistente) para operar y **modificar** este repositorio —
el caso típico: una agencia adaptando Vocero para un cliente.

## Stack

**Next.js 15 (App Router) + React 19** en monolito · TypeScript estricto
(`strict` + `noUncheckedIndexedAccess`) · Tailwind CSS (sistema de diseño de la
marca Vocero, el mismo de vocerocrm.com: tokens en `src/app/globals.css`, tema
claro/oscuro, acento white-label por defecto `#0d5bff`, fuentes Archivo +
Instrument Serif + IBM Plex Mono self-hosted vía `next/font`; el logo vive en
`src/lib/brand.ts` y se dibuja con `src/components/brand-mark.tsx`) ·
**PostgreSQL + Drizzle ORM** (migraciones versionadas en
`drizzle/`, aplicadas al ARRANCAR el contenedor) · **Better Auth** + plugin
organization · **Zod** en todo input externo · nanoid con prefijos (`ct_`,
`cv_`, `msg_`…) · pnpm · Vitest (unit) + guiones E2E en `tests/e2e/`
conducidos con Playwright · Docker multi-stage (standalone, healthcheck
`/api/health`) · deploy en Coolify (Ruta A) o docker compose + Caddy (Ruta B).

Tiempo real por **SSE** (`/api/events`): heartbeat `: ping` ~25s, headers
anti-buffering, catch-up por refetch con `since=`. Sin WebSockets, sin colas
externas: el trabajo en segundo plano (agente, Laboratorio) es in-process.

## Mapa del código (fronteras de modificación)

| Quieres cambiar… | Toca… |
|---|---|
| El cerebro/proveedor LLM | `src/lib/ai/` (adaptador OpenRouter-compatible, `chatJson<T>`) |
| El comportamiento/prompt del agente | `src/server/ai/prompts.ts` |
| Las acciones que puede tomar el agente | `src/server/ai/actions.ts` + ejecución en `src/server/ai/pipeline.ts` |
| Las personas o el juez del Laboratorio | `src/server/lab/personas.ts` · `src/server/lab/judge.ts` |
| El canal WhatsApp (Graph API) | `src/lib/meta/` (cliente único) + `src/server/whatsapp/` |
| Los canales opcionales (Instagram, Messenger; ADR-001) | `src/lib/channels.ts` (catálogo) · `src/server/channels/` (capacidades y bandera `CHANNELS`) · `src/server/instagram/` · `src/server/messenger/` · `src/server/zernio/` (transporte y firma de la API unificada, compartido) |
| Campos/tablas | `src/lib/db/schema.ts` → `pnpm db:generate` → migración nueva en `drizzle/` |
| La ingesta/envío de mensajes | `src/server/inbox/` (ingest idempotente, send con guard de sandbox, ventana 24h) · **041: todo envío pasa por `enviarYRegistrar` (`outbox.ts`)**: la fila `pending` se inserta ANTES de llamar al canal y se confirma (`wa_message_id`) o queda `failed` con el motivo, en texto, plantilla, ubicación, contacto y adjunto; un rechazo del pre-vuelo no deja fila · un estado que llega antes que su `wa_message_id` se estaciona en `message_status_orphan` y se aplica al guardarlo (`status.ts`: `reclaimOrphanStatus`; webhook y emisor «escriben y luego leen») · `sweepOutbox` (temporizador de 60 s, `outbox-sweeper.ts`) pasa a `failed` lo que lleva 3 min sin id y poda huérfanos de 24 h · `graphRequest` corta a los 30 s (`MetaApiError.ambiguous`: pudo haber salido) · spec [041](specs/041-envio-robusto-y-estados/spec.md) |
| Cómo se identifica a un contacto | `src/server/inbox/identity.ts` (teléfono normalizado o `bsuid:<id>`) |
| Conectar TU propio bot en vez del agente | `src/app/api/bot/*` + `src/server/bot/auth.ts` (X-API-Key) · quién responde (agente incluido, cerebro externo, doble respuesta): `src/server/bot/status.ts` + `GET /api/agent/brain-status` |
| La agenda (horarios, huecos, citas) | `src/server/agenda/` — detrás de la bandera `AGENDA` (`flag.ts`) |
| Cómo se entrega la reunión (Zoom, Meet…) | `src/server/agenda/connectors/` + catálogo en `src/lib/agenda-connectors.ts` · guía: [docs/agenda-conectores.md](docs/agenda-conectores.md) |
| Servicios, combos, equipo (horarios y comisiones), caja y agenda por sillas de una barbería o salón | `src/server/business/` — detrás de la bandera `SALON` (`flag.ts`); contratos Zod, comisiones y DTOs en `src/lib/salon/` · UI en `src/components/negocio/` y las páginas `src/app/(app)/{servicios,equipo,caja}/` y, dentro de `citas/`, la vista por sillas (`board-client.tsx`, `new-booking-dialog.tsx`) (guardián: `src/server/business/page-guard.ts`) · quién da cada servicio u oferta (sin filas = todos): `src/server/business/catalog-staff.ts` · imagen y equipo del catálogo en `catalog.ts`, selector en `src/components/medios/media-picker.tsx` y `src/components/negocio/staff-select.tsx` · multicupo: `buildBusyIntervals` en `src/server/agenda/availability.ts` · spec [031](specs/031-modulo-salon/spec.md) |
| La lista y el hilo de la Bandeja a escala (042: lista por **cursor** `(coalesce(last_message_at, created_at), id)` con filtros y contadores en el servidor, **deltas con `since`** que el cliente pide agrupados (250 ms) en vez de recargar la lista, hilo en páginas de 50 hacia arriba por **hora del evento** `coalesce(wa_timestamp, created_at)`, evento ligero `conversation.read`, `GET /api/conversations/unread` para la barra lateral, reloj de ventana en el cliente y scroll inteligente) | `src/server/inbox/queries.ts` (`listConversationsPage`, `listConversationsDelta`, `listMessagesPage`, `markConversationRead`, `unreadTotal`) · cursores en `src/lib/inbox-cursor.ts` · estado del cliente como funciones puras en `src/lib/inbox-state.ts` (`upsertMany`, `applyDelta`, `insertSorted`, `mergeById`, `latestOnly`: una respuesta vieja nunca pisa a una nueva) y `src/lib/inbox-window.ts` · UI `src/components/inbox/` (`inbox-client.tsx` dueño del estado) · búsqueda SQL compartida con Contactos en `src/server/search-sql.ts` (043: `busquedaEnMensajes` también busca en `message.text` con `EXISTS`, mínimo 3 letras, índice de trigramas `message_text_trgm_idx`, migración 0078) · índices `message_event_idx` y `conversation_list_idx` (migración 0077) · spec [042](specs/042-bandeja-escala-y-rendimiento/spec.md) |
| El tablero del Pipeline (044: columnas paginadas por **cursor** `(position, id)` con conteo y suma de TODA la columna calculados en el servidor, filtros por texto/mensaje/prioridad/etiqueta/canal, orden estable por **renumeración transaccional** dentro de la puerta `moveLeadToStage`, eventos `pipeline.lead`/`pipeline.reordered` + delta con `since`) y el **avance automático del lead** (reglas `first_reply` → «En conversación» al primer envío confirmado de un operador/IA/eco del teléfono, `booking` → «Interesado» al agendar, `sale` → «Cliente» al cobrar en Caja, también salto directo desde «Nuevo»; solo hacia adelante, nunca toca etapas ganadas/perdidas ni etapas abiertas sin papel, idempotente con `onlyIf` bajo candado) | `src/lib/lead-auto-stage.ts` (**`decideAutoStage`**, pura) · `src/server/leads/auto-stage.ts` (`advanceLeadForContact`, `avanzarPorRespuesta`: nunca lanzan) · `src/server/leads/stage-history.ts` (la puerta: `lockPipeline`, `onlyIf`, `autoRule`, renumeración) y `column-order.ts` · consultas en `src/server/leads/board.ts` y rutas `src/app/api/pipeline/{board,stages/[id]/leads}` · papel de etapa `pipeline_stage.auto_role` (único por negocio, `stage-roles.ts`) y `lead_stage_event.auto_rule` · estado del cliente puro en `src/lib/pipeline-state.ts` · UI `src/components/pipeline/` (`pipeline-client.tsx`, `pipeline-filters.tsx`) · ganchos: `outbox.ts` (`automatico`), `ingest.ts` (eco), `agenda/service.ts`, `business/sales-service.ts` · migración 0079 · spec [044](specs/044-pipeline-tablero-solido/spec.md) |
| De qué anuncio llegó cada conversación (siempre visible) | `src/server/attribution/referral.ts` (normalización) · `creativo.ts` (copia de la imagen, solo hosts de Meta) · `store.ts` · tarjeta en `src/components/anuncio-origen.tsx` |
| Los números de Resultados (ventas, agente, origen y anuncios, higiene) | `src/server/analytics/` (un módulo por sección; periodo en la zona del negocio en `period.ts`; exclusión del Laboratorio en `shared.ts`) · contratos y tasas en `src/lib/analytics.ts` · UI en `src/components/results/` · spec [019](specs/019-resultados/spec.md) |
| Automatizaciones de citas (recordatorios «un día antes», no-show, confirmación; `wait_until`, ventana horaria, vigencia de la cita) | `src/lib/automation.ts` (`applySendWindow`, `decideWaitUntil`, `bookingGuard`) · `src/server/automation/{engine,queue,triggers,trigger-store}.ts` · ganchos en `src/server/agenda/service.ts` (`confirmBooking`, crear/reprogramar/cancelar/marcar) · spec [032](specs/032-automatizaciones-citas/spec.md) · tabla `booking.confirmed_at` y `automation_queue.booking_id` |
| Esperar la respuesta del cliente (`wait_reply`: la ejecución queda `waiting/reply`, tarea de timeout, asas `confirmed`/`declined`/`reschedule`/`other`/`timeout`; intención por reglas exactas → LLM → `other`; confirma la cita) y el disparador por anuncio (`ad_referral`, contexto `{{servicio}}`) | `src/server/automation/intent.ts` (clasificador) · `src/server/automation/reply.ts` (`onInboundReply`, llamado desde `ingestInboundMessage`) · `src/server/automation/queue.ts` (`enterReplyWait`, **`resolveReplyWait`**: la única vía que resuelve la espera, bajo el candado del `run`, así la carrera respuesta/vencimiento la gana una sola) · `src/server/automation/ad-referral.ts` (`emitAdReferral`, llamado desde `registrarAnuncioDeOrigen`) · `waitReplyConfigSchema` en `src/lib/automation.ts` · spec [035](specs/035-automatizaciones-espera-respuesta-anuncios/spec.md) |
| Cumplimiento de Meta en las automatizaciones (bajas por palabra clave o a mano, tope de mensajes por contacto, paso `send_media`) | `src/lib/automation-compliance.ts` (**`detectOptOutIntent`**, `decideRateLimit`, constantes del tope) · `src/server/automation/opt-out.ts` (`applyOptOut`, `onInboundOptOut`, llamado desde `ingestInboundMessage` antes de `onInboundReply`) · el freno vive en `processRow` de `engine.ts` (baja → `skipped_opt_out`, tope → `skipped_rate_limit`) · `queue.recentAutomaticSends`/`defer` · `src/server/automation/media.ts` (lee el medio de la biblioteca) · `sendMediaConfigSchema` en `src/lib/automation.ts` · columnas `contact.opted_out_at`/`opt_out_source` · `PATCH /api/contacts/[id] {optedOut}` · borrar un medio en uso → 409 `in_use` · spec [037](specs/037-automatizaciones-cumplimiento-multimedia/spec.md) |
| El Modo Visual de las automatizaciones (lienzo `@xyflow/react`: paleta, nodos por tipo, panel de configuración, validación de topología y guardado atómico; Modo Simple ⇄ Visual) | `src/lib/automation-graph.ts` (**`validateGraph`**, `toLinear`, `autoLayout`, contrato del `PUT`: lo comparten cliente y servidor) · `src/lib/automation-canvas.ts` (paleta, conversión servidor ⇄ lienzo) · `src/server/automation/canvas.ts` (`saveGraph` en una transacción con `updated_at` optimista, `setEditorMode`) · `PUT /api/automations/[id]/graph` y `POST …/mode` · UI en `src/components/automatizaciones/canvas/` (`flow-canvas.tsx` se carga con `next/dynamic` sin SSR; el panel reutiliza `step-dialog.tsx` en modo `inline`) · columnas `automation_flow.editor_mode`/`viewport`/`entry_step_id` · en modo `canvas` las aristas son la verdad y `syncEdges`/`ensureEdges` son inertes · spec [036](specs/036-automatizaciones-lienzo-visual/spec.md) |
| El intérprete de grafo de las automatizaciones (aristas `automation_edge` por asa `default`/`true`/`false`/`late`/`timeout`, ejecución `automation_run` por contacto, `NodeResult`, `emitAutomationEvent`, cancelación en vuelo con candados de fila; el Modo Simple compila la lista a aristas) | `src/lib/automation.ts` (`compileLinearEdges`, `NodeResult`, `EDGE_HANDLES`) · `src/server/automation/graph.ts` (`syncEdges`, `ensureEdges`, `getGraph`) · `src/server/automation/queue.ts` (`completeAndAdvance` por aristas, candado del `run`) · `src/server/automation/events.ts` (`emitAutomationEvent`) · `trigger-store.ts` (`enqueueFirstStep` crea el `run`; `cancelPendingForBooking`) · `GET /api/automations/[id]/graph` · tablas `automation_edge`, `automation_run`, `automation_queue.run_id` · spec [034](specs/034-automatizaciones-grafo/spec.md) |
| Etiquetas de contacto y acciones de CRM de las automatizaciones (`add_tag`/`remove_tag`/`set_stage`, paso `condition` If/Else con `tag_has`·`tag_missing`·`booking_confirmed`·`stage_is`; anti-bucle: un `set_stage` no dispara `stage_changed`) | `src/lib/tags.ts` (contratos, paleta) · `src/server/tags/store.ts` (CRUD y asignación idempotente) · `src/server/automation/actions.ts` (lo que el motor hace sobre el CRM) · `evaluateCondition`/`resolveBranch` en `src/lib/automation.ts` · `viaAutomation` en `moveLeadToStage` (`src/server/leads/stage-history.ts`) · API `src/app/api/tags/` y `src/app/api/contacts/[id]/tags/` · UI `src/components/tags/tag-picker.tsx` (ficha del contacto) y `step-dialog.tsx` · tablas `tag` y `contact_tag` · spec [033](specs/033-automatizaciones-etiquetas-condiciones/spec.md) |
| Qué servicio u oferta persigue el agente según el anuncio de origen (enrutamiento por anuncio; `exclusive`, reglas libres, el primer anuncio gana salvo que no tuviera flujo) | `src/lib/ad-flow.ts` (Zod y reglas puras) · `src/server/attribution/ad-flow.ts` (lista, alta, borrado) · `src/server/ai/ad-flow-context.ts` (datos oficiales del servicio) · directiva en `buildAdFlowDirective` de `src/server/ai/prompts.ts` · UI en `src/components/settings/ad-flows-client.tsx` (Ajustes → Anuncios, detrás de `ATRIBUCION`) · tabla `ad_flow` |
| La atribución de anuncios y el reporte a Meta | `src/server/attribution/` — el `ctwa_clid`, la CAPI y Ajustes → Anuncios detrás de la bandera `ATRIBUCION` (`flag.ts`) + `src/lib/meta/capi.ts` · guía: [docs/atribucion-capi.md](docs/atribucion-capi.md) |
| Campaña › Conjunto › Anuncio y gasto desde la Marketing API de Meta (conector opcional tras `ATRIBUCION`: catálogo `meta_ad` que a la vez es la cola, gasto diario `meta_ad_spend`, gasto de la cuenta `meta_account_spend`, credenciales cifradas `meta_ads_settings`; la ingesta solo encola, nunca espera a Meta; errores y límites de Graph clasificados; **039: lee la cuenta ENTERA** —`syncCatalog` lista `/{act}/ads` cada 12 h, `syncSpend` trae el gasto de todos los anuncios por ventanas de 7 días (≤4 por pasada) y **no reemplaza una ventana truncada**; `requestSpendBackfill` encarga el relleno cuando Resultados pide un rango más viejo, sin llamar a Meta; `cuadrarCuenta` muestra «sin desglosar»; la navegación por clic y las **casillas** (040: selección por nivel que filtra hacia abajo, S1–S8) viven en `src/lib/ads-nav.ts`, pura; el Total de la selección lo calcula `armarJerarquia` con `selected`; **creativos** (040): `syncCreatives` en `meta-ads/creatives.ts` copia la imagen al volumen reusando la descarga acotada de la 018, y `creative{…}` se pide en el listado con reintento sin él; modal en `src/components/results/anuncio-preview-dialog.tsx`) | `src/lib/meta/ads.ts` (puro: **`classifyGraphError`**, backoffs, consultas y lectura de páginas, cabeceras de uso) · `src/server/attribution/meta-ads/` (`settings.ts`, `catalog.ts` = **`enqueueAdLookup`**/`claimDue`/`replaceSpend`, `sync.ts` = `syncOrganization` con `GraphCall` inyectable, `worker.ts` = temporizador de 60 s arrancado en `instrumentation-node.ts`) · gancho en `registrarAnuncioDeOrigen` (`store.ts`) · API `src/app/api/settings/meta-ads/` · Resultados: `src/server/analytics/ads-hierarchy.ts` (**`armarJerarquia`** pura + cargadores) sobre `ads.ts`, DTOs en `src/lib/analytics.ts`, UI en `src/components/results/ads-section.tsx` y `src/components/settings/meta-ads-card.tsx` · el mock de la Graph API ya sirve `act_*` (`-sinads`, `-ratelimit`, `-fail500`, `-uso-alto`) · spec [038](specs/038-meta-marketing-api/spec.md) (reemplaza D1 de 019: el gasto ya es posible) , [040](specs/040-resultados-seleccion-y-creativos/spec.md) (casillas y creativos) y [039](specs/039-meta-catalogo-completo-y-drilldown/spec.md) (cuenta completa, drill-down con migas, Ajustes → Anuncios en una tarjeta; enrutamiento con nombres reales en `src/server/attribution/ad-flow.ts`, datasets en `src/app/api/settings/meta-ads/pixels/`) · guía: [docs/atribucion-capi.md](docs/atribucion-capi.md) |
| La biblioteca de imágenes y videos (subida desde el dispositivo, límites de peso, renombrar, borrado en lote) | `src/lib/medios.ts` (formatos y límites, compartido cliente/servidor) · `src/server/medios/` (`store.ts` disco+BD, `sniff.ts` formato por bytes) · `src/app/api/medios/` (la ruta `…/[id]/archivo` es pública por id) · UI en `src/components/medios/` y `src/app/(app)/medios/` · prueba `pnpm test:e2e:medios` |
| UI | `src/components/` + `src/app/(app)/` |

Los mocks del entorno de pruebas viven en `src/app/api/dev/` (wa-mock +
ai-mock) tras un gate único (`src/lib/dev-guard.ts`): 404 incondicional en
producción.

**Identidad de contacto**: Meta está migrando de teléfono a Business-Scoped
User IDs, así que `from` puede no venir. La llave estable es
`contact.wa_identity` (teléfono normalizado 521→52, o `bsuid:<id>`); `phone` es
un atributo OPCIONAL. Nunca asumas que un contacto tiene teléfono.

**Cerebro externo**: `/api/bot/*` (autenticada por `BOT_API_KEY`) deja que un
microservicio propio conduzca la conversación sin que el token de WhatsApp
salga del CRM: marcar leído + "escribiendo…", descargar adjuntos y reiniciar la
conversación de pruebas. Respeta `conversation.ai_enabled`/`handoff_at` igual
que el agente in-process. Sin la key, esa superficie responde 401 y el CRM
funciona igual.

## Reglas de la constitución (no negociables)

Ver [.specify/memory/constitution.md](.specify/memory/constitution.md).

- **Soberanía (II, endurecida — 1.4.0)**: el NÚCLEO depende solo de WhatsApp
  Cloud API + proveedor LLM OpenRouter-compatible opcional; prohibido meterle
  S3/R2, email, billing u otros terceros. Un servicio de terceros solo entra
  como **conector opcional**: apagado por defecto tras bandera (patrón
  ADR-001), aislado tras adaptador con contrato público, con camino sin
  dependencia externa y degradación definida (su fallo jamás bloquea la
  operación core), credenciales del negocio cifradas, y CI que lo prueba
  apagado y encendido. Auth y BD self-hosted.
- **Seguridad (I)**: secretos cifrados en reposo (AES-256-GCM, `lib/crypto`);
  jamás al cliente ni a logs. El token de WhatsApp solo muestra sus últimos 4.
- **Multi-tenancy (III)**: `organization_id` NOT NULL en toda tabla de dominio;
  toda query pasa por `scoped()` de `src/lib/db/tenant.ts`.
- **Idempotencia (IV)**: webhooks dedup por `wa_message_id` UNIQUE; estados
  monotónicos; seeds y migraciones re-ejecutables.
- **Sandbox del Laboratorio**: las conversaciones `is_test` JAMÁS tocan la API
  real — el sender lanza excepción (no lo "arregles": es un guardrail). Lo
  mismo vale para la agenda: una cita de prueba nunca llega a un conector.
- **Módulos opcionales (015, 016)**: lo que no usa toda instancia va detrás de una
  bandera de despliegue, apagado por defecto, con su superficie en 404 y la
  migración aplicada igual. Nunca en una rama aparte
  ([ADR-001](docs/adr-001-canales-opcionales.md),
  [ADR-002](docs/adr-002-conectores-de-agenda.md)).

## Variables de entorno

`pnpm init-env` crea el `.env` con los secretos ya generados y `pnpm doctor`
lo valida con el mismo esquema del arranque (`safeParseEnv` en
`src/lib/env.ts`), prueba la base, `MEDIA_DIR` y el token de WhatsApp.
Ver `.env.example` (cada una con guía inline). Las claves: `APP_BASE_URL`,
`DATABASE_URL`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY` (32 bytes base64),
`META_WEBHOOK_VERIFY_TOKEN` (segmento secreto del webhook), `META_APP_SECRET`
(opcional, firma). La IA se configura desde la app (Ajustes → IA: proveedor,
modelo y llave cifrada, con «Probar conexión»); las variables solo son el
respaldo mientras no haya nada guardado ahí:

```bash
OPENROUTER_API_TOKEN=sk-or-...
OPENROUTER_MODEL=anthropic/claude-sonnet-4.5
OPENROUTER_JUDGE_MODEL=anthropic/claude-haiku-4.5   # opcional: juez más barato
```

Para el self-test local existe además el modo de pruebas interno (mocks) —
ver `specs/001-vocero-core/quickstart.md`. Nunca actives mocks en producción.

## Manejo de credenciales (obligatorio)

Cuando una feature necesite una variable/credencial nueva: (1) agrégala a
`.env` como placeholder `REEMPLAZA_...` (append), (2) deja guía inline `#` de
cómo obtenerla, (3) resume en el chat y sigue. `.env` está gitignored; para
deploy, las vars van también en la plataforma de hosting (runtime, no build).

## Definición de Hecho REFORZADA (obligatoria)

"Typecheck + lint + build (+ tests)" es el piso, NO el techo. Una feature no
está "Hecha" hasta correr el **self-test de COMPORTAMIENTO de punta a punta**
(Playwright + mocks: `WA_MOCK_ENABLED=true`, `META_GRAPH_BASE_URL` → wa-mock,
`OPENROUTER_BASE_URL` → ai-mock) y dejarlo verde: flujo real como usuario,
resultado observable, y el camino infeliz degradando sin colgarse. Prohibido
delegar la prueba al usuario. Si algo depende de un LLM/proveedor externo,
todo turno tolera formato inesperado con extracción robusta + reintentos — un
hipo del proveedor nunca tumba el turno. Al detectar un fallo: diagnostica,
corrige y re-verifica tú mismo hasta verde (loop de auto-corrección).

Gate técnico:

```bash
pnpm typecheck && pnpm lint && pnpm build && pnpm test
```

Guiones E2E por historia en `tests/e2e/*.md`. Parte de ellos ya están
automatizados: con la app viva y los mocks encendidos, `pnpm test:e2e`
(`scripts/e2e-selftest.mjs`) los conduce contra la app real y sale distinto de
cero si algo falla. Al agregar una historia, extiende el arnés en vez de dejar
solo el `.md`.

## Modo Objetivo — Loop SDD

Cuando el dueño da una META (no prompts paso a paso): Discover → Plan →
Execute → Verify → Iterate, de forma autónoma, volviendo solo con el objetivo
verificado en vivo o con un bloqueo real (decisión de producto, credenciales,
acción irreversible/costosa). Agrupa TODAS las preguntas bloqueantes al inicio.
El estado durable son los artefactos SDD en `specs/` (spec/plan/tasks) —
manténlos al día. Invocable como `/loop-sdd <objetivo>`.

## Memoria persistente

Memoria de archivos en `memory/` (índice `memory/MEMORY.md`, cargado por
sesión). Persiste decisiones, gotchas y correcciones; no dupliques lo que el
repo ya registra. Los subagentes con `memory: project` usan
`.claude/agent-memory/`.

## Arquitectura de agentes

1. **Orquestador** = la sesión principal de Claude Code (este CLAUDE.md + skill
   `loop-sdd`).
2. **Subagentes** (`.claude/agents/`): `deploy-ops` (deploy/logs/healthchecks,
   no escribe código de app) · `public-site-builder` (páginas públicas/legales
   y config de paneles externos).
