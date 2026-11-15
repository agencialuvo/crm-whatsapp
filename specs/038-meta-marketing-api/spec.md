# 038 — Conector de la Marketing API de Meta: Campaña → Conjunto → Anuncio y gasto

Nota 2026-11-15: la decisión «solo los anuncios que ya trajeron gente» quedó superada por la [039](../039-meta-catalogo-completo-y-drilldown/spec.md): ahora se lee la cuenta entera.

Estado: **implementado** (la verificación está en la sección Pruebas). Conector OPCIONAL detrás de la bandera `ATRIBUCION` (ADR-001, constitución II/1.4.0).
Reemplaza la decisión **D1/D2 de [019](../019-resultados/spec.md)** («sin gasto publicitario, solo conteos»): el dueño la revierte el 2026-11-14. Sin token configurado, Resultados se comporta exactamente como en 019.

## Por qué

Hoy el CRM sabe de qué **anuncio** vino cada conversación (`referral.source_id`, 018) pero no a qué **conjunto** ni **campaña** pertenece, ni cuánto costó. El webhook de WhatsApp no trae esos datos: hay que preguntárselos a la Marketing API. Con ellos el dueño ve conversaciones, prospectos y citas **por campaña, conjunto y anuncio**, y cuánto le cuesta cada uno.

## Principios (no negociables)

1. **La ingesta nunca espera a Meta.** El único trabajo en la ruta del webhook es un upsert local de una fila pendiente. Todo lo demás vive en segundo plano.
2. **Sin token = como hoy.** Sin credenciales: cero llamadas a Meta, cero errores, cero degradación. Con la bandera apagada: la superficie nueva responde 404 y Resultados no trae campos nuevos.
3. **Un fallo de Meta jamás toca lo core.** Ni la ingesta, ni los conteos de Resultados, ni el agente dependen de que la sincronización funcione.
4. **El token no sale del servidor** (cifrado AES-256-GCM con `lib/crypto`; al cliente solo los últimos 4). Nunca en logs ni en `last_error`.
5. **Multi-tenant**: toda tabla con `organization_id NOT NULL`, toda query por `scoped()`.

## Decisiones

**D1 — Una tabla es catálogo y cola a la vez.** `meta_ad` guarda la jerarquía de cada anuncio y su estado de sincronización (`pending | synced | not_found | failed`) con `next_attempt_at` y `locked_at`. El worker reclama filas vencidas con `FOR UPDATE SKIP LOCKED` (mismo patrón que `automation_queue`): no hay una segunda cola que mantener ni que se desincronice del catálogo.

**D2 — El gasto va en una tabla DIARIA, no en el catálogo.** Se desvía de la propuesta («`spend` en el catálogo»): un único `spend` por anuncio no se puede filtrar por periodo, y Resultados es por periodo. `meta_ad_spend (org, ad_id, date)` guarda el gasto de cada día; Resultados suma el rango. El catálogo queda solo con nombres y jerarquía.

**D3 — Consulta por la cuenta publicitaria, no anuncio por anuncio.** Se desvía de `GET /{ad_id}`: con el `ad_account_id` (ya requerido) se usan los bordes de la cuenta, que son pocas llamadas en lote y además **verifican por construcción que el anuncio pertenece a esa cuenta**:
- Jerarquía: `GET act_{id}/ads?fields=id,name,adset{id,name},campaign{id,name}&filtering=[{field:"id",operator:"IN",value:[…≤50]}]&limit=50`. Un id que no vuelve → `not_found` (anuncio borrado o de otra cuenta). Un id inválido NO tumba el lote (con `?ids=` sí lo haría).
- Gasto: `GET act_{id}/insights?level=ad&fields=ad_id,spend,account_currency&time_increment=1&time_range={since,until}&filtering=[{field:"ad.id",operator:"IN",value:[…]}]&limit=500`, paginado por `paging.cursors.after`.

