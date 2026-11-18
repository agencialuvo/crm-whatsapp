# 047 — Automatizaciones: disparador «Llegó de un anuncio» por Campaña › Conjunto › Anuncio, con miniaturas y nombres vivos

**Feature Branch**: `feat/047-automatizaciones-selector-anuncios-jerarquico`

**Created**: 2026-11-18

**Status**: **Implementada** (2026-11-18), con las nueve preguntas aprobadas tal como se recomendaron (Q1 los tres niveles con árbol perezoso, Q2 retraso de ~1–2 min en campaña/conjunto del primer mensaje de un anuncio nuevo, Q3 sin Marketing API solo «un anuncio», Q4 12 h + botón «Actualizar desde Meta», Q5 validar `campaignId`/`adsetId` al guardar, Q6 idempotencia por alcance, Q7 miniatura local, Q8 mismo permiso que editar automatizaciones —dueño o administrador—, Q9 E2E diferido). Pendiente de commit. Verificada con unitarias, vigilancia y **17 pruebas contra Postgres real** (`ad-trigger-live`); **el E2E con navegador NO se corrió** (diferido) y el selector **no se ha visto en un navegador**.

Ajustes que salieron al implementar (respecto del texto de abajo):
- **El gancho vive en `markSynced` y en `upsertAccountAds`** (las dos puertas por las que el catálogo aprende la jerarquía de un anuncio), no en `syncOrganization`.
- **`enqueueAdLookup` exige la cuenta publicitaria conectada**: sin credenciales ni siquiera se encola la fila pendiente y un flujo de campaña/conjunto no puede evaluarse (coherente con Q3). Las pruebas siembran la fila pendiente que dejaría la ingesta.
- **El árbol ofrece solo lo que la cuenta todavía lista** (`listed_at`), como `listCatalogAds`; **resolver** lo ya guardado cuenta cualquier anuncio sincronizado (un flujo atado a un anuncio archivado se sigue mostrando con su nombre).
- **No se vuelve a exigir el alcance en el catálogo si no cambió**, tampoco al guardar el lienzo (`saveGraph`): editar el nombre de un flujo cuya campaña ya no está en Meta no debe fallar.
- **`describeTrigger` sin catálogo** muestra el ID y «(aún sin sincronizar desde Meta)»; se actualizó la prueba que esperaba el texto viejo.
- **La lista de flujos devuelve `triggerSummary`** (nombres vivos) y no la configuración cruda; el detalle y el lienzo también lo muestran (el lienzo lo resuelve con `?resolve=`).
- **El permiso del endpoint es `automationGate`** (dueño/administrador y `AUTOMATIONS` encendido), además de `ATRIBUCION`.

**Input**: Dos mejoras al disparador `ad_referral` de Automatizaciones: (1) elegir el disparador con la jerarquía de Meta (toda una campaña, un conjunto o un anuncio) con miniaturas del creativo; (2) que los nombres que se muestran sean siempre los actuales de Meta, sin romper nunca un flujo por un cambio de nombre.

**Carril**: ciclo completo (Principio VI). **Sin tabla nueva.** Probablemente **una migración mínima** (un índice, ver «Datos»), **un endpoint nuevo** (`/api/automations/ad-options`), **un componente nuevo** (selector en árbol con miniaturas) y **un cambio de contrato** del `trigger_config` de `ad_referral` (compatible hacia atrás). Todo detrás de lo que ya existe: la bandera `ATRIBUCION` y, para la jerarquía, el conector de la Marketing API de Meta (038/039/040), que sigue siendo opcional.

## Lo que encontré (leído del código)

La buena noticia: **buena parte de lo que se pide ya existe como dato**; lo que falta es leerlo en el selector y ampliar la regla de coincidencia.

