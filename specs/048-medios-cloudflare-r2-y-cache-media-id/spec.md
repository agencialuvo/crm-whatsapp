# 048 — Medios en Cloudflare R2 (subida directa) y caché del `media_id` de WhatsApp

**Feature Branch**: `feat/048-medios-cloudflare-r2-y-cache-media-id`

**Created**: 2026-11-18

**Status**: **Implementada** (2026-11-18), con las trece preguntas aprobadas tal como se recomendaron (R2 como conector opcional con enmienda 1.6.0, PDF incluido, AVIF subible pero «no se envía por WhatsApp», adjuntos entrantes/logo/creativos en el disco hasta una 049, 16 MB para todo video de la biblioteca, E2E diferido). Pendiente de commit. Verificada con unitarias, vigilancia y pruebas contra **Postgres real con un almacén en memoria**; **no se probó contra Cloudflare R2 ni contra Meta reales** (el dueño no tiene sandbox a mano) y **el E2E con navegador NO se corrió**.

Ajustes que salieron al implementar (respecto del texto de abajo):
- **`callGraphSend` perdía el código de Meta** (lo convertía en un `SendError` solo con texto), así que el reintento por media vencido no habría disparado nunca. `SendError` gana `metaError { code, details }` y la detección (`isStaleMediaError`) lee de ahí. Códigos: 131052/131053/131047, subcódigos 1357004/2018047 y un 100 que mencione el media; **la lista se confirma contra un número real** (constante en `src/lib/media-cache.ts`).
- **La firma del `PUT` necesitó `signableHeaders`**: sin él el SDK dejaba `content-type` fuera de lo firmado y R2 aceptaría otro tipo; una prueba lo comprueba (`content-type` y `content-length` firmados).
- **`crearMedioDesdeFlujo` se simplificó**: con todo ≤16 MB ya no hay camino de «video a disco en flujo»; se arma en memoria cortando al pasar el límite del formato.
- **El motor ya no recibe bytes**: `MediaFile` es solo metadatos y `sendMedia` recibe el `mediaId`; el envío (`sendLibraryMedia`) resuelve el `media_id`. En disco el archivo se comprueba con un `stat`; en R2 no se hace `HEAD` por envío (casi siempre hay caché) y si falta falla al subirlo.
- **`media_asset.library_item_id`** apunta al medio (sin FK, como `creative_asset_id`): borrar un medio de la biblioteca deja sin vista previa los envíos viejos que lo usaron (se avisa en la guía).
- **Mantenimiento horario propio** (`src/server/medios/mantenimiento.ts`): subidas sin confirmar (>1 h) y poda de la caché vencida.
- **`pnpm doctor`** gana la sección «Medios en Cloudflare R2».

**Input**: Migrar el Módulo de Medios y el envío multimedia de Automatizaciones a Cloudflare R2 (subida directa con URL firmada, bucket privado) y cachear el `media_id` de WhatsApp por medio y por `phone_number_id` (vigencia 25 días), para dejar de consumir disco, RAM y ancho de banda en Render.

**Carril**: ciclo completo (Principio VI). **Dos migraciones** (0083: columnas en `media_library_item`; tabla `whatsapp_media_cache`), **dos endpoints nuevos** (firmar y confirmar la subida), **un puerto de almacenamiento** (`src/server/storage/`) y **una enmienda de la constitución** (1.6.0, ver «Constitución»).

---

## Lo que encontré (leído del código)

Dos hallazgos corrigen el planteamiento original y cambian el diseño.

**1. Hoy ya se envía por `id`, no por URL.** `uploadGraphMedia` (`src/server/whatsapp/media.ts`) sube el archivo a `POST /{phone_number_id}/media` y el mensaje lleva `{ id }`. Meta **no** descarga nada de nuestro servidor. El desperdicio real es otro, y es triple, **en cada envío**:

| Dónde | Qué pasa hoy en cada paso `send_media` | Costo en Render |
|---|---|---|
| `automation/media.ts` → `loadMediaFile` | `readFile` del archivo ENTERO a un `Buffer` (hasta 16 MB) | RAM |
| `inbox/send.ts` → `sendMediaMessage` | `saveMediaFile` guarda **otra copia** en `MEDIA_DIR` y crea una fila `media_asset` **por mensaje** | **Disco crece con cada envío** |
| `uploadGraphMedia` | sube de nuevo los mismos bytes a Meta | Ancho de banda de salida |

Es decir, mandar la misma imagen a 1 000 contactos guarda 1 000 copias en disco y sube 1 000 veces los mismos bytes. La caché del `media_id` ataca la subida y la RAM; mover el binario a R2 y **dejar de copiarlo por mensaje** ataca el disco. Las tres piezas son necesarias.

**2. La constitución prohíbe S3/R2 en el núcleo** (Principio II, endurecido en 1.4.0): «PROHIBIDO como dependencia del núcleo: almacenamiento de objetos externo (S3/R2)». R2 solo puede entrar como **conector opcional** con las cinco condiciones (bandera apagada por defecto, adaptador con contrato, camino sin dependencia externa, credenciales cifradas/del negocio, CI encendido y apagado). Es el mismo trato que Mercado Pago (046). Por tanto: **el disco local sigue siendo el camino por defecto**; R2 se enciende con una bandera.

Otros hechos relevantes:

- **Biblioteca** (`media_library_item`): solo `image | video`. Límites actuales: JPG/PNG 3 MB, WEBP/AVIF 1,5 MB, **MP4 hasta 5 GB** (`src/lib/medios.ts`). La subida va por cuerpo directo en flujo a disco (`crearMedioDesdeFlujo`), con el formato decidido **por los bytes** (`sniff.ts`). El binario vive en `MEDIA_DIR/<org>/medios/<id>`.
- **Lectura pública** `GET /api/medios/<id>/archivo` (con `Range`, `cache-control: immutable 1 año`): es la URL de «Copiar URL» y la usan Fidelidad (iconos), el catálogo de Servicios/Equipo (imagen), y el selector de medios. No lleva sesión; la protege el id de 20 caracteres.
- **Tope de WhatsApp ya aplicado al enviar**: `MEDIA_LIMITS` (imagen 5 MB, video 16 MB, documento 100 MB). Un video de la biblioteca mayor de 16 MB hoy se sube a la biblioteca sin problema y **falla recién al enviarlo** (`media_too_large`). Validar 16 MB al subir adelanta ese aviso.
- **PDF no existe en la biblioteca** (solo imagen y video). WhatsApp lo manda como `document`. Añadirlo es un cambio de alcance (Q3).
- Los **adjuntos entrantes** (`media_asset`, que Meta expira a los 30 días), el logo y las **miniaturas de creativos de anuncios** (`creative_asset_id`) también viven en `MEDIA_DIR` y **no** se tocan aquí (Q9). El disco de Render no desaparece del todo con esta spec.
- `@aws-sdk/*` **no está** en `package.json`; hay que agregarlo.
- El cliente de Graph traduce errores a `MetaApiError` (`code`, `status`); el envío ya distingue 401/190 (reconectar) del resto.

---

## Diseño

### A. Puerto de almacenamiento (el conector)

`src/server/storage/` — **único** lugar que importa `@aws-sdk/*` y lee `R2_*` (prueba de vigilancia, como el token de Mercado Pago):

```ts
interface ObjectStore {
  driver: "local" | "r2";
  signUpload(key, { contentType, contentLength }): Promise<{ url; headers; expiresAt }>; // solo r2
  signRead(key, { fileName?, download? }): Promise<string>;                               // solo r2
  head(key): Promise<{ size; contentType } | null>;
  readRange(key, from, to): Promise<Buffer>;     // para reconocer el formato sin bajar todo
  readAll(key, maxBytes): Promise<Buffer>;        // ≤ 16 MB, para subir a Meta
  delete(key): Promise<void>;
}
```