**D4 — Qué se consulta y cuándo.**
- *Alta*: `registrarAnuncioDeOrigen` llama `enqueueAdLookup` (nunca lanza): si hay credenciales y el `source_id` es un anuncio (no `post`), hace upsert de `meta_ad` como `pending` cuando no existe o `synced_at` tiene > 12 h. Una sola consulta indexada.
- *Credenciales nuevas*: al guardarlas se encolan todos los `source_id` distintos de `ad_attribution` (se recupera la historia).
- *Refresco*: el barrido re-encola los `synced` con > 12 h **que tuvieron atribución en los últimos 90 días** (los nombres se renombran).
- *Gasto*: cada 3 h por organización, anuncios `synced` con atribución en 90 días. Ventana de 7 días hacia atrás (Meta revisa cifras recientes); la primera vez por anuncio (`spend_synced_at` NULL) 90 días.
- *Manual*: botón «Sincronizar ahora» en Ajustes (con enfriamiento de 60 s).

**D5 — Un solo temporizador** (`startMetaAdsWorker`, 60 s) arrancado desde `instrumentation-node.ts` solo con la bandera `ATRIBUCION`, con el estado en `globalThis` y el candado `running` (igual que el worker de automatizaciones). Dentro del proceso, sin colas externas.

**D6 — Errores y límites de Graph (`classifyGraphError`, puro).**

| Clase | Señal | Qué hace |
|---|---|---|
| `auth` | HTTP 401, código 190, 102 | `settings.status='error'` + `last_error` legible; **se detiene todo** hasta que el dueño guarde/pruebe de nuevo. |
| `permission` | código 10, 200–299 | Igual que `auth`, con el mensaje «el token no tiene `ads_read` o no ve esta cuenta». |
| `rate_limit` | códigos 4, 17, 32, 341, 613, 80000–80014 | **No cuenta como intento.** `paused_until` = lo que diga `estimated_time_to_regain_access` del header, o backoff 5→10→20→…→120 min por golpes consecutivos. Las filas siguen `pending`. |
| `transient` | status 0, ≥ 500, códigos 1, 2 | `attempts+1`, `next_attempt_at` con backoff 1 min → 5 → 30 → 2 h → 6 h; tras 6 intentos pasa a `failed` y se reintenta con el ciclo de 12 h. |
| `permanent` | código 100 (parámetro inválido) y demás 4xx | `failed` con el mensaje; no se reintenta antes de 12 h. |

*Header de uso*: `graphRequest` gana un callback opcional `onHeaders`. Se leen `x-business-use-case-usage` y `x-app-usage`; si algún indicador llega a ≥ 90 % se frena **de forma preventiva** (`paused_until`) antes de que Meta responda 17/80004. Los mensajes de Meta se recortan y se les quita cualquier cosa parecida a un token antes de guardarlos.

**D7 — Credenciales por organización** (`meta_ads_settings`): `ad_account_id` (se normaliza a `act_<dígitos>`, admite que pegues el número solo), token cifrado, y lo que devuelve «Probar conexión» (`name`, `currency`). **El token de WhatsApp NO se reutiliza** (a diferencia de CAPI): rara vez trae `ads_read`, y reusarlo daría un error de permisos confuso. Guardar = probar: `GET act_{id}?fields=name,currency,account_status`; si falla no se guarda y el error se explica. Solo dueño/administrador (`canConfigure`). Desconectar borra credenciales y solo las consultas que nunca llegaron a traer nada, **conserva** catálogo y gasto (son historia, como los eventos de CAPI).

**D8 — Moneda.** Una cuenta publicitaria tiene una moneda; se guarda en `meta_ads_settings.currency` y en cada fila diaria. Resultados formatea con ella. Si por cualquier razón hubiera filas de dos monedas en el rango, **no se suman**: el costo de esas filas se omite y se avisa (`mixedCurrency`). Los importes se guardan en `numeric(14,2)` (no float).

