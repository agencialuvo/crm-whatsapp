# Feature Specification: Catálogo completo de Meta, navegación Campaña › Conjunto › Anuncio y Ajustes → Anuncios en limpio

**Created**: 2026-11-15

**Status**: **Implementada** (2026-11-15). Pendiente de revisión del diseño y de commit. Verificada contra el mock de la
Graph API (`pnpm test:e2e:meta-ads`, 88 comprobaciones) y Postgres real; **no contra la Marketing API real**.

Ajustes que salieron al implementar (respecto del texto de abajo):
- El listado de la cuenta se salta cuando `catalog_synced_at` es reciente, y va **antes** de las consultas sueltas por id
  (lo que el listado resuelve ya no necesita consulta).
- Resultados arranca por **campaña** cuando hay conector (como el Administrador de Anuncios); si la persona ya eligió otra
  vista, se respeta.
- El selector de «Vincular anuncio» ofrece solo los anuncios que la cuenta aún lista (un borrado no tiene a quién
  enrutarle).
- La lista de datasets sale de `/{act}/adspixels`; **sin verificar contra Meta real** (ver riesgos).

**Input**: pedido del dueño el 2026-11-15, sobre lo entregado en la
[038](../038-meta-marketing-api/spec.md) y la pantalla de Ajustes → Anuncios (016).

**Carril**: completo (Principio VI). Migra (0074), toca un conector opcional y
tres pantallas. Sigue detrás de `ATRIBUCION`: sin la bandera, las rutas siguen
en 404 y el DTO de Resultados es exactamente el de 019 (sin llaves nuevas).

## Contexto

La 038 trajo la jerarquía y el gasto, pero **solo de los anuncios que ya
escribieron por WhatsApp**: la cola `meta_ad` se llena desde la ingesta
(`registrarAnuncioDeOrigen`) y el gasto solo se pide para esos ids
(`adsForSpend`). Consecuencias que el dueño ya vio:

1. Una campaña con gasto pero sin conversaciones (pausada, o que no trajo a
   nadie en el periodo) **no existe** en Resultados: el gasto total no cuadra
   con el Administrador de Anuncios.
2. Los botones «Campaña | Conjunto | Anuncio» y los dos desplegables son
   controles sueltos: para bajar de una campaña a sus conjuntos hay que cambiar
   de pestaña **y** elegir el filtro a mano.
3. Ajustes → Anuncios mezcla tres tarjetas con el mismo propósito (CAPI, datos
   de campañas, registro de eventos) y una tabla de enrutamiento que rotula con
   el titular del creativo y no con el nombre real que el dueño ve en Meta.

## Decisiones (proponer y, si el dueño no las veta, quedan)

- **D1 — La cuenta es la fuente, no los leads.** Cada pasada lista **toda** la
  cuenta publicitaria y trae el gasto **de todos sus anuncios**, tengan o no
  conversaciones. La cola por `source_id` de la 038 se conserva solo para
  resolver anuncios que no aparecen en la cuenta (de otra cuenta, borrados).
- **D2 — Un solo endpoint de jerarquía: `/{act}/ads`.** El pedido nombra
  `/campaigns`, `/adsets` y `/ads`. `/ads` ya trae `adset{id,name}` y
  `campaign{id,name}` anidados, y `effective_status` del anuncio **ya refleja**
  si su conjunto o campaña están pausados (`CAMPAIGN_PAUSED`, `ADSET_PAUSED`).
  Una campaña o conjunto sin un solo anuncio no tiene gasto ni conversaciones:
  no hay nada que reportar de él. Se evitan dos listados paginados de más (y su
  cuota de la Marketing API) sin perder ninguna fila con datos.
- **D3 — Descubrir por gasto, no solo por listado.** El gasto se pide como
  `GET /{act}/insights?level=ad` **sin filtro de ids** y con
  `ad_name, adset_id, adset_name, campaign_id, campaign_name` en los campos.
  Así también aparecen anuncios con gasto que ya no están en el listado
  (borrados): se insertan en el catálogo con sus nombres.