- `r2.ts` (`S3Client` con `region: "auto"`, `endpoint: R2_ENDPOINT`, `forcePathStyle`), `local.ts` (el comportamiento actual sobre `MEDIA_DIR`, sin cambios de formato).
- **Bandera `R2_STORAGE`** (apagada por defecto) + las 4 variables `R2_*`. Encendida y con una variable que falta → el arranque avisa y **degrada a local** (nunca bloquea la operación). `pnpm doctor` hace un `HeadBucket` de comprobación.
- Cada fila de la biblioteca sabe **dónde vive su binario** (`storage`), así conviven archivos viejos (local) y nuevos (R2) sin migración obligatoria (retrocompatibilidad).

### B. Subida directa (los bytes no pasan por Render)

Flujo en tres pasos, cada uno validado **en el servidor** (la validación del navegador es comodidad, no seguridad):

1. **Firmar** — `POST /api/medios/subida` `{ nombre, mime, bytes, tipo? }` (con sesión):
   - valida formato y peso con la **misma** `validarMedio` (compartida cliente/servidor, ver límites en C);
   - crea la fila `media_library_item` con `status = 'pending'` y `storage_key = <org>/medios/<id>`;
   - devuelve una URL `PUT` firmada (**vence en 15 min**) con `Content-Type` y **`Content-Length` firmados**: R2 rechaza un cuerpo de otro tamaño o tipo.
2. **Subir** — el navegador hace `PUT` directo a R2 (con progreso, `XMLHttpRequest`).
3. **Confirmar** — `POST /api/medios/subida/<id>/confirmar`:
   - `head` (el tamaño real debe coincidir con el declarado y con el tope del formato);
   - `readRange` de los primeros bytes → `sniff.ts` decide el formato **por los bytes** (un `.mp4` que es otra cosa se rechaza y el objeto se borra);
   - videos: escaneo de los átomos `moov` para avisar si el códec **no es H.264/AAC** (ver Q6);
   - pasa a `status = 'ready'`. Es **idempotente** (confirmar dos veces no duplica).

Un `PUT` que nunca se confirma deja una fila `pending` + un objeto huérfano: el **barredor** (el temporizador horario ya existente en `instrumentation-node.ts`) borra los `pending` de más de 1 h y su objeto. Complemento recomendado: regla de ciclo de vida del bucket (borrar objetos sin confirmar bajo `pending/`… ver Q5 sobre la clave).

**CORS del bucket** (acción manual en Cloudflare, se documenta en `docs/almacenamiento-r2.md`): `AllowedOrigins = APP_BASE_URL`, `AllowedMethods = GET, PUT, HEAD`, `AllowedHeaders = content-type, content-length`, `ExposeHeaders = etag`.

**Importar desde un enlace** (`source = 'url'`) sigue pasando por el servidor (hay que descargarlo de un tercero): se hace en flujo hacia `PutObject`, con el mismo tope, sin llenar la memoria. Es la única subida que aún cruza Render.

### C. Validaciones y límites

Se actualiza `FORMATOS_MEDIO` (única fuente, la usa también el servidor):

| Formato | Hoy | Propuesto |
|---|---|---|
| MP4 | 5 GB | **16 MB** (tope estricto de WhatsApp; con R2 activo y local) |
| JPG / PNG | 3 MB | 3 MB (sin cambio) |
| WEBP | 1,5 MB | 1,5 MB (sin cambio) |
| AVIF | 1,5 MB | sin cambio; **aviso** «WhatsApp no lo admite» (hoy se acepta y falla al enviar) — ver Q4 |
| PDF | no existe | **nuevo** (Q3), `document`, 16 MB |