1. **El selector de hoy** (`flow-dialog.tsx` y `canvas/inspector/trigger-inspector.tsx`) se alimenta de `GET /api/settings/ad-flows`, es decir, **de los anuncios que ya tienen una fila de «enrutamiento por anuncio»** (`ad_flow`), no del catálogo de Meta. Etiqueta = `headline` (el titular que Meta mandó en el primer mensaje) o, si no hay, el ID crudo. Ese titular es una **foto del momento** y **nunca se actualiza**: por eso un renombre en Meta no se ve. Además esa ruta exige `ATRIBUCION` y rol de dueño/administrador.
2. **El flujo ya se ata por el ID inmutable.** `trigger_config` guarda `{ sourceId }` (el `source_id` del anuncio de Meta, que es el `ad_id`) y la coincidencia es `only === input.sourceId`. **Un cambio de nombre en Meta no rompe ningún flujo hoy**; lo único que queda viejo es lo que se *muestra*. El requisito 2.1 («referenciar por ID») ya se cumple; falta cumplir el 2.2 (mostrar el nombre vivo).
3. **El catálogo de la Marketing API ya trae todo** (`meta_ad`, spec 038/039/040): `ad_id`, `ad_name`, `adset_id`, `adset_name`, `campaign_id`, `campaign_name`, `effective_status`, y el creativo (`creative_title`, `creative_body`, `creative_asset_id` = **copia local de la imagen** en el volumen). Es la misma tabla que alimenta Resultados y Ajustes → Anuncios. `syncCatalog` repasa la cuenta **cada 12 h** y actualiza los nombres; el índice `meta_ad_org_campaign_idx` ya existe, el de conjunto no.
4. **Ya hay un precedente de «nombre vivo»:** `enriquecerConCatalogo` (`attribution/ad-flow.ts`) pone el nombre real de anuncio/conjunto/campaña **al leer**, con un `JOIN` por `ad_id`, y `listCatalogAds` arma las etiquetas `Campaña › Conjunto › Anuncio` (tope 300). Este spec reutiliza ese patrón.
5. **Las miniaturas ya no caducan:** Meta da URLs de imagen que expiran; 040 las **copia al volumen** (`creative_asset_id`) y la UI las sirve por `/api/medios/{id}/archivo`. El selector debe usar **esa copia**, nunca la URL de Meta (caduca y es de un tercero).
6. **El `ad_id` llega pegado a la conversación:** `registrarAnuncioDeOrigen` guarda el `sourceId`, **encola** la consulta a la Marketing API (`enqueueAdLookup`, que solo escribe en la base, nunca espera a Meta) y emite `ad_referral`. **Consecuencia clave:** en el instante en que llega el primer mensaje de un anuncio nuevo, **su campaña y conjunto todavía no se conocen** (el worker de 60 s los resuelve después).

> **Ajuste al encargo.** El encargo menciona `thumbnail_url` / `image_url` de Meta y «actualizar la tabla». No se guarda nada nuevo: se lee `meta_ad` al momento (nada que se desincronice) y la miniatura es la **copia local** del creativo.

## Diseño

### D1 · Un flujo puede apuntar a una campaña, un conjunto o un anuncio

`trigger_config` de `ad_referral` pasa de `{ sourceId? }` a **exactamente uno** de:

| Config | Significa |
|---|---|
| `{}` o sin config | Cualquier anuncio (**como hoy**) |
| `{ sourceId: "<ad_id>" }` | Ese anuncio (**como hoy**, sin migrar nada) |
| `{ adsetId: "<adset_id>" }` | Cualquier anuncio de ese conjunto |
| `{ campaignId: "<campaign_id>" }` | Cualquier anuncio de esa campaña |

- **Retrocompatibilidad total:** los flujos existentes quedan idénticos (`{ sourceId }` o vacío). No hay migración de datos: es JSON y la clave nueva es aditiva. El esquema Zod (`automation-schemas.ts`) acepta una de las tres claves (más ninguna) y rechaza combinaciones.
- **Lo que se guarda son solo IDs.** Nunca nombres: así un renombre en Meta no puede romper ni desactualizar nada. (Si una campaña se borra en Meta, el flujo conserva el ID; en pantalla se ve «Campaña (ID …) · ya no está en Meta».)
- Función pura nueva `matchesAdTrigger(config, ad: { adId, adsetId?, campaignId? })` en `src/lib/automation.ts`, reemplazando la comparación suelta de `ad-referral.ts`.

### D2 · Resolver la jerarquía de un anuncio al disparar (y qué hacer si aún no se conoce)