- **D4 — «Al centavo» se prueba, no se afirma.** Además del gasto por anuncio se
  trae el gasto **diario de la cuenta** (`level=account`) y se guarda aparte.
  Resultados enseña el total de la cuenta; si lo desglosado por anuncio no lo
  alcanza (anuncios eliminados que Meta ya no devuelve a nivel anuncio,
  redondeos), la diferencia sale como la fila **«Sin desglosar»** y el total
  sigue siendo el de Meta. Nunca se maquilla.
- **D5 — El rango manda.** Resultados pide cualquier rango (hasta 366 días);
  hoy solo hay 90 días de historial. Si el rango empieza antes de lo cubierto,
  la consulta **encarga** el relleno (`spend_backfill_from`) y la pantalla dice
  «Trayendo el gasto de este periodo desde Meta…» mientras llega, sin bloquear.
- **D6 — Sin actividad no se lista.** Un anuncio del catálogo sin gasto **ni**
  conversaciones en el rango no aparece (serían cientos de filas en cero). Sí
  alimenta los selectores y el enrutamiento. Un anuncio con gasto y 0
  conversaciones **sí** aparece (ya lo hace `armarJerarquia`).
- **D7 — Navegación por clic (drill-down).** Clic en una campaña → pestaña
  Conjuntos filtrada a esa campaña; clic en un conjunto → pestaña Anuncios
  filtrada a ese conjunto. Migas de pan arriba, cada tramo clicable. El estado
  sigue siendo `{group, campaignId, adsetId}` (el de 038): **la API no cambia**
  salvo dos campos de salida; el drill-down es una función pura de ese estado.
- **D8 — Ajustes → Anuncios: una tarjeta «Meta Ads».** Cuenta publicitaria +
  conversiones (CAPI) en una tarjeta; el registro de eventos en un acordeón
  cerrado; el enrutamiento muestra nombres reales.
- **D9 — Dataset/Píxel por lista, con salida manual.** Con la cuenta conectada
  se ofrece una lista de datasets (`GET /{act}/adspixels?fields=id,name`). El
  campo de texto sigue existiendo («Escribir el ID a mano») porque el dataset
  del canal de WhatsApp puede no aparecer en esa lista.

## Datos — migración 0074 (siempre aplicada, aunque la bandera esté apagada)

Todo con `organization_id` NOT NULL y por `scoped()` (constitución III).

`meta_ad` (existente) — añade:
- `effective_status text NULL` — `ACTIVE`, `PAUSED`, `CAMPAIGN_PAUSED`,
  `ADSET_PAUSED`, `ARCHIVED`, `DELETED`, `WITH_ISSUES`… tal cual lo dice Meta.
- `listed_at timestamptz NULL` — la última vez que el listado de la cuenta lo
  devolvió (distingue «de la cuenta» de «resuelto por consulta suelta»).

`meta_ads_settings` (existente) — añade:
- `catalog_synced_at timestamptz NULL` — último listado completo de la cuenta.
- `spend_covered_since date NULL` — el día más antiguo con gasto ya traído.
- `spend_backfill_from date NULL` — hasta dónde quiere Resultados que se rellene
  (la fecha más antigua pedida y aún no cubierta). La borra el worker al llegar.
- `account_timezone text NULL` — `timezone_name` de la cuenta (para avisar si
  difiere de la zona del negocio: Meta corta los días en la suya).

`meta_account_spend` (nueva) — gasto diario de la cuenta, para cuadrar:
`id`, `organization_id`, `day date`, `spend numeric(14,2)`, `currency`,
`synced_at`, **UNIQUE (organization_id, day)**.

Prefijo de id nuevo: `mac`. Los datos viejos siguen valiendo: las columnas nuevas
son nulables y el primer listado completo las llena.

## Sincronización (cambios en `meta-ads/sync.ts`)

Una pasada de una organización, en este orden, cada paso tolerante a fallo
(se clasifica con `classifyGraphError`, igual que hoy):

1. **Resolver pendientes** (`syncLookups`, sin cambio): lo que llegó por webhook
   y no está en el catálogo de la cuenta.