El mensaje del límite se enseña **antes de pedir la firma** (`validarMedio` en el navegador) y se vuelve a hacer en el servidor al firmar y al confirmar. Los videos viejos de más de 16 MB **siguen listados y legibles**, marcados «no se puede enviar por WhatsApp».

### D. Visualización (bucket privado)

- **Galería / miniaturas**: `GET /api/medios` devuelve por cada medio una `url` **firmada de lectura**, calculada en el proceso (es solo criptografía, **sin ir a R2**). Truco para la caché del navegador: se firma con la fecha **redondeada a la hora** y vencimiento de 2 h, así la URL es **idéntica durante esa hora** y el navegador reutiliza la imagen en vez de bajarla otra vez.
- **Ruta pública `/api/medios/<id>/archivo`** (la que se copia y pega y la usan Fidelidad/Catálogo): para archivos en R2 responde **`302` a una URL firmada de 10 min**, sin sesión (el id sigue siendo la protección, igual que hoy) y con `cache-control: private, max-age=300` en la redirección. Los bytes salen **de R2 directo al visitante**: 0 en Render. Para archivos locales no cambia nada (incluido `Range`).
  - Consecuencia: la URL pegada en otro sitio sigue funcionando y no caduca (la caduca la firma interna, no el enlace que se comparte).
  - **Alternativa descartada por ahora**: dominio personalizado/Worker delante del bucket. Daría caché de borde y cero firmas, pero exige un dominio y un Worker que mantener; se puede añadir después sin cambiar el modelo (Q2).
- Servicio de **descarga** (`?descargar`) firma con `response-content-disposition`.

### E. Caché del `media_id` de WhatsApp

**Tabla `whatsapp_media_cache`** (nueva, una fila por medio × número):

| Columna | Detalle |
|---|---|
| `id` | `wmc_…` |
| `organization_id` | NOT NULL, FK a `organization` (cascade) — toda consulta pasa por `scoped()` |
| `media_item_id` | FK a `media_library_item` (**cascade**: borrar el medio borra su caché) |
| `phone_number_id` | el número que subió; un `media_id` **solo vale para ese número** |
| `wa_media_id` | el id de Meta |
| `mime_type`, `size_bytes` | de lo que se subió (para detectar que el medio cambió) |
| `uploaded_at`, `expires_at` | `expires_at = uploaded_at + 25 días` (Meta lo borra a los 30) |
| **Único** `(media_item_id, phone_number_id)` | una vigente por par; se reemplaza con upsert |

Índices: el único anterior y `(organization_id, expires_at)` para la poda.

Clave por `phone_number_id` (no por organización): si el negocio reconecta **otro número**, la caché vieja deja de coincidir sola, sin invalidar nada a mano.

**Decisión pura** (`src/lib/media-cache.ts`, testeable sin red): `decideMediaSource(cache, item, phoneNumberId, now)` → `reuse | upload`. Reutiliza solo si `expires_at > now`, el número coincide y `mime/size` no cambiaron.

**Flujo en el motor** (`engine.ts` → `loadMedia`/envío), reemplaza la lectura del archivo entero:

1. `loadMediaFile` deja de leer bytes: devuelve **solo metadatos** (`kind`, `mime`, `bytes`, `fileName`, `storage`, `key`) y aplica los topes (no existe / muy grande / archivo faltante — con `head` en R2).
2. `resolveWaMediaId(org, item, credentials)`:
   - **vigente** → devuelve el `wa_media_id` (**0 bytes**);
   - **no existe o venció** → *single-flight* por `(item, phone)` (candado de asesoramiento de Postgres, para que 50 automatizaciones simultáneas suban **una** vez y las demás esperen y reutilicen), `readAll` desde R2 (o disco), `uploadGraphMedia`, upsert con `expires_at = now + 25 d`.
