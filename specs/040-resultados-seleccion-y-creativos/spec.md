# Feature Specification: Resultados — selección múltiple con checkboxes y vista previa de los creativos

**Created**: 2026-11-15

**Status**: **Implementada** (2026-11-15). Pendiente de revisión del diseño y de commit. Verificada contra el mock de la
Graph API (`pnpm test:e2e:meta-ads`, 133 comprobaciones) y Postgres real; **no contra la Marketing API real**.

Ajustes que salieron al implementar (respecto del texto de abajo):
- `selectedCount` cuenta las **filas de la pestaña** marcadas (campañas, conjuntos o anuncios), no los anuncios que las
  componen; el rótulo del Total («Total · 2 seleccionadas») lo usa tal cual.
- `AdsQuery` conserva `campaignId`/`adsetId` (039) y suma `campaignIds`/`adsetIds`/`selected`; las listas mandan sobre el
  valor único.
- La migración es la `0075`.

**Input**: pedido del dueño el 2026-11-15 sobre **Resultados → Origen y anuncios**
([019](../019-resultados/spec.md), [038](../038-meta-marketing-api/spec.md),
[039](../039-meta-catalogo-completo-y-drilldown/spec.md)).

**Carril**: completo (Principio VI). Migra (0075: columnas nuevas en `meta_ad`), amplía la
sincronización con la Marketing API y toca la tabla y un modal nuevo. Sigue detrás de
`ATRIBUCION`: sin la bandera, las rutas siguen en 404 y el DTO de Resultados es exactamente el
de 019 (sin llaves nuevas).

## Contexto

Con la 039 la tabla ya baja de campaña a conjunto a anuncio por clic, pero:

1. **Compara de a uno.** Para ver «estas dos campañas juntas» no hay forma: el filtro es de
   un solo valor. El Administrador de Anuncios resuelve esto con casillas: se marcan filas, se
   cambia de pestaña y la tabla queda filtrada por lo marcado.
2. **El anuncio no se ve.** La columna «Anuncio» enseña un megáfono gris. El dueño decide qué
   apagar o escalar mirando el creativo, y hoy tiene que irse a Meta a verlo.

## Decisiones (propuestas; si el dueño no las veta, quedan)

### Selección

- **S1 — Una selección por nivel, que filtra hacia abajo.** Las casillas de **Campaña** filtran
  las pestañas **Conjunto** y **Anuncio**; las de **Conjunto** filtran **Anuncio**; las de
  **Anuncio** solo afectan al Total. Volver a una pestaña de arriba **conserva** sus casillas
  (como Meta); no se borra nada al cambiar de pestaña.
- **S2 — La pestaña actual no se filtra a sí misma.** Marcar campañas en la pestaña Campaña
  no esconde las demás campañas (se marcan para llevarlas a otra pestaña y para el Total).
- **S3 — Marcar de arriba invalida lo de abajo.** Al cambiar las campañas marcadas se vacían las
  casillas de Conjunto y Anuncio (podrían ser de una campaña que ya no está marcada); al cambiar
  los conjuntos, las de Anuncio. Es una regla pura y probada, no un efecto escondido.
- **S4 — El Total sigue a la selección.** Con casillas marcadas **en la pestaña actual**, el
  Total se calcula solo sobre esas filas, con las mismas reglas de costos de 038/039 (el
  denominador cuenta solo filas con gasto conocido; sin gasto o sin resultados, «—»). Sin
  casillas marcadas en esa pestaña, el Total es el de toda la vista. Se calcula en el
  **servidor** (la UI no divide), y por eso viaja `selected` en la consulta.
- **S5 — Una selección que ya no existe no vacía el Total.** Si las llaves marcadas no están en
  las filas devueltas (cambió el rango, el filtro o el catálogo), el servidor calcula el Total
  de toda la vista en vez de dar ceros.