2. **Listar la cuenta** (`syncCatalog`, nuevo) si `catalog_synced_at` es NULL o
   tiene más de 12 h (o `forceSpend`):
   `GET /{act}/ads?fields=id,name,effective_status,adset{id,name},campaign{id,name}&limit=200`,
   paginado por `after` (tope de 50 páginas = 10 000 anuncios; si se pasa, se
   escribe lo traído y se avisa en `last_error`, nunca se descarta en silencio).
   Hace *upsert* por `(organization_id, ad_id)` con `status='synced'`,
   `listed_at=now`. **No** pisa un nombre con `null`.
3. **Gasto por anuncio** (`syncSpend`, reescrito): ventanas de **7 días** desde
   `min(hoy-REFRESH, spend_backfill_from ?? hoy-BACKFILL)` hasta hoy.
   `GET /{act}/insights?level=ad&fields=ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,account_currency&time_increment=1&time_range=…&limit=500`.
   - Cada fila trae su jerarquía: se *upsertea* en `meta_ad` los anuncios que
     faltan (D3).
   - **Se reemplaza la ventana completa de la organización** (borrar los días de
     la ventana y volver a insertar) en una transacción. Es lo que ya hace
     `replaceSpend`, pero **sin la lista de ids**: lo que Meta ya no devuelve
     para ese día se va.
   - **Si la paginación se corta por el tope** (40 páginas por ventana), esa
     ventana **no se reemplaza** (se dejaría el gasto a medias): se conserva lo
     anterior y se avisa. Es la regla contraria a «escribir lo traído» y es
     deliberada: dinero parcial es peor que dinero viejo.
4. **Gasto de la cuenta** (`syncAccountSpend`, nuevo): la misma ventana con
   `level=account&fields=spend,account_currency&time_increment=1` hacia
   `meta_account_spend` (reemplazo de ventana, igual).
5. Al terminar sin que nada la cortara: `spend_covered_since = min(actual, ventana)`,
   se limpia `spend_backfill_from` si quedó cubierto, y `last_spend_sync_at = now`.
   La cuenta además guarda `account_timezone` en el paso 2 (`?fields=…,timezone_name`
   de `buildAccountPath`).

**Presupuesto de llamadas por pasada**: 1 listado (≈1–50 páginas, cada 12 h) +
`ceil(días/7)` ventanas × (1 + páginas) + `ceil(días/7)` de cuenta. Un relleno
de 366 días son ≈52 ventanas: **se hacen como máximo 4 ventanas por pasada**
(la de más reciente primero) y el resto en las siguientes (cada 60 s si hay
relleno encargado; cada 3 h si no). El freno por uso y los límites de la 038
(`USAGE_THROTTLE_PCT`, `rate_limit` → `paused_until`) se mantienen sin cambios.

**Disparo del relleno**: `GET /api/analytics/ads` calcula si
`period.from < spend_covered_since` (o nunca se cubrió) y, de ser así, llama a
`requestSpendBackfill(org, from)` —un `UPDATE` local de una columna— y responde
con `hierarchy.syncing = true`. **La ruta nunca llama a Meta** (la regla de la
038: ni la ingesta ni la lectura esperan a Meta).

## Resultados — cambios

### Datos (`ads-hierarchy.ts`, `analytics.ts`)

- `cargarGasto` ya agrega todo lo que haya en `meta_ad_spend`: con la sync
  nueva incluye anuncios sin conversaciones sin tocar la regla de 038.
- `cargarCatalogo` añade `effectiveStatus`. `AdGroupRowDto` añade:
  `campaignId` (para el clic de conjunto → anuncios) y `status`
  (`active | paused | mixed | null`: una campaña/conjunto está pausada si **todos**
  sus anuncios con actividad lo están).
- `AdRowDto` añade `status` por anuncio.
- Nueva `cargarGastoCuenta(org, period)` + función pura **`cuadrarCuenta`**:
  `{ accountSpend, listedSpend, unattributed }` donde
  `unattributed = round(accountSpend − listedSpend, 2)` y se informa solo si
  `|unattributed| ≥ 0.01`. `AdsHierarchyDto` añade `account: { spend,
  unattributed } | null`, `syncing: boolean`, `timezoneNote: string | null`
  (si `account_timezone` ≠ zona del negocio).
- Fila **«Total»** al pie, calculada por una función pura sobre lo visible, con
  las reglas de 038 (D9 de esa spec: costo `null` si falta gasto o denominador).
  Con la cuenta conectada, debajo: «Gasto de la cuenta en Meta: X» y, si la hay,
  «Sin desglosar por anuncio: Y».