3. Se envía el mensaje con `{ id }`.
4. **Reintento en runtime**: si Meta rechaza el envío por un id inválido/vencido (códigos a confirmar en el sandbox, ver Q7), se **invalida la fila, se sube de nuevo y se reintenta UNA sola vez**. Un segundo fallo es un error normal (sin bucle).

**Sin copia por mensaje**: `sendMediaMessage` gana una variante `{ libraryItem }` que **no** llama a `saveMediaFile` ni crea una copia: `media_asset` pasa a **referenciar** el medio de la biblioteca (`library_item_id` nullable; `storage_path` nulo). La vista previa del hilo se sirve del medio. Es lo que de verdad frena el crecimiento del disco.

La poda de filas vencidas (`expires_at < now`) corre en el mismo barredor horario.

### F. Retrocompatibilidad

- Filas existentes: `storage = 'local'`, `status = 'ready'` por defecto (el `DEFAULT` hace innecesario reescribir datos). Todo lo que se lee hoy se sigue leyendo igual.
- **La caché del `media_id` funciona también para archivos locales**: aun sin R2, ya se evita subir 1 000 veces los mismos bytes. Es independiente de la bandera.
- Migración opcional de lo viejo: `pnpm medios:migrar-r2` (idempotente, copia local → R2, cambia `storage` solo tras `head` correcto, **no borra el local** hasta pasar `--limpiar`). No es obligatoria (Q8).
- Apagar la bandera: los archivos ya en R2 **dejan de ser legibles** desde el CRM (no hay copia local). Se documenta y el arranque lo avisa; por eso el comando de migración también soporta el sentido contrario (R2 → local).

---

## Constitución (enmienda 1.6.0)

- El almacenamiento de objetos pasa de «prohibido» a **conector opcional permitido** bajo las cinco condiciones: (1) `R2_STORAGE` apagado por defecto, con la subida firmada y su confirmación en 404 apagado; (2) adaptador `ObjectStore` con contrato; (3) camino sin dependencia = disco local; (4) credenciales en variables de entorno de la instancia, nunca al cliente ni a logs (las URLs firmadas **sí** llegan al cliente, vencen y no contienen el secreto); (5) CI en ambos modos con un mock de S3 (camino infeliz incluido).
- Se actualiza la tabla de «prohibido» y la fila de CLAUDE.md/AGENTS.md.

---

## Datos

**Migración 0083** (aditiva, re-ejecutable):

```sql
ALTER TABLE media_library_item
  ADD COLUMN storage text NOT NULL DEFAULT 'local',      -- 'local' | 'r2'
  ADD COLUMN storage_key text,                           -- NULL = ruta derivada local de siempre
  ADD COLUMN status text NOT NULL DEFAULT 'ready';       -- 'pending' | 'ready'
ALTER TABLE media_asset ADD COLUMN library_item_id text; -- sin copia por mensaje
CREATE TABLE whatsapp_media_cache (…);                   -- ver E
```

El kind de `media_library_item` es `text` con enum de TypeScript (sin CHECK en la base): sumar `document` (Q3) no exige migrar datos.

---

## Cambios de código por archivo (plan)

**Nuevos**
- `src/server/storage/{index,types,r2,local,config}.ts` — puerto, drivers y bandera/credenciales (único lector de `R2_*`).
- `src/lib/media-cache.ts` — `decideMediaSource`, `CACHE_TTL_DAYS = 25` (puro).
- `src/server/whatsapp/media-cache.ts` — `resolveWaMediaId` (single-flight, upsert, invalidación), poda.
- `src/app/api/medios/subida/route.ts` y `…/[id]/confirmar/route.ts`.
- `src/components/medios/direct-upload.ts` — reemplaza el cuerpo directo a Render cuando R2 está activo (`XMLHttpRequest` con progreso; cae al camino actual si el servidor dice `driver: local`).
- `scripts/medios-migrar-r2.ts`, `docs/almacenamiento-r2.md` (CORS, regla de ciclo de vida, costos, rollback).
- Mock de S3 para pruebas (puerto en memoria; **no** una dependencia de red).