- **S6 — El clic en el nombre sigue bajando de nivel (039).** Es lo mismo que marcar esa fila
  sola y cambiar de pestaña: `drillInto` pone `[esa fila]` y baja. Las migas se derivan de las
  casillas («Todas las campañas › 2 campañas › Conjunto»). Los dos selectores de búsqueda se
  conservan y fijan una selección de una sola fila (o la vacían).
- **S7 — Indicadores claros.** Sobre la tabla, una píldora por cosa que filtra o está marcada:
  «Filtrando: 2 campañas [Quitar]» (viene de la pestaña de arriba) y «3 conjuntos seleccionados
  [Limpiar]» (la de esta pestaña). La casilla maestra de la cabecera marca o desmarca **las
  filas visibles**, con estado indeterminado cuando hay algunas.
- **S8 — Teléfono.** Cada tarjeta lleva su casilla a la izquierda y la selección se maneja desde
  la misma barra de píldoras (la cabecera de tabla no existe ahí): un «Marcar todo» en la barra.

### Creativos

- **C1 — La imagen se copia al volumen local, no se enlaza.** Las URL del CDN de Meta caducan
  y el CSP del CRM (`img-src 'self'`) no admite hosts externos. Se reutiliza la descarga
  acotada de la 018 (`descargarConReintento`: solo hosts de Meta, con tope de tamaño y de
  tiempo, sin SSRF) y se guarda como un `media_asset` más, servido con sesión por
  `/api/media/{id}`. Constitución II: sin S3 ni terceros; es el mismo mecanismo de la 018.
- **C2 — Una imagen por anuncio, la mejor disponible.** Se intenta `image_url` (completa); si
  no hay, o la descarga falla de forma permanente (p. ej. pasa del tope de 300 KB), se
  intenta `thumbnail_url`. La miniatura de la tabla y la imagen grande del modal son la misma
  copia (la miniatura la escala el CSS).
- **C3 — Titular, texto y enlace se guardan como texto.** `title` y `body` del creativo, y
  `preview_shareable_link`. El enlace solo se guarda si es `https` de un host de Meta
  (`facebook.com`, `fb.me`, `fb.com`) y sin usuario ni puerto; si no, se descarta (nunca se
  pinta un `href` que vino de afuera sin validar) y se abre con `rel="noopener noreferrer"`.
- **C4 — La descarga no bloquea nada.** Ocurre en el worker de la 038, después del listado,
  con un tope por pasada (25 anuncios). Un fallo deja la miniatura vacía (el megáfono de
  siempre) y se reintenta en la siguiente pasada; nunca rompe la sincronización ni Resultados.
- **C5 — Se refresca cuando cambia el creativo.** Si el listado trae otra URL de imagen que la
  copiada, se vuelve a descargar y se borra la copia vieja (la fila y el archivo).
- **C6 — Degradación del listado.** Pedir `creative{…}` encarece la consulta; en cuentas grandes
  Meta puede responder «reduce la cantidad de datos» (error 1). Si el listado con creativos falla
  por algo que no sea token, permiso o límite de uso, se **reintenta una vez sin creativos** en la
  misma pasada: el catálogo y el gasto siguen llegando y se avisa en Ajustes. La página baja de
  200 a 100 anuncios.
- **C7 — Vista previa.** Clic en la miniatura o en el icono de ojo de la fila abre un modal con:
  la imagen grande, el **titular**, el **texto principal**, «Campaña › Conjunto», el estado en
  Meta, el id del anuncio y, si hay, el enlace «Abrir vista previa en Meta». Sin imagen ni
  textos (anuncio de una cuenta sin sincronizar, o creativo dinámico sin `title`/`body`) el modal
  lo dice con claridad en lugar de abrir vacío. Se cierra con la X, con Escape y al hacer clic
  fuera (reglas de UI del sistema).
- **C8 — Qué NO se hace:** reproducir video dentro del modal, editar el creativo, ni traer
  métricas del creativo (impresiones, clics). Un anuncio de video muestra su portada
  (`thumbnail_url`).

## Datos — migración 0075 (siempre aplicada, aunque la bandera esté apagada)

`meta_ad` (existente) añade, todas nulables:

| Columna | Qué guarda |
|---|---|
| `creative_id` | id del creativo en Meta |
| `creative_title` | `title` (≤ 300) |
| `creative_body` | `body` (≤ 2000) |
| `creative_thumb_url` | `thumbnail_url` tal como lo dio Meta (caduca; solo sirve para descargar) |
| `creative_image_url` | `image_url` tal como lo dio Meta |
| `creative_source_url` | la URL de la que salió la copia actual (para saber si cambió) |
| `creative_asset_id` | `media_asset.id` de la copia local; sin FK (se limpia a mano, C5) |
| `preview_link` | `preview_shareable_link` ya validado (C3) |

Sin tablas nuevas. Las filas viejas quedan en `NULL` y el siguiente listado las llena.

## Sincronización

`buildAdsListPath(account, after, { creative })` añade al `fields`:
`preview_shareable_link,creative{id,thumbnail_url,image_url,title,body}` y baja `limit` a 100
cuando `creative` es `true`. `parseAdsPage` lee el creativo y valida el enlace; `AdNode` añade
`creative` y `previewLink` opcionales (las consultas sueltas por id y el gasto no los traen).

`upsertAccountAds` los guarda **sin pisar con `null`** lo ya conocido (igual que los nombres).

Nuevo paso de la pasada, **después** del listado y antes del gasto: `syncCreatives`.
1. Elige anuncios `listed_at IS NOT NULL` con `image_url` o `thumb_url` y cuya copia falte o
   cuya URL elegida (`image_url ?? thumb_url`) difiera de `creative_source_url`; máx. 25 por
   pasada, los más recientemente listados primero.
2. Por cada uno: `descargarConReintento(image_url)` y, si falla permanente, la miniatura.
3. Guarda el `media_asset` (`payload.origen = 'catalogo'`), actualiza `creative_asset_id` y
   `creative_source_url`, y borra la copia anterior si la hubo.
4. Una URL que ya no es de Meta o que no baja se deja y se reintenta con el siguiente listado
   (que trae URLs nuevas); no se gasta un intento de cola: no hay cola para esto.

Todo sin red inyectada es probado con un `GraphCall` y un descargador inyectables.

## Resultados — cambios

### API (`GET /api/analytics/ads`)

Nuevos parámetros (todos opcionales, coma-separados, tope de 100 ids de ≤128 caracteres):

- `campaignIds`, `adsetIds` — filtros (varios valores = unión). `campaignId`/`adsetId` de la
  039 se siguen aceptando y equivalen a una lista de uno.
- `selected` — llaves marcadas **en la pestaña actual** (campaña/conjunto/anuncio según `group`),
  solo para el Total (S4/S5).

`sin-identificar` sigue valiendo como valor. Un parámetro inválido → 422 `invalid_query`.

### DTO

- `AdRowDto` añade (solo con la bandera): `creative?: { assetId, title, body, previewLink } | null`.
  El `imageAssetId` de la fila (del referral, 018) sigue; `creative.assetId` es el del catálogo, y la
  miniatura usa el primero que exista. Así un anuncio con gasto y sin conversaciones también tiene
  imagen.
- `AdTotalDto` ya existe; ahora puede ser el de la selección (`ads` = filas contadas).
- `AdsBlockDto` añade `selectedCount?: number` (cuántas de las `selected` encontró el servidor).

### Lógica pura (sin red ni base)

`src/lib/ads-nav.ts` (reescrito sobre arreglos, con las funciones de 039 conservadas en lo posible):

```
type AdsView = { group; campaignIds: string[]; adsetIds: string[]; adIds: string[] }
filtersFor(view)        // { campaignIds, adsetIds, selected } que se mandan a la API según la pestaña
toggle(view, nivel, key) / toggleAll(view, nivel, keys, on) / clearLevel(view, nivel)
                        // aplican S3 (vaciar lo de abajo cuando cambia una selección de arriba)
drillInto(view, fila)   // = selección de una fila + bajar (S6)
goToLevel(view, group)  // cambia de pestaña SIN borrar casillas (S1)
crumbs(view, nombres)   // «Todas las campañas › 2 campañas › Conjunto»
summary(view, group)    // píldoras: { filtro?: {texto, quitar}, seleccion?: {texto, limpiar} }
masterState(selectedKeys, visibleKeys) // 'none' | 'some' | 'all'
```