- Disparador **por anuncio**: igual que hoy, **inmediato** y sin depender de Meta.
- Disparador **por conjunto o campaña**: hay que conocer el conjunto/campaña del anuncio. Se lee `meta_ad` por `(organization_id, ad_id)` (una consulta indexada).
  - Si el anuncio **ya está sincronizado**: se evalúa y dispara al instante.
  - Si **todavía no** (primer mensaje de un anuncio nuevo): ese flujo **no se descarta ni se adivina**; se **re-evalúa cuando el worker resuelve el anuncio** (`syncOrganization` ya lo marca `synced`). Un gancho `emitDeferredAdReferrals(org, adId)` busca las conversaciones de las últimas **48 h** con ese `source_id` y vuelve a emitir **solo para los flujos con alcance de conjunto/campaña**. La idempotencia ya existe (`automation_run` es único por `org + flujo + contacto + dedupeKey`), así que repetir no duplica.
  - Consecuencia visible: el primer cliente de un anuncio nunca visto dispara los flujos de campaña/conjunto con **~1–2 minutos de retraso** (lo que tarda el worker), no al instante. Es el precio de no esperar a Meta dentro del webhook.
  - **Sin conector de la Marketing API** (catálogo vacío): los alcances de conjunto y campaña **no se pueden evaluar**; el selector ni los ofrece (solo «Un anuncio», como hoy) y se explica por qué.
- **Idempotencia por alcance.** Hoy la llave es `ad_referral:{adId}` por contacto y flujo. Con alcance de campaña, un contacto cuya atribución se **reemplaza** por otro anuncio de la misma campaña arrancaría el flujo dos veces. Para evitarlo, la llave de los flujos con alcance pasa a ser por alcance (`ad_referral:campaign:{id}` / `:adset:{id}`) y se calcula **por flujo** (cambio chico en `emitAutomationEvent`: un `dedupeKeyFor(flow)` opcional, por defecto el actual).

### D3 · Endpoint para el selector: `GET /api/automations/ad-options`

Un endpoint **solo de lectura**, de la propia organización (nunca recibe `organizationId`), `withAuth`, rol que puede configurar automatizaciones, **404 sin `ATRIBUCION`** (mismo trato que `/api/settings/ad-flows`). Reutiliza `listCatalogAds` y el patrón de `enriquecerConCatalogo`.

Para no bajar miles de anuncios de golpe (una cuenta real tiene cientos o miles), es **perezoso por nivel** y con búsqueda en el servidor:

```
GET /api/automations/ad-options                         → { campaigns: [...], connector, freshness }
GET /api/automations/ad-options?campaignId=…            → { adsets: [...] }
GET /api/automations/ad-options?adsetId=…               → { ads: [...] }
GET /api/automations/ad-options?q=texto                 → { results: [...] }   (planos, con su ruta Campaña › Conjunto › Anuncio)
GET /api/automations/ad-options?resolve=id1,id2,…       → nombres/miniatura de lo que ya está elegido (para mostrar un flujo guardado)
```

Cada elemento trae: `campaign_id/name`, `adset_id/name`, `ad_id/name`, `thumbnail_url` (ruta **local** `/api/medios/{asset}/archivo`, o `null`), `status` (`ACTIVE`/`PAUSED`/…) y `adCount` en campañas y conjuntos. Los nombres salen de `meta_ad` **en cada lectura** (nombre vivo). Las listas se ordenan activos primero y luego por nombre; páginas de 50 por cursor `(nombre, id)` siguiendo la regla de listas del sistema.

**Sin catálogo** (conector apagado o sin credenciales): `connector: false` y `campaigns: []`; el selector cae a su comportamiento actual (anuncios que ya trajeron gente, por `ad_attribution`/`ad_flow`, con su titular) y solo permite «Un anuncio». Así **nada se rompe** sin la Marketing API.

**Seguridad y minimización:** solo metadatos de anuncios de la propia organización; nunca URLs de Meta (caducan y filtran un tercero), tokens ni conversaciones. La lista blanca de campos se vigila con una prueba, como en 045.

### D4 · El selector en árbol (React)

