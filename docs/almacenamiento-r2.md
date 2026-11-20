# Medios en Cloudflare R2 y caché del `media_id` de WhatsApp (spec 048)

Guía para encender el almacenamiento de Medios en **Cloudflare R2** y entender qué cambia. Es un **conector opcional**:
apagado (lo normal), los archivos viven en el disco de `MEDIA_DIR` y nada de esto se usa. La **caché del `media_id`**, en
cambio, funciona siempre.

## Qué resuelve

| Antes | Ahora |
|---|---|
| El archivo pasaba por el servidor al subirlo y vivía en su disco | Con R2: el navegador sube **directo al bucket**; el servidor solo firma y confirma |
| Cada paso «Enviar archivo» leía el archivo a memoria, lo subía otra vez a Meta y dejaba **otra copia en disco** | Se sube a Meta **una vez por número** y 25 días; los envíos siguientes mandan `{ id }` (0 bytes, 0 RAM, 0 disco) |
| Videos de hasta 5 GB (que fallaban al enviar) | **16 MB**, el tope de WhatsApp, validado al subir |
| Sin PDF | **PDF** hasta 16 MB (se envía como documento) |

## Encenderlo

1. **Cloudflare → R2**: crea el bucket (privado; **no** actives el acceso público) y un token de API con **Object Read & Write**
   sobre ese bucket.
2. **CORS del bucket** (R2 → tu bucket → Settings → CORS policy). Sin esto el navegador no puede subir:

   ```json
   [
     {
       "AllowedOrigins": [
         "https://app.sistemalia.com",
         "http://localhost:3000",
         "http://localhost:3002"
       ],
       "AllowedMethods": ["GET", "PUT", "HEAD"],
       "AllowedHeaders": ["content-type", "content-length"],
       "ExposeHeaders": ["etag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   Cada origen debe coincidir **exactamente** con el `APP_BASE_URL` desde el que se abre la app (con `https://`, sin barra final):
   `https://app.sistemalia.com` en producción. Los dos `localhost` solo sirven para desarrollo; quítalos si no los necesitas.
   Si usas otro dominio, cámbialo aquí.
3. **Regla de ciclo de vida** (R2 → Settings → Object lifecycle rules, recomendado): borrar los objetos con prefijo
   `pending/` a **1 día**. Es la red de seguridad de las subidas que se firmaron y nunca se confirmaron (el CRM ya las
   barre cada hora).
4. **Variables** (en `.env` o, en Render, en Environment del servicio):

   ```bash
   R2_STORAGE=on
   R2_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com   # sin el nombre del bucket
   R2_BUCKET_NAME=sistema-lia-media
   R2_ACCESS_KEY_ID=...
   R2_SECRET_ACCESS_KEY=...
   ```

5. `pnpm doctor` → sección «Medios en Cloudflare R2»: comprueba las cuatro variables y que el bucket responda.
   Si falta alguna (vacía, con el valor de ejemplo `REEMPLAZA_…`, o un `R2_ENDPOINT` que no sea una URL http/https) con
   `R2_STORAGE=on`, el sistema **degrada a disco local** (los archivos nuevos van a `MEDIA_DIR`), pero **no en silencio**:
   el arranque escribe `[boot] AVISO R2: …` en el log con los **nombres** de las variables (nunca sus valores),
   `GET /api/health` responde `r2: { status: "incomplete", missing: [...], warning: "..." }` (con `ok` y el código 200
   intactos, para no reiniciar el contenedor) y el doctor lo marca. `r2.status` vale `off` (sin `R2_STORAGE`), `ok`
   (completo) o `incomplete`. Es solo configuración: `/api/health` no consulta el bucket.

## Cómo funciona

**Subida directa** (3 pasos, todos validados en el servidor):

1. `POST /api/medios/subida` `{ nombre, mime, bytes }` → valida formato y peso con las mismas reglas de siempre, crea la
   fila `pending` y devuelve una URL `PUT` firmada de **15 min** (tipo y tamaño van **firmados**: R2 rechaza otro cuerpo).
2. El navegador hace el `PUT` directo a R2, con barra de avance.
3. `POST /api/medios/subida/<id>/confirmar` → el servidor comprueba el tamaño real y el formato **por los bytes**, mueve el
   objeto a su clave definitiva (`org/<orgId>/medios/<id>`) y lo deja disponible. Si no cuadra, lo borra. Es idempotente.

Con R2 apagado ambos endpoints responden 404 y la pantalla sube por el servidor como antes (lo recuerda).