- Sin la bandera o sin credenciales: ninguna llave nueva en el DTO (prueba).

### Navegación (`src/lib/ads-nav.ts`, nuevo, **puro**)

```
type AdsView = { group: "campaign" | "adset" | "ad"; campaignId: string; adsetId: string }
drillInto(view, row)    // campaña → { group:"adset", campaignId:row.key, adsetId:"" }
                        // conjunto → { group:"ad", campaignId:row.campaignId ?? view.campaignId, adsetId:row.key }
                        // anuncio → view (no se baja más)
goToLevel(view, group)  // Campaña: limpia ambos filtros · Conjunto: conserva campaña, limpia conjunto · Anuncio: conserva ambos
crumbs(view, nombres)   // [{label, view}] listo para pintar: «Todas las campañas › Campaña › Conjunto»
```

- `sin-identificar` también se puede abrir con clic (filtra a las filas sin
  campaña/conjunto).
- Cambiar el rango de fechas conserva la vista (como hoy). Si el filtro deja de
  existir en el nuevo rango, la API responde con `[]` y la pantalla ofrece
  «Quitar filtros» (no se vacía en silencio).
- Los dos selectores (`SearchSelect`) se conservan y usan **las mismas
  funciones**: elegir una campaña ahí equivale a hacer clic en ella.
- Accesibilidad: el nombre de la fila es un `<button>` (no un `div` clicable),
  las migas son una `nav aria-label="Ubicación"` con `aria-current` en la última.

## Ajustes → Anuncios — cambios

Estructura nueva de la página (`ajustes/anuncios/page.tsx`):

1. **Tarjeta «Meta Ads»** (reemplaza `AdsClient` + `MetaAdsCard`), con dos
   bloques y un estado arriba (`Conectado · cuenta · última sincronización`):
   - *Datos de campañas y gasto*: cuenta publicitaria + token `ads_read` + botón
     «Sincronizar ahora» (hoy sin cambio de contrato).
   - *Conversiones (CAPI)*: **lista de datasets** (D9) + «Escribir el ID a mano»
     + token opcional + «¿Qué etapa es un lead calificado?».
   Un solo «Guardar» por bloque, cada uno con su error; no se mezclan.
2. **Enrutamiento por anuncio** (`ad-flows-client.tsx`): la primera columna
   muestra **campaña › conjunto › nombre del anuncio**; el titular del creativo
   baja a segunda línea como detalle. `AdFlowRowDto` añade
   `adName/adsetName/campaignName/effectiveStatus` (de `meta_ad`, por
   `source_id = ad_id`). El diálogo «Vincular anuncio» ofrece los anuncios del
   catálogo en una lista con buscador, además del ID a mano. Sin cuenta conectada
   todo sigue como hoy.
3. **«Registro de eventos de conversión»**: la tabla de actividad de CAPI en un
   acordeón **cerrado por defecto** (`<details>`), con el contador en el
   resumen («3 enviadas · 1 falló») para que no haya que abrirlo para saber si algo
   va mal. La lista se pide al entrar (la misma consulta de hoy); lo que cambia es
   que ya no ocupa la pantalla.
4. **Textos**: se reescriben los de ayuda (sin jerga, sin «desliza»). La tabla de
   enrutamiento deja de depender de `min-w-[680px]`: en teléfono cada anuncio es
   una tarjeta (mismo patrón que Resultados), así que no hay scroll lateral que
   explicar. *(El texto literal «Desliza para ver más» no está en este
   repositorio; es el indicio del scroll horizontal de esa tabla, y se elimina de
   raíz quitando el scroll.)*

## Constitution Check

- **I Seguridad**: el token sigue cifrado AES-256-GCM, solo últimos 4 al cliente.
  Los errores guardados pasan por `sanitizeError`. La lista de datasets viaja sin
  el token.
- **II Soberanía**: solo conector opcional tras `ATRIBUCION`; con él apagado o sin
  credenciales, el CRM funciona exactamente como antes. Un fallo de Meta no
  bloquea nada core (la ruta de Resultados nunca espera a Meta).