**Modificados**
- `src/lib/medios.ts` (límites y PDF), `src/server/medios/store.ts` (crear/borrar/listar por driver; borrar = fila **y** objeto **y** caché, en la misma operación — regla de «borrados en cascada»).
- `src/app/api/medios/route.ts` (URLs firmadas en el listado), `…/[id]/archivo/route.ts` (302 para R2).
- `src/server/automation/media.ts` (solo metadatos), `engine.ts` (`MediaFile` → metadatos + `resolveWaMediaId`), `worker.ts` (dependencias).
- `src/server/inbox/send.ts` (variante `{ libraryItem }` sin copia), `src/server/whatsapp/media.ts` (`uploadGraphMedia` acepta el buffer ya leído; sin cambios de contrato).
- `src/lib/env.ts` + `.env.example` (placeholders `REEMPLAZA_…` con guía), `render.build.yaml` (variables con `sync: false`), `src/server/doctor/checks.ts`, `instrumentation-node.ts` (poda y barredor de `pending`).
- `src/components/medios/*` (aviso de límites, progreso, estado «no se puede enviar por WhatsApp»).
- `CLAUDE.md`, `AGENTS.md`, `CHANGELOG.md`, constitución 1.6.0.

---

## Plan de pruebas

- **Unitarias (puras)**: `decideMediaSource` (vigente, vencida por 1 ms, otro número, mime/tamaño distinto, sin fila), límites por formato, construcción de claves por organización, firma redondeada a la hora (URL estable), reglas de PDF/AVIF.
- **Con el mock de S3**: firmar → subir → confirmar (feliz); tamaño distinto al declarado → rechazo y objeto borrado; formato falso → rechazo; confirmar dos veces (idempotente); `pending` huérfano barrido; borrar un medio borra objeto + caché; R2 caído al confirmar → error claro, fila `pending`, sin colgar.
- **Postgres real** (`medios-cache-live`): `unique(media_item_id, phone_number_id)`; **50 envíos concurrentes → 1 sola subida a Meta**; vencida → re-subida; invalidar + reintento **una** vez; cambio de número → no reutiliza; cascada al borrar el medio; aislamiento entre organizaciones.
- **Mock de Graph** (`wa-mock`): contador de subidas y simulación de «media id vencido» para el camino infeliz.
- **Vigilancia**: `@aws-sdk/*` y `R2_*` solo en `src/server/storage/`; ningún `readFile` de medios en `automation/`; `sendMediaMessage` con `libraryItem` no llama a `saveMediaFile`; el listado nunca devuelve una clave de R2 ni credenciales.
- **Encendido y apagado**: la suite corre con `R2_STORAGE` apagado (camino local intacto) y encendido (mock).
- **E2E con navegador**: diferido (indicación vigente); se deja el guion en `tests/e2e/`.

---

## Fuera de alcance (a propósito)

- Mover los **adjuntos entrantes**, el logo y las **miniaturas de creativos de anuncios** a R2 (Q9).
- Dominio personalizado / Worker de Cloudflare delante del bucket.
- Transcodificar o comprimir videos (se valida y se avisa; no se convierte).
- Enviar medios de la biblioteca desde la Bandeja a mano (hoy el operador sube un archivo en el momento; esa ruta sigue igual, solo se beneficia de la caché si se añade el selector).
- Otros canales (Instagram/Messenger no usan `media_id` de WhatsApp).

---

## Preguntas de decisión (con mi recomendación)

**Q1 — Enmienda constitucional.** R2 solo entra como conector opcional (Principio II). **Recomiendo:** enmienda 1.6.0 con bandera `R2_STORAGE` apagada por defecto y disco local como camino sin dependencia (como Mercado Pago). Alternativa: declarar R2 parte del núcleo — contradice el principio de soberanía y rompe a quien se autohospede. **¿Apruebas?**