**Ver lo privado**: la galería recibe una URL firmada de lectura por medio, calculada **en el proceso** (sin ir a R2) y
**estable durante la hora** para que el navegador la cachee. `/api/medios/<id>/archivo` (la URL de «Copiar URL») redirige
(302) a una firma de 10 min: los bytes salen de R2 al visitante sin pasar por el servidor. El enlace público **no caduca**;
solo vence la firma interna.

**Caché del `media_id`** (siempre activa, con o sin R2): tabla `whatsapp_media_cache`, una fila por (medio, `phone_number_id`)
con vencimiento a **25 días** (Meta borra a los 30). Un `media_id` solo vale para el número que lo subió; si se reconecta
otro número, la fila vieja no coincide y se vuelve a subir sola. Con varios envíos a la vez del mismo medio se sube **una**
sola vez (candado en el proceso y en Postgres). Si Meta rechaza un id que veníamos reutilizando por «media vencido o
inválido» (códigos 131052/131053, subcódigos 1357004/2018047, o un 100 / 131009 cuyo texto hable del media) se invalida, se
sube de nuevo y se **reintenta una sola vez**. **131047 no cuenta**: es «ventana de 24 h cerrada», no un media vencido. Las
reglas están en `STALE_MEDIA_RULES` (`src/lib/media-cache.ts`) y **faltan por confirmar contra un número real**.

Ante la concurrencia, la renovación es segura: si muchos envíos rechazan el mismo id vencido, el archivo se sube **una sola
vez** (se comparte la subida en el proceso y, entre instancias, un arrendamiento en la fila de la caché) y los demás reciben
el id nuevo. La invalidación borra la fila **solo si todavía guarda el id que falló**: un id que otro envío ya renovó se
conserva.

**Sin transacciones abiertas durante la red.** Leer el archivo de R2 y subirlo a Meta tarda segundos y **no retiene ninguna
conexión de Postgres** (el pool es de 10). Quien va a subir deja en la fila de la caché un marcador `pending:<token>` con
vencimiento de **2 minutos**, escrito en una transacción de milisegundos (candado de Postgres + lectura + escritura, sin
red); sube; y reemplaza el marcador por el `media_id` real en una sola sentencia. Las demás llamadas (de este u otro
proceso) ven el marcador, **esperan con consultas cortas** (cada 250 ms) y reutilizan el id cuando aparece. Si quien subía
se cae, el marcador vence solo y otra llamada lo retoma; si la subida falla, el marcador se suelta enseguida. Un marcador
nunca se usa como `media_id`.

## Archivos huérfanos: reconciliación (BD ↔ R2 ↔ disco)

Los borrados de binarios son «mejor esfuerzo»: si R2 o el disco fallan justo al borrar, la fila ya no existe pero el archivo se
queda (también los restos `.part` de una escritura interrumpida, y todo lo de una organización borrada, cuyas filas se van en
cascada pero no sus archivos). Un **huérfano** es un archivo cuyo id (el último tramo de su nombre) no existe ni en
`media_asset` ni en `media_library_item`, o un temporal `.part` / `.dedup` abandonado. Las filas `pending` de subidas a medias y
los adjuntos aún descargándose **sí cuentan como referencia**: nunca se confunden con huérfanos.

- **Una vez al día** el mantenimiento reconcilia R2 y `MEDIA_DIR`. **Por defecto solo informa** en el log
  (`[medios] reconciliación (solo informe): N archivo(s) huérfano(s)…`). Con `MEDIA_RECONCILE_AUTO=on` borra solo, con tope de
  100 por corrida y únicamente lo de más de 72 h.
- **A mano y con control:** `pnpm reconciliar-medios` (informe, no cambia nada). Para borrar de verdad:
  `pnpm reconciliar-medios -- --aplicar --confirmo-borrar`. Opciones: `--edad-horas N` (por defecto 24), `--max-borrar N`
  (200), `--max-escaneo N` (20000) y `--filas [N]`, que además **lista** (sin tocar nada) las filas cuyo archivo ya no está.
- **Garantías:** dry-run por defecto; lo más reciente que la edad mínima (24 h) no se toca (por `LastModified` en R2 y `mtime`
  en disco); la base se consulta **después** de listar y otra vez justo antes de borrar (una fila que aparezca salva su
  archivo); tope por corrida; **nunca** toca el icono de la marca, claves que no tienen la forma `org/<org>/medios/<id>` o
  `pending/<org>/<id>`, enlaces simbólicos ni nada fuera de `MEDIA_DIR/<org>/`; si el listado o la base fallan, aborta antes de
  borrar; y **nunca borra filas**.