`src/server/analytics/ads-hierarchy.ts`: `AdsQuery` añade `campaignIds?`, `adsetIds?`, `selected?`;
`armarJerarquia` filtra por unión de ids y calcula el Total sobre la selección (S4/S5).

## UI

- `ads-section.tsx`: columna de casilla a la izquierda (tabla y tarjetas) en las tres pestañas, con
  maestra en la cabecera (`aria-checked="mixed"` cuando hay algunas), barra de píldoras sobre la
  tabla, Total que cambia con la selección y su rótulo («Total · 2 seleccionadas» / «Total»).
- Casillas **accesibles**: `<input type="checkbox">` con `aria-label` por fila («Seleccionar campaña
  X»); clic en la fila **no** marca (el clic en el nombre baja de nivel), solo la casilla.
- Miniatura real con `MiniaturaDeAnuncio` (ya cae al megáfono sin imagen) y botón de ojo;
  `anuncio-preview-dialog.tsx` (nuevo) con el modal (usa `Modal` de `negocio/modal`).

## Constitution Check

- **I Seguridad**: el enlace externo se valida (C3); las URL descargadas pasan por la lista de
  hosts de Meta y el tope de la 018; ningún token viaja al cliente.
- **II Soberanía**: sigue siendo el conector opcional de la 038; la imagen se copia al volumen
  local (sin hotlink a Meta); sin la bandera o sin credenciales nada de esto existe.
- **III Multi-tenancy**: `meta_ad` ya lleva `organization_id`; todo por `scoped()`; el `media_asset`
  creado lleva la organización y `/api/media/{id}` ya exige que sea de la sesión.
- **IV Idempotencia**: el upsert no pisa con `null`; la descarga se repite sin duplicar (se borra la
  copia reemplazada); la migración es re-ejecutable.
- **Sandbox del Laboratorio**: sin cambios (Resultados ya excluye el Lab).

## Riesgos

| Riesgo | Mitigación |
|---|---|
| `creative{…}` hace pesado el listado y Meta responde error 1 («reduce data») | Página de 100 y reintento sin creativos (C6); no se pierde catálogo ni gasto |
| URL del CDN caduca antes de bajar | Se baja en la misma pasada del listado; si falla, el siguiente listado trae URL nueva |
| Imágenes grandes llenan el volumen | Tope de 300 KB de la 018; si `image_url` lo pasa se usa la miniatura |
| Un `preview_shareable_link` malicioso | Solo `https` de hosts de Meta, validado al guardar y otra vez al pintar |
| Selección obsoleta tras cambiar rango/filtro | S3 la vacía hacia abajo; S5 evita Totales en cero; la píldora cuenta solo las filas presentes |
| Más de 50 anuncios en la pestaña Anuncio (la lista se recorta) | Las casillas actúan sobre las filas mostradas; el Total sigue contando todo lo filtrado cuando no hay selección (039) y la nota de recorte ya existe |
| Creativos dinámicos sin `title`/`body`/imagen | El modal lo dice; el botón de Vista previa sigue disponible si hay enlace |
| **Sin verificar contra la Marketing API real** | La forma de `creative{…}` y de `preview_shareable_link` sale de la documentación; el mock reproduce ese contrato, no a Meta |

## Plan de pruebas

**Unitarias puras**: `ads-nav` (toggle, toggleAll, S3 en cada nivel, `filtersFor` por pestaña,
`drillInto` como selección de una fila, `goToLevel` conserva casillas, `crumbs` con 1 y N,
`summary`, `masterState`); parseo del creativo y validación del enlace (`https` de Meta sí;
`http`, hosts ajenos, `javascript:`, usuario/puerto no); `buildAdsListPath` con y sin creativo;
`armarJerarquia` con unión de ids, `selected` (S4) y `selected` obsoleto (S5), costos del Total.

