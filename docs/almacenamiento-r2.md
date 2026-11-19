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
   Si falta alguna con `R2_STORAGE=on`, el sistema **degrada a disco local** (los archivos nuevos van a `MEDIA_DIR`) y el
   doctor lo marca.

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
inválido» (códigos 131052/131053/131047, subcódigos 1357004/2018047, o un 100 que habla del media) se invalida, se sube de
nuevo y se **reintenta una sola vez**.

## Lo que sigue en disco (a propósito, spec 049)

Los **adjuntos entrantes** de las conversaciones, el **logo**, el icono y las **miniaturas de los creativos de anuncios**
siguen en `MEDIA_DIR`. Por eso el disco de Render todavía no se puede quitar. Lo que esta spec elimina es el crecimiento
**por envío** y el tráfico de subida/bajada de la biblioteca.

## Lo anterior (retrocompatibilidad)

Cada fila de la biblioteca lleva `storage` (`local` o `r2`). Lo subido antes de encender R2 **sigue sirviéndose del disco**
y también se beneficia de la caché del `media_id`. No hay migración obligatoria. Un video antiguo de más de 16 MB y los
AVIF se conservan pero se marcan «No se envía por WhatsApp» y no se ofrecen en el paso «Enviar archivo».

Consecuencias a conocer:

- Un adjunto ya enviado desde la biblioteca **no tiene copia propia**: su vista previa en el hilo se sirve del medio. Si el
  medio se borra de la biblioteca, esa vista previa pasa a «se eliminó de la biblioteca» (el mensaje en WhatsApp no cambia).
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