- **Freno de «base equivocada»:** si las tablas de medios están vacías, o si de 20 o más archivos viejos revisados **ninguno** tiene
  fila, no borra nada y lo dice (`FRENADO`): casi seguro la base no es la de ese bucket (un entorno de pruebas apuntando al bucket
  de producción, una restauración a medias).
- **Límites:** el listado de R2 es por páginas de 1000 y cada corrida mira hasta 20 000 objetos (la siguiente retoma donde
  quedó); el token de R2 necesita permiso de lectura de listados (con *Object Read & Write* basta). Un huérfano de menos de la
  edad mínima se limpia en una corrida posterior. Lo que tiene fila pero perdió su archivo **solo se informa** (`--filas`): puede
  ser historial que alguien quiera conservar.

## Adjuntos entrantes pendientes o fallidos: reintento proactivo

Si al llegar el webhook R2 (o Meta) estaba caído, o la instancia se reinició a media descarga, el adjunto queda `pending` o
`failed`. Antes solo se reintentaba al **abrir** esa conversación: si nadie la abría en ~30 días, Meta borraba el archivo y se
perdía. Ahora, **cada 10 minutos**, un barrido vuelve a bajarlos de Meta con estos frenos:

- **Vigencia:** solo adjuntos de menos de **28 días** (Meta conserva ~30).
- **Espera creciente por adjunto:** 15 min, 30, 1 h, 2 h… con tope de 12 h entre intentos, y un máximo de 40 intentos (unos 19
  días): una caída larga no los agota, y no es un bucle infinito. Un `pending` de menos de 10 min no se toca (aún lo baja la
  descarga normal del webhook).
- **Lo permanente no se reintenta:** si Meta responde que el archivo ya no existe (404/410) o pesa más del límite, queda
  `[gone]` y no se vuelve a intentar.
- **Tope por tanda y cortacircuitos:** a lo sumo 10 descargas por tanda (la más antigua primero, que es la más cercana a
  caducar), y tras 3 fallas seguidas la tanda se detiene (R2 o Meta siguen caídos: no se martilla).
- El número de intento y lo permanente se guardan en `media_asset.fetch_error` (`[intento N] …` / `[gone] …`), sin migración.
  Solo cubre adjuntos **entrantes** (y ecos): los de la biblioteca y los salientes no se descargan de Meta.

## Lo que sigue en disco (a propósito, spec 049)

Con R2 activo, los **adjuntos** (entrantes y salientes), el **icono de la pestaña** y lo nuevo de la biblioteca (incluido el logo, que es un elemento de la biblioteca) se guardan en R2. En `MEDIA_DIR` queda **solo lo anterior a encender R2** y todo lo que se guarde mientras R2 esté apagado o incompleto (el arranque y `/api/health` avisan si está incompleto). Por eso el disco de Render todavía no se puede quitar mientras haya archivos antiguos sin migrar. Lo que esta spec elimina es el crecimiento **por envío** y el tráfico de subida/bajada de la biblioteca.

### Icono de la pestaña (favicon) con R2

Cada organización tiene un solo icono, con el nombre fijo `favicon`: en R2 es el objeto `org/<orgId>/medios/favicon` y en disco `MEDIA_DIR/<orgId>/favicon`.

- **Subir** (con R2 activo): va a R2 con su tipo real y **se borra la copia de disco** si había una de antes de encender R2, para que nunca reaparezca una versión vieja.
- **Servir**: se lee **primero de R2**; el disco es solo respaldo (icono anterior a R2, o R2 sin responder). Si no hay ninguno, la pestaña usa el icono generado de la marca.
- **Quitar**: se borra de **R2 y del disco**. Cada borrado es independiente y no rompe la respuesta si falla uno (queda un aviso `[favicon] no se pudo borrar…` en el log; un huérfano es inofensivo porque la marca ya no lo referencia).
- Con R2 apagado todo sigue como antes, solo en disco. Si apagas R2 y vuelves a encenderlo, un icono que quedó en R2 volvería a tener prioridad sobre uno subido en el intervalo: quítalo y súbelo de nuevo.

### Miniaturas de anuncios de Meta: sin copia local (`AD_CREATIVE_LOCAL_COPY`)

Las miniaturas de los creativos **ya no se copian a `MEDIA_DIR`** (apagado por defecto). Afecta a los dos flujos que lo hacían:
el sync del catálogo (`syncCreatives`, spec 040) y la imagen del anuncio de origen en el webhook (`guardarCreativo`, spec 018).