Un componente nuevo `AdTriggerPicker` (`src/components/automatizaciones/ad-trigger-picker.tsx`) que reemplaza al `SearchSelect` plano en `flow-dialog.tsx` y `trigger-inspector.tsx` (los dos lo usan). La lógica del árbol (aplanar, buscar, resumen del valor, estado perezoso) vive en funciones **puras** `src/lib/ad-picker.ts` para probarla sin navegador, como el resto del sistema.

- Un botón muestra lo elegido: miniatura + nombre + ruta (`Campaña › Conjunto`) + ID; o «Cualquier anuncio».
- Al abrirlo: **cuadro de búsqueda arriba** (regla del sistema: todo desplegable tiene buscador) y debajo el árbol **Campaña ▸ Conjunto ▸ Anuncio**. Cada nivel se despliega con su flecha (carga perezosa, «Cargando…», «Reintentar»).
- Cada fila tiene su acción de elegir: **«Toda la campaña (N anuncios)»**, **«Todo el conjunto (N anuncios)»** y, en cada anuncio, el propio anuncio con su **miniatura** (imagen; si falta, un icono neutro), nombre, conjunto/campaña en pequeño, estado (activo/pausado) y el **ID de Meta** en gris.
- Con texto en el buscador, la lista se vuelve **plana** (resultados con su ruta) y desaparece la jerarquía hasta borrar el texto.
- **Accesible:** teclado (↑ ↓ para moverse, → ← para desplegar/plegar, Enter para elegir, Esc para cerrar), `role="tree"`/`treeitem` con `aria-expanded`, X para cerrar en móvil (regla de ventanas) y funciona a ancho de teléfono.
- **Valor guardado que ya no está en el catálogo** (anuncio borrado, o aún sin sincronizar): se muestra «Anuncio ID … (sin sincronizar)» y **se puede conservar**; nunca se borra por no encontrarlo.
- El texto de ayuda se actualiza: ya no dice «aparecen cuando ya llegó alguien»; explica el alcance elegido.

### D5 · Los nombres vivos también en el resto de la pantalla

- `describeTrigger` (lista, detalle y lienzo) hoy imprime el ID crudo del anuncio. Pasa a mostrar «Llegó del anuncio **Promo Mayo** (Campaña Verano › Conjunto Lima)», «Llegó de cualquier anuncio de la campaña **Verano**», etc.
- Para no hacer N consultas, `GET /api/automations` (la lista) y `GET /api/automations/[id]` **enriquecen en bloque** los flujos `ad_referral` con una sola consulta a `meta_ad` por `ad_id`/`adset_id`/`campaign_id` (patrón de `enriquecerConCatalogo`), y devuelven `triggerLabel` ya resuelto; el cliente no resuelve nada.
- Un flujo cuyo anuncio/conjunto/campaña no está en el catálogo se muestra con su ID y una nota; **no** se cambia ni se invalida.

### D6 · «Tiempo real» — qué es y qué no es

Los nombres se leen de `meta_ad` **en cada petición**, así que lo que muestra el selector es **exactamente lo último que el CRM sincronizó**, sin copias ni reseteos. Pero el CRM solo se entera de un renombre de Meta cuando **sincroniza el catálogo**, hoy **cada 12 h** (o al pulsar la sincronización manual de Ajustes → Anuncios). Por tanto:

- **No es instantáneo** respecto de Meta: puede tardar hasta 12 h, o segundos si el operador sincroniza a mano.
- El selector muestra «Catálogo actualizado hace N h» y un botón **«Actualizar desde Meta»** que reusa el endpoint de sincronización existente (`/api/settings/meta-ads/sync`, con su límite de tasa). Mientras sincroniza, el selector refresca solo.
- Meta no manda webhooks de renombre a esta integración; **recortar las 12 h** exigiría consultar más seguido (más cuota de la Marketing API). Se deja como pregunta (Q4).

## Datos