**Postgres real** (`GraphCall` y descargador inyectados): el listado guarda creativo, título, texto
y enlace sin pisar con `null`; se descarga la imagen y se crea el `media_asset` de la organización;
`image_url` que falla permanente cae a la miniatura; cambiar la URL reemplaza y borra la copia
vieja; tope de 25 por pasada; el listado con creativos que falla (error 1) se reintenta sin ellos y
avisa; aislamiento entre organizaciones; sin la bandera no hay llaves nuevas; la API/consulta con
varios ids y `selected` devuelve el Total esperado.

**E2E** (`pnpm test:e2e:meta-ads`, se extiende el mock con `creative`, `preview_shareable_link` y
una imagen servida por el propio mock): marcar dos campañas → pestaña Conjunto muestra solo los de
ellas → marcar un conjunto → Anuncio muestra solo los suyos; píldoras con su texto y «Limpiar»;
la casilla maestra; el Total cambia al marcar y vuelve al desmarcar; volver a Campaña conserva las
casillas; miniatura real en la pestaña Anuncio y modal con imagen, titular, texto, campaña ›
conjunto y enlace; anuncio sin creativo → megáfono y modal explicativo; teléfono sin desborde
(390 px) con casillas; modo claro y oscuro; camino infeliz del listado con creativos caído.

**Gate**: `pnpm typecheck && pnpm lint && pnpm build && pnpm test`, más Postgres y el E2E, con
capturas revisadas.

## Plan por archivo

| Archivo | Cambio |
|---|---|
| `src/lib/db/schema.ts`, `drizzle/0075_*` | 8 columnas nulables en `meta_ad` |
| `src/lib/meta/ads.ts` | `buildAdsListPath` con creativo, `parseAdsPage` con creativo y `safePreviewLink`, tipo `AdNode.creative/previewLink` |
| `src/server/attribution/meta-ads/catalog.ts` | `upsertAccountAds` guarda creativo sin pisar con null; `adsNeedingCreative`, `setCreativeAsset` |
| `src/server/attribution/meta-ads/creatives.ts` (nuevo) | `syncCreatives` con descargador inyectable, borrado de la copia vieja |
| `src/server/attribution/meta-ads/sync.ts` | listado con creativo + reintento sin él (C6); llama a `syncCreatives` |
| `src/lib/analytics.ts`, `src/server/analytics/ads-hierarchy.ts`, `ads.ts` | `creative` en la fila; `AdsQuery` con arreglos y `selected`; Total de la selección |
| `src/app/api/analytics/ads/route.ts` | parsear `campaignIds`, `adsetIds`, `selected` |
| `src/lib/ads-nav.ts` | reescrito sobre arreglos (ver arriba) |
| `src/components/results/ads-section.tsx`, `results-client.tsx` | casillas, píldoras, Total de la selección, miniatura y ojo |
| `src/components/results/anuncio-preview-dialog.tsx` (nuevo) | el modal de vista previa |
| `src/app/api/dev/wa-mock/graph/[...path]/route.ts` | `creative`, `preview_shareable_link` y una imagen de prueba |
| `scripts/e2e-meta-ads.mjs`, `tests/unit/*` | lo de arriba |
| `docs/atribucion-capi.md`, `CLAUDE.md`, `CHANGELOG.md` | documentar |

## Qué se decidió NO hacer

- **Selección que persiste entre visitas**: vive en el estado de la pantalla (como en Meta); no
  se guarda en el navegador ni en la base.
- **Acciones sobre lo seleccionado** (pausar, editar, duplicar): la credencial es `ads_read`.
- **Casillas en «Por origen»**: esa tabla no tiene niveles que filtrar.
- **Imágenes de varios formatos o carruseles del creativo**: una imagen por anuncio (C2).
- **Reproducir el video**: se muestra su portada (C8).