- Con la bandera apagada no se descarga nada ni se escribe en disco; las URL remotas siguen en `meta_ad` y `creative_asset_id`
  / `creative_source_url` no se modifican. El resto del sync (catálogo, gasto, Resultados) no cambia.
- La UI usa el ícono de megáfono donde no hay copia (Resultados, vista previa, selector de Automatizaciones, tarjeta de origen).
  Las copias ya guardadas se siguen sirviendo.
- `AD_CREATIVE_LOCAL_COPY=on` (también `1`, `true`, `si`) restaura la copia local. El código de descarga se conserva para
  migrarlo a R2 más adelante.
- **Liberar el disco ya ocupado:** `pnpm limpiar-creativos` (simulación: solo cuenta y lista). Para borrar de verdad:
  `pnpm limpiar-creativos -- --aplicar --confirmo-borrar`. Borra los `media_asset` con `payload->>'origen' = 'catalogo'`
  (copias del catálogo), pone `meta_ad.creative_asset_id = null` y quita su archivo del volumen. **No toca** las imágenes del
  anuncio de origen (`origen = 'anuncio'`, ligadas a `ad_attribution`). Hazlo con la bandera apagada: encendida, el siguiente
  sync las volvería a descargar.

## Lo anterior (retrocompatibilidad)

Cada fila de la biblioteca lleva `storage` (`local` o `r2`). Lo subido antes de encender R2 **sigue sirviéndose del disco**
y también se beneficia de la caché del `media_id`. No hay migración obligatoria. Un video antiguo de más de 16 MB y los
AVIF se conservan pero se marcan «No se envía por WhatsApp» y no se ofrecen en el paso «Enviar archivo».

Consecuencias a conocer:

- Un adjunto ya enviado desde la biblioteca **no tiene copia propia**: su vista previa en el hilo se sirve del medio. Si el
  medio se borra de la biblioteca, esa vista previa pasa a «se eliminó de la biblioteca» (el mensaje en WhatsApp no cambia).
- **Borrar un medio en uso se bloquea.** `DELETE /api/medios/:id` y `POST /api/medios/eliminar` rechazan (409 `in_use`) el
  borrado si el medio es la imagen de un **servicio, oferta (combo) o integrante del equipo**, el **logo o el icono de
  sellos de la tarjeta de fidelidad**, o lo envía un paso de **automatización**. La respuesta trae `error.usos` (o `usos`
  dentro de cada elemento de `omitidos`): `[{ tipo, id, nombre, detalle? }]`, además del `message` de siempre. Antes solo se
  comprobaban las automatizaciones y lo demás se quedaba sin imagen en silencio.
- **Lo que no se puede comprobar:** el enlace «Copiar URL» (`/api/medios/<id>/archivo`) que alguien pegó a mano en una
  plantilla, un anuncio o su sitio web no deja rastro en la base. Borrar el medio rompe esos enlaces (404). Por eso un
  borrado exitoso responde con un `aviso` que lo recuerda, y los diálogos de borrado lo advierten.
- **Apagar `R2_STORAGE` con archivos ya en R2** los deja ilegibles desde el CRM (no hay copia local). Antes de apagarlo,
  descarga lo que necesites desde Cloudflare.

## Costos (orientativos, revisa la tarifa vigente de Cloudflare)

R2 no cobra la salida de datos. Se paga el almacenamiento (hay una capa gratuita mensual) y las operaciones: un `PUT` por
archivo subido (clase A), más un `HEAD`/`GET` por confirmación (clase B) y las lecturas de la galería. Para un negocio con
cientos de archivos y miles de envíos al mes queda dentro de la capa gratuita.

## Si algo falla

| Síntoma | Causa probable |
|---|---|
| «No se pudo conectar con el almacenamiento (o la configuración CORS del bucket)» al subir | Falta o está mal el CORS (el origen debe estar en `AllowedOrigins` y ser igual a `APP_BASE_URL`, p. ej. `https://app.sistemalia.com`, sin barra final) |
| «La subida expiró o no se permitió» (403) | La firma venció (15 min) o el reloj del equipo está muy desfasado |
| Se sube pero «no llegó completo o su tamaño no coincide» | El navegador cortó la subida; se borra solo, vuelve a subirlo |
| `pnpm doctor` marca R2 en ✗ | Variables incompletas, `R2_ENDPOINT` con el nombre del bucket, o token sin permiso sobre ese bucket |
| Un paso «Enviar archivo» falla con «El archivo ya no está en el almacenamiento» | El objeto se borró del bucket y no hay `media_id` vigente: súbelo de nuevo a Medios |