- **Sin tablas nuevas ni columnas nuevas.** `meta_ad` ya tiene todo.
- **Migración 0082 (una sola, aditiva):** índice `meta_ad_org_adset_idx` sobre `(organization_id, adset_id)` — para listar y contar anuncios de un conjunto y para resolver `adsetId`. (`meta_ad_org_campaign_idx` y `meta_ad_org_ad_uq` ya existen.) Una tabla pequeña; crearlo es instantáneo.
- `trigger_config` (jsonb) cambia de contrato, compatible: ver D1. No hay que reescribir filas.

## Cambios de código por archivo (plan)

**Puros (`src/lib/`)**
- `src/lib/automation.ts` — `parseAdReferralConfig` devuelve `{ sourceId?, adsetId?, campaignId? }`; `matchesAdTrigger`; `adReferralDedupeKey(scope)`.
- `src/lib/automation-schemas.ts` — Zod de `ad_referral`: una de las tres claves (opcionales, excluyentes), `strict`.
- `src/lib/automation-dto.ts` — `describeTrigger` con nombres resueltos (`triggerLabel`).
- `src/lib/ad-picker.ts` (nuevo) — árbol, aplanado, búsqueda, resumen de valor, selección y estado perezoso, puros.

**Servidor**
- `src/server/automation/ad-referral.ts` — `matches` usa `matchesAdTrigger` con la jerarquía de `meta_ad`; si falta y hay flujos con alcance, deja la re-emisión para el gancho; **nunca lanza**.
- `src/server/automation/ad-referral-deferred.ts` (nuevo) — `emitDeferredAdReferrals(org, adId)` (ventana 48 h, solo flujos de conjunto/campaña, idempotente).
- `src/server/attribution/meta-ads/sync.ts` — llama al gancho al marcar un anuncio `synced` por primera vez (o cambia de conjunto/campaña).
- `src/server/automation/events.ts` — `dedupeKeyFor(flow)` opcional.
- `src/server/automation/flows.ts` — validar al guardar que un `adsetId`/`campaignId` exista en el catálogo de **esa organización** (422 `unknown_ad_scope`); el `sourceId` sigue permisivo como hoy. Enriquecer los flujos `ad_referral` con `triggerLabel`.
- `src/server/automation/ad-options.ts` (nuevo) — consultas perezosas, búsqueda y resolución (todas `scoped`).
- `src/app/api/automations/ad-options/route.ts` (nuevo) — el endpoint de D3.

**UI**
- `src/components/automatizaciones/ad-trigger-picker.tsx` (nuevo) + uso en `flow-dialog.tsx` y `canvas/inspector/trigger-inspector.tsx`; `automations-client.tsx` y `flow-detail-client.tsx` muestran `triggerLabel`.

**Docs:** `CLAUDE.md` (fila del mapa de Automatizaciones/anuncios), `CHANGELOG.md`, `AGENTS.md` si aplica; `docs/atribucion-capi.md` (qué se ve sin la Marketing API).

## Plan de pruebas

**Unitarias**
- `matchesAdTrigger` con tabla: vacío, `sourceId`, `adsetId`, `campaignId`; anuncio sin jerarquía conocida; configs viejas.
- Zod: una sola clave a la vez, combinaciones rechazadas, **configs de hoy siguen válidas** (retrocompatibilidad), IDs vacíos/largos.
- `ad-picker.ts`: aplanar, buscar (sin acentos ni mayúsculas, por nombre y por ID), resumen del valor, valor huérfano, expandir/plegar, selección por nivel.
- Lista blanca del DTO de `ad-options`: sin URLs de Meta, sin tokens; la miniatura es siempre una ruta local.
- Vigilancia: la ruta usa `withAuth` y 404 sin `ATRIBUCION`; nada recibe `organizationId` del cliente.