**D9 — Costos en Resultados** (definiciones que no se mezclan, igual que 019):
- Gasto de una fila = suma de `meta_ad_spend` del rango (en fechas locales del negocio).
- Costo por **conversación** = gasto ÷ conversaciones que empezaron en el rango; por **prospecto** = gasto ÷ prospectos creados en el rango; por **cita** = gasto ÷ citas creadas en el rango por contactos cuyo primer anuncio es ese (sin canceladas, sin pruebas; **solo con `AGENDA` encendida**, D4 de 019).
- Un costo es `null` («—») si falta gasto o el denominador es 0: **nunca un 0 que parezca dato**.
- Un anuncio con gasto y 0 conversaciones **sí aparece** (es justo el dinero tirado).
- Los anuncios sin catálogo (sin sincronizar, borrados, `post`) caen en la fila «Sin identificar» al agrupar por conjunto/campaña.

**D10 — Agrupar y filtrar.** `GET /api/analytics/ads?group=ad|adset|campaign&campaignId=&adsetId=`. Sin `group` = `ad` (igual que hoy). `groups[]` trae, por fila: id, nombre, nº de anuncios, conversaciones, prospectos, ventas, citas, gasto y costos. La respuesta incluye `hierarchy` (`connected`, `currency`, `lastSyncAt`, `pending`, `problem`) y las listas `campaigns[]` / `adsets[]` para los filtros. Sin la bandera el bloque es **exactamente el de 019, sin una clave más** (`hierarchy` y los demás campos ausentes). Con la bandera pero sin credenciales ni catálogo: `hierarchy.connected=false`, `hasData=false`, y los conteos de 019 con gasto y costos en `null`.

**D11 — Tarjeta de origen del contacto.** `AnuncioDto` gana `adName`, `adsetName`, `campaignName` (null si no hay catálogo). Se muestra «Campaña › Conjunto › Anuncio» sobre el titular. **Sin gasto en la tarjeta** (es del contacto, no del negocio).

## Datos — migración 0073

```
meta_ads_settings   (UNIQUE org)
  id, organization_id, ad_account_id, token_cipher/iv/tag,
  status 'connected'|'error', last_error, account_name, currency,
  paused_until, rate_hits (backoff), last_spend_sync_at, created_at, updated_at

meta_ad             (UNIQUE org+ad_id; INDEX org,status,next_attempt_at)
  id, organization_id, ad_id,
  ad_name, adset_id, adset_name, campaign_id, campaign_name,
  status 'pending'|'synced'|'not_found'|'failed',
  attempts, next_attempt_at, locked_at, last_error,
  synced_at, spend_synced_at, created_at, updated_at

meta_ad_spend       (UNIQUE org+ad_id+date; INDEX org,date)
  id, organization_id, ad_id, date (date), spend numeric(14,2), currency, synced_at
```
Ids: `mas_`, `mad_`, `msp_`. Sin FK a `ad_attribution` (el `source_id` es texto de Meta; el anuncio puede existir sin conversación y viceversa). Las tablas vacías son inertes con la bandera apagada.

## Plan por archivo