- **III Multi-tenancy**: `organization_id` en la tabla nueva; todo por `scoped()`.
- **IV Idempotencia**: el reemplazo de ventana es repetible; el upsert del
  catálogo es por `(org, ad_id)`; la migración es re-ejecutable.
- **Sandbox del Laboratorio**: sin cambios (Resultados ya excluye el Lab).
- **Módulos opcionales**: misma bandera `ATRIBUCION`; superficie en 404 sin ella.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Cuentas grandes: miles de anuncios × días agotan la cuota | Ventanas de 7 días, ≤4 por pasada, freno por uso/`rate_limit` de la 038, relleno solo bajo demanda |
| Paginación truncada deja gasto a medias | La ventana truncada **no se reemplaza**; se avisa en `last_error` |
| Zona horaria distinta (cuenta vs negocio) desplaza el gasto de un día | Se guarda `account_timezone` y se avisa en pantalla; no se «corrige» |
| Meta revisa cifras recientes (atribución, ajustes) | Se reemplaza la ventana de 7 días en cada pasada (ya en 038) |
| `/adspixels` no lista el dataset de WhatsApp | La lista es una ayuda; el ID a mano sigue (D9). **Sin verificar contra Meta real** |
| El «al centavo» puede no cumplirse | `cuadrarCuenta` lo hace visible como «Sin desglosar» en vez de ocultarlo |
| Relleno de 366 días tarda varias pasadas | La pantalla lo dice (`syncing`) y no bloquea; se pinta lo ya traído |
| Cambio de forma del DTO rompe a un consumidor | Solo llaves **nuevas**; sin bandera no aparece ninguna (prueba) |

## Plan de pruebas

**Unitarias puras** (`tests/unit/meta-ads.test.ts` y nueva `ads-nav.test.ts`):
- `parseInsightsPage` con nombres de jerarquía; filas sin nombre; moneda mezclada.
- `buildInsightsPath` sin filtro de ids y con `level=account`; `buildAdsListPath`
  con `effective_status` y paginación por `after`.
- `ads-nav`: `drillInto`/`goToLevel`/`crumbs` (campaña → conjunto → anuncio, volver
  por una miga, `sin-identificar`, vista inicial).
- `cuadrarCuenta`: cuadra (sin fila), diferencia positiva, negativa, redondeo de
  centavos, cuenta sin datos.
- Total del pie con costos `null` cuando falta gasto o denominador.
- Estado `active|paused|mixed` de grupos.

**Postgres real** (`tests/unit/meta-ads-live.test.ts`, `GraphCall` inyectado):
- Una cuenta con 3 anuncios sin un solo lead → aparecen en `meta_ad` y su gasto
  en `meta_ad_spend`.
- Anuncio con gasto **ausente del listado** (borrado) → se inserta con sus nombres.
- Un anuncio ya no devuelto en la ventana pierde ese día (reemplazo sin ids).
- Paginación truncada → la ventana **no** se reemplaza y queda el aviso.
- Relleno: `requestSpendBackfill` + varias pasadas cubren el rango, ≤4 ventanas
  por pasada, `spend_covered_since` baja, la columna se limpia.
- `meta_account_spend` + `cuadrarCuenta` extremo a extremo con diferencia.
- Aislamiento entre organizaciones en las tablas nuevas.
- Sin bandera/sin credenciales: el DTO no trae llaves nuevas.

**E2E** (`pnpm test:e2e:meta-ads`, se extiende el mock de la Graph API: listado de
cuenta, anuncios pausados, gasto sin filtro de ids, `level=account`, `timezone_name`,
`/adspixels`): campaña **sin leads** visible con su gasto; el total coincide con la
cuenta; clic en campaña → conjuntos filtrados + migas; clic en conjunto → anuncios;
clic en una miga vuelve; selectores sincronizados con el clic; rango largo muestra
«Trayendo…» y luego los datos; Ajustes: una tarjeta Meta Ads, acordeón cerrado
por defecto y abre con eventos, lista de datasets, enrutamiento con nombres reales,
sin scroll horizontal a 390 px; camino infeliz: token sin permiso y límite de uso.