**Q2 — Cómo se ve lo privado.** **Recomiendo** URLs firmadas calculadas localmente (galería, redondeadas a la hora para que el navegador las cachee) + `302` firmado de 10 min en la ruta pública. Alternativa: dominio propio + Worker (mejor caché, más mantenimiento). Empezamos sin dominio y se añade después si el tráfico lo pide. **¿De acuerdo?**

**Q3 — PDF.** Hoy la biblioteca solo admite imagen y video; un PDF es un `document` de WhatsApp y requiere el tipo nuevo, `filename` en el envío y que los selectores de imagen lo ignoren. **Recomiendo incluirlo ahora** (límite 16 MB propio; WhatsApp admite 100 MB, pero un PDF de plantilla rara vez pasa de pocos MB). Alternativa: dejarlo para otra spec. **¿Lo incluimos?**

**Q4 — AVIF.** Se acepta hoy pero WhatsApp no lo admite (falla al enviar). **Recomiendo** mantenerlo subible (sirve para otros usos, como Catálogo) con la etiqueta «no se envía por WhatsApp», en vez de prohibirlo y romper lo existente.

**Q5 — Estructura de la clave y limpieza.** **Recomiendo** `org/<orgId>/medios/<id>` para lo confirmado y `pending/<orgId>/<id>` para lo recién firmado, **moviendo** (copiar + borrar) al confirmar, y una regla de ciclo de vida del bucket que borre `pending/` tras 1 día como red de seguridad. Costo: una copia dentro de R2 por archivo (sin tráfico externo, centavos). Alternativa: misma clave siempre y solo el barredor. **¿Cuál prefieres?**

**Q6 — H.264/AAC.** No hay `ffprobe` en la imagen. **Recomiendo** un escaneo de los átomos `avc1`/`mp4a` del propio MP4 (≤16 MB, en el servidor al confirmar) como **aviso**, no bloqueo: Meta es quien decide el rechazo final. Si prefieres bloqueo duro, hay falsos positivos con contenedores raros.

**Q7 — Error de media vencido.** No tengo certeza de qué código devuelve Meta con un `id` expirado o ajeno (en mi memoria: 131052/131053/100 con texto de parámetro). **Recomiendo** probarlo contra tu número real/sandbox en la implementación y dejar la lista de códigos en una constante; mientras tanto el reintento único se dispara solo con esos códigos. ¿Tienes un número de pruebas con el que pueda lanzar un envío real?

**Q8 — Migración de lo existente.** **Recomiendo** no obligarla: lo viejo se sigue sirviendo del disco; el comando `medios:migrar-r2` queda disponible. Pero ojo: **el disco de Render no se podrá quitar** hasta migrar y mover también lo de Q9.

**Q9 — Adjuntos entrantes, logo y creativos.** Siguen en `MEDIA_DIR`. **Recomiendo** dejarlos para una 049 y avisar claro que el «costo cercano a cero» del disco llega cuando esa parte también se mueva; esta spec elimina el crecimiento **por envío**, que es el grande. **¿Aceptas ese corte?**

**Q10 — Límite de 16 MB para videos en TODA la biblioteca** (no solo en los que se envían por WhatsApp). **Recomiendo sí**: un solo límite simple y coherente con el envío. Los videos antiguos más pesados se conservan, marcados como no enviables.

**Q11 — Seguridad de la ruta pública.** Sigue protegida solo por el id aleatorio (como hoy). **Recomiendo** mantenerlo para no romper las URLs ya pegadas en otros sitios. ¿Alguna de tus URLs requiere que sea privada de verdad?

**Q12 — Dependencias nuevas** (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`): suman al `node_modules` y a la imagen. **Recomiendo** aceptarlas tal como las pediste (son las que R2 documenta).

**Q13 — E2E.** Siguiendo tu indicación, queda diferido; entrego unitarias, mock de S3, Postgres real y vigilancia.