| Archivo | Cambio |
|---|---|
| `src/lib/db/schema.ts`, `ids.ts`, `drizzle/0073_*` | las 3 tablas y los prefijos |
| `src/lib/meta/client.ts` | `onHeaders` opcional en `graphRequest` (sin cambiar a los demás llamadores) |
| `src/lib/meta/ads.ts` (nuevo, puro) | `normalizeAdAccountId`, `classifyGraphError`, `parseUsageHeaders`, `backoffMs`, `sanitizeError`, `buildAdsQuery`/`buildInsightsQuery`, `parseAdsPage`/`parseInsightsPage` |
| `src/server/attribution/meta-ads/settings.ts` | CRUD cifrado, vista con últimos 4, `testConnection` |
| `src/server/attribution/meta-ads/catalog.ts` | `enqueueAdLookup`, `enqueueAll`, `claimDue`, `markSynced/NotFound/Failed/Retry`, `refreshStale` |
| `src/server/attribution/meta-ads/sync.ts` | `syncLookups(deps)`, `syncSpend(deps)` con `Deps` inyectables (pruebas sin red) |
| `src/server/attribution/meta-ads/worker.ts` | temporizador, `tickMetaAds`, arranque/parada |
| `src/instrumentation-node.ts` | `resumeMetaAds()` bajo la bandera |
| `src/server/attribution/store.ts` | `registrarAnuncioDeOrigen` → `enqueueAdLookup`; `serializarAnuncio`/consulta con jerarquía |
| `src/lib/types.ts`, `src/components/anuncio-origen.tsx` | `AnuncioDto` + ruta «Campaña › Conjunto › Anuncio» |
| `src/app/api/settings/meta-ads/route.ts` + `…/sync/route.ts` | GET/PUT/DELETE y «sincronizar ahora» (404 sin bandera, `canConfigure`) |
| `src/lib/analytics.ts` | DTOs: `AdRowDto` + jerarquía/gasto/costos, `GroupRowDto`, `hierarchy`, filtros |
| `src/server/analytics/ads.ts` (+ `ads-hierarchy.ts`) | agrupar, gasto por rango, citas por anuncio, costos |
| `src/app/api/analytics/ads/route.ts` | `group`, `campaignId`, `adsetId` (Zod) |
| `src/components/results/ads-section.tsx` | selector Campaña/Conjunto/Anuncio, filtros, columnas de gasto y costo |
| `src/components/settings/ads-client.tsx` | tarjeta «Datos de campañas» |
| `src/app/api/dev/wa-mock/graph/[...path]/route.ts` + estado | `act_*`, `act_*/ads`, `act_*/insights` con modos de fallo por sufijo de token |
| `CLAUDE.md`, `docs/atribucion-capi.md`, `specs/019` | mapa, guía y nota de que D1 queda superada |

## Riesgos

1. **Zona horaria del gasto**: Meta reporta por día en la zona de la cuenta publicitaria; Resultados filtra por zona del negocio. Si difieren, el día de borde puede salir corrido. Se documenta; coinciden en la inmensa mayoría de casos.
2. **Atribución por cohorte**: costo por prospecto/cita divide el gasto del rango entre conteos de cohorte (creados en el rango). Es una aproximación coherente con 019, no una atribución causal.
3. **Cifras que Meta revisa**: por eso la ventana de 7 días; más allá de ella el gasto se congela.
4. **Permisos**: `ads_read` exige la app de Meta con ese permiso (Standard Access basta para tus propias cuentas). Sin él, el error lo dice y nada más se rompe.
5. **Un anuncio con muchas conversaciones y borrado en Meta** queda `not_found`: conserva sus conteos pero sin jerarquía, en «Sin identificar».
6. **Límite de 50 filas** por tabla (`MAX_ANUNCIOS`) se mantiene; al agrupar por campaña rara vez estorba.
7. **Instagram/Messenger** siguen sin `referral` unificado: fuera de alcance (no hay `source_id` que cruzar).

## Pruebas

- **Puras**: normalizar cuenta; clasificación de cada código de error; backoff y tope; lectura de headers de uso (incluido ≥ 90 %); saneado de errores (sin tokens); armado de consultas y páginas (insights con cursor, lote > 50).
- **Sincronización con dobles** (sin red): alta → `synced`; id ausente → `not_found`; rate limit → pausa sin gastar intento; transitorio → backoff y `failed` a los 6; auth → `status=error` y todo se detiene; el token nunca aparece en `last_error`.
- **Postgres real**: `enqueueAdLookup` idempotente y sin credenciales no escribe; `post` no se encola; `claimDue` con `SKIP LOCKED` sin duplicar entre dos pasadas; gasto diario idempotente (re-sincronizar no duplica; revisa cifras); agrupar por campaña/conjunto/anuncio; filtros; costos `null` con denominador 0; anuncio con gasto y 0 conversaciones aparece; citas solo con `AGENDA`; Laboratorio excluido; **aislamiento entre organizaciones**; bandera apagada = DTO de 019 intacto y rutas 404; borrar credenciales conserva historia.
- **Navegador (mock)**: guardar credenciales (y el error de un token sin `ads_read`), llegar un mensaje de un anuncio, ver la jerarquía en la tarjeta y la tabla agrupada con gasto y costo, y el camino infeliz (rate limit y token inválido) sin colgarse.
- Compuerta: `typecheck`, `lint`, `build`, pruebas unitarias y de Postgres real. Sin commit hasta tu revisión.