**Gate**: `pnpm typecheck && pnpm lint && pnpm build && pnpm test`, más los tests
Postgres y el E2E, en claro y oscuro, escritorio y 390 px (capturas revisadas).

## Plan por archivo

| Archivo | Cambio |
|---|---|
| `src/lib/db/schema.ts`, `drizzle/0074_*` | columnas nuevas en `meta_ad` y `meta_ads_settings`; tabla `meta_account_spend`; prefijo `mac` en `ids.ts` |
| `src/lib/meta/ads.ts` | `buildAdsListPath`, `buildInsightsPath` sin ids/`level=account`, `buildAdPixelsPath`, `parseAdsPage` con `effectiveStatus`, `parseInsightsPage` con jerarquía, `parseAccountInsights`, `parsePixels`, `timezone_name` en `buildAccountPath` |
| `src/server/attribution/meta-ads/catalog.ts` | `upsertAccountAds`, `upsertAdsFromSpend`, `replaceSpendWindow` (sin ids), `replaceAccountSpend`, `requestSpendBackfill`, `coverage` |
| `src/server/attribution/meta-ads/sync.ts` | `syncCatalog`, `syncSpend` por ventanas (≤4 por pasada), `syncAccountSpend`, cobertura |
| `src/server/attribution/meta-ads/settings.ts` | `accountTimezone`, `spendCoveredSince`, `catalogSyncedAt` en la vista |
| `src/server/attribution/meta-ads/pixels.ts` (nuevo) | lista de datasets con el token guardado; error clasificado |
| `src/app/api/settings/meta-ads/pixels/route.ts` (nuevo) | `GET` → lista (404 sin bandera, 409 sin credenciales) |
| `src/lib/analytics.ts`, `src/server/analytics/ads-hierarchy.ts`, `ads.ts` | DTO (`status`, `campaignId`, `account`, `syncing`, `timezoneNote`), `cuadrarCuenta`, `totalDeFilas`, relleno por consulta |
| `src/lib/ads-nav.ts` (nuevo) | `drillInto`, `goToLevel`, `crumbs` |
| `src/components/results/ads-section.tsx`, `results-client.tsx` | filas clicables, migas, total, cuenta y «Sin desglosar», estado `syncing` con reintento |
| `src/components/settings/meta-ads-card.tsx` (absorbe `ads-client.tsx`) | tarjeta única, dos bloques, lista de datasets |
| `src/components/settings/capi-events-log.tsx` (nuevo) | acordeón del registro, carga al abrir |
| `src/lib/ad-flow.ts`, `src/server/attribution/ad-flow.ts`, `ad-flows-client.tsx` | nombres reales, tarjetas en teléfono, selector del catálogo |
| `src/app/api/dev/wa-mock/graph/[...path]/route.ts` | listado de cuenta, insights sin filtro, `level=account`, `adspixels`, `timezone_name` |
| `scripts/e2e-meta-ads.mjs`, `tests/unit/*` | lo de arriba |
| `docs/atribucion-capi.md`, `CLAUDE.md`, `038/spec.md` | documentar; 038 marca «solo anuncios con leads» como superado por 039 |

## Qué se decidió NO hacer

- **Listar `/campaigns` y `/adsets` por separado**: D2. Si algún día hace falta
  mostrar campañas **sin anuncios**, se agrega entonces.
- **Mostrar anuncios sin gasto ni conversaciones**: D6.
- **Convertir zona horaria**: se avisa, no se corrige (los días de Meta son los
  de la cuenta).
- **Gasto por colocación, dispositivo o edad**: fuera de alcance.
- **Escribir de vuelta en Meta** (pausar, editar presupuestos): la credencial es
  `ads_read`.
- **Migrar el gasto de Instagram/Messenger** o jerarquía en sus contactos: sigue
  fuera, igual que en 038.

## Preguntas abiertas (con la respuesta por defecto si no se contradice)

1. ¿Ocultar anuncios sin actividad (D6)? — **sí**.
2. ¿Relleno hasta 366 días bajo demanda (D5) o tope fijo de 90? — **bajo demanda**.
3. ¿Quitar `ads-client.tsx` y dejar una sola tarjeta (D8)? — **sí**; el contrato
   `/api/settings/capi` y `/api/settings/meta-ads` no cambia.