**Contra Postgres real** (`ad-trigger-live.test.ts`)
1. Árbol por niveles con conteos y orden (activos primero); paginación por cursor sin saltar ni repetir.
2. **Renombrar** campaña, conjunto y anuncio en `meta_ad` y comprobar que `ad-options` y la lista de flujos muestran el nombre nuevo **sin tocar el flujo**, y que el flujo **sigue disparando**.
3. Disparo por anuncio, por conjunto y por campaña (y que un anuncio de otra campaña **no** dispara).
4. **Anuncio aún no sincronizado:** el flujo de campaña no dispara al llegar el mensaje; sí dispara al sincronizarse (gancho), **una sola vez**, aunque el gancho se repita.
5. Dos anuncios de la misma campaña para el mismo contacto: el flujo de campaña corre **una vez**.
6. Flujo viejo `{ sourceId }` sin cambios; flujo vacío = cualquier anuncio.
7. Aislamiento entre organizaciones (ni el árbol ni la resolución ni el guardado cruzan tenant); `adsetId` ajeno → 422.
8. Sin catálogo: `connector:false`, selector degradado, solo «Un anuncio».
9. La migración 0082 (índice).

**E2E con navegador** (`scripts/e2e-automations-anuncios.mjs`): abrir el disparador, desplegar Campaña › Conjunto, ver miniaturas, elegir una campaña y guardar; renombrar en el mock de la Marketing API, sincronizar y ver el nombre nuevo; el mensaje de un anuncio de esa campaña dispara el flujo; teclado y móvil. **Diferido hasta que lo pidas** (regla actual: no correr ni editar E2E sin que lo pidas); el mock de la Marketing API (`act_*`) de 038 ya sirve.

## Fuera de alcance (a propósito)

- Editar campañas, conjuntos o anuncios en Meta desde aquí.
- Disparadores por **plataforma, objetivo o presupuesto**, por audiencia o por palabra clave del titular.
- Webhooks de Meta para renombres en tiempo real (no los ofrece esta integración).
- Mostrar el **video** del creativo (solo su imagen/miniatura).
- Migrar flujos existentes a campaña/conjunto automáticamente.
- Multi-cuenta publicitaria por organización (hoy hay una).

## Preguntas de decisión (con mi recomendación)

1. **Alcance exacto del selector.** ¿Los tres niveles (campaña, conjunto, anuncio) con el árbol perezoso y búsqueda en el servidor? *Recomiendo sí: una cuenta real tiene cientos de anuncios y un árbol completo en el cliente se arrastra.*
2. **Retraso del primer cliente de un anuncio nuevo.** Para los flujos de **campaña/conjunto**, ¿aceptas ~1–2 min de retraso cuando el anuncio nunca se había visto (el worker resuelve su jerarquía), en lugar de esperar a Meta dentro del webhook? Los flujos **por anuncio** siguen instantáneos. *Recomiendo sí; esperar a Meta en el webhook rompería la regla de que la ingesta nunca espera a un tercero.*
3. **Sin la Marketing API conectada.** ¿Solo se permite «Un anuncio» (como hoy) y se explica que campaña/conjunto necesitan conectar la cuenta publicitaria? *Recomiendo sí.*
4. **Frescura de los nombres.** ¿Se queda en «lo último sincronizado» (cada 12 h) más un botón **«Actualizar desde Meta»**, o quieres sincronizar el catálogo más seguido? *Recomiendo dejar las 12 h + botón: sincronizar más seguido gasta cuota de la API de Meta sin que el nombre cambie casi nunca.*
5. **Validación al guardar.** ¿Un `campaignId`/`adsetId` debe existir en el catálogo de la organización (422 si no), mientras el `sourceId` sigue permisivo como hoy? *Recomiendo sí: evita guardar un flujo de campaña que nunca disparará por un ID mal pegado, sin romper los flujos que ya existen.*
6. **Idempotencia por alcance.** ¿Un contacto arranca el flujo de campaña **una sola vez** aunque su atribución cambie a otro anuncio de la misma campaña? *Recomiendo sí.*
7. **Miniaturas.** ¿La copia local del creativo (la que ya guardamos) es suficiente, sin pedirle a Meta un `thumbnail_url` nuevo en cada apertura del selector? *Recomiendo sí: la URL de Meta caduca y consultarla de más gasta cuota.*
8. **Quién lo ve.** ¿El selector exige rol dueño/administrador (como `/api/settings/ad-flows`) o cualquier miembro que pueda editar automatizaciones? *Recomiendo el mismo permiso que editar automatizaciones.*
9. **E2E.** ¿Lo dejo diferido hasta que lo pidas? *Recomiendo sí, como acordamos.*
