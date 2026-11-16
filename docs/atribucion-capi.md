# Atribución de anuncios y Conversions API

> Feature opcional (016), apagada por defecto. Se enciende con `ATRIBUCION=on`.
> **De qué anuncio llegó** cada conversación se ve siempre, con la bandera o
> sin ella (018): ver [abajo](#de-qué-anuncio-llegó-siempre-visible).

## El problema que resuelve

Si anuncias con **Click-to-WhatsApp**, Meta sabe qué conversaciones
**empezaron** desde un anuncio. No sabe cuáles **sirvieron**. Sin nadie que se
lo diga, el algoritmo optimiza hacia lo único que ve —que alguien abra el
chat— y te entrega el público más barato de hacer escribir, que rara vez es el
que compra. Se siente como "me llegan muchos mensajes y no cierro ninguno".

Vocero está en el único lugar donde esa verdad existe: sabe que esta
conversación vino del anuncio A, que se calificó el martes y que se ganó el
viernes por $12,000. Encender esta feature es devolverle a Meta ese desenlace,
para que el mismo presupuesto empiece a comprar clientes en vez de chats.

## Cómo se enciende

1. `ATRIBUCION=on` en el entorno (en Coolify: variable de runtime, y
   **redeploy** — reiniciar no basta).
2. Ajustes → **Anuncios**: pega el **ID de tu dataset** y guarda. Si ya
   conectaste WhatsApp, **no necesitas pegar token**: se reusa el del negocio,
   que es el mismo que autoriza publicar en el dataset.
3. Elige **qué etapa de tu pipeline significa "lead calificado"**. La venta no
   se configura: se reporta sola cuando el trato entra a tu etapa ganada.

Eso es todo. A partir de ahí, cada lead que llegó por un anuncio y avanza en tu
tablero se le reporta a Meta.

### De dónde sale el ID del dataset

Administrador de eventos de Meta → tu conjunto de datos → el número largo. En
la práctica, el dataset de mensajería **es el de tu propia cuenta de WhatsApp**:
`POST {waba_id}/dataset` en la Graph API devuelve ese mismo id, y es idempotente
(repetirlo devuelve el existente).

## Qué se reporta, exactamente

| Cuándo | Evento de Meta | Datos |
|---|---|---|
| El lead entra a tu etapa "calificado" | `QualifiedLead` | `lead_stage: "qualified"` |
| El lead entra a tu etapa ganada | `Purchase` | `lead_stage: "won"` + `value`/`currency` si el trato tiene monto |

Ambos salen con el `ctwa_clid` del clic y el id de tu cuenta de WhatsApp.
**Nunca** viaja el teléfono, el nombre ni el texto del contacto.

Los dos eventos se disparan desde la única puerta que mueve leads de etapa, así
que da igual quién lo mueva: tú arrastrando la tarjeta, el agente incluido o tu
propio bot por `/api/bot/*`.

## De qué anuncio llegó (siempre visible)

Meta dice de qué anuncio vino una persona en el **primer** mensaje de la
conversación (el objeto `referral` del webhook), y no lo vuelve a decir. Vocero
lo guarda con la conversación y lo enseña donde se atiende:

- **Bandeja**: el renglón dice «Anuncio · titular» («Publicación» si el clic
  vino de una publicación y no de un anuncio pagado), y aparece un filtro
  **Anuncios** en cuanto hay al menos una conversación así.
- **Panel del contacto** y **cajón del trato** del pipeline: una tarjeta con la
  imagen del creativo, el titular y el texto del anuncio, «Primer mensaje ·
  fecha», «con video» si lo era, el ID del anuncio y un enlace **Ver anuncio**.

Esto **no depende de la bandera**: el dato viaja dentro del webhook que la
instancia ya recibe, no pide credenciales ni llama a nadie, y es inerte si nunca
llega un anuncio. Lo que la bandera sí decide:

| | Sin `ATRIBUCION` | Con `ATRIBUCION=on` |
|---|---|---|
| Origen del anuncio en la bandeja | Sí | Sí |
| `ctwa_clid` guardado | **No** (ni en su columna ni dentro del `raw`) | Sí |
| «Meta identificó el clic» en la tarjeta | No | Sí (solo la presencia; el valor jamás sale del servidor) |
| Ajustes → Anuncios y envío a Meta | 404 | Sí |

Lo que la tarjeta **no** trae: el nombre del anuncio, de la campaña o del
conjunto. Meta no los manda en el `referral`; pedirlos exigiría la API de
Marketing con permisos de anuncios del negocio. Por ahora solo WhatsApp:
Instagram y Messenger mandan otra forma de `referral`.

### La imagen del creativo

La URL que manda Meta **caduca en días** (el parámetro `oe=` de su CDN), así que
se copia al llegar: una vez por anuncio, al mismo volumen de adjuntos
(`MEDIA_DIR`), y se sirve por `/api/media/{id}` con sesión, como cualquier
adjunto. Como esa URL llega dentro de un payload externo, la copia se defiende
de que la usen para hacer que el servidor pida cosas de su propia red (SSRF):

- solo `https://` a hosts de Meta (`fbcdn.net`, `fbsbx.com`, `facebook.com`,
  `cdninstagram.com`, `instagram.com` y sus subdominios), sin usuario ni
  contraseña en la URL y sin puertos explícitos;
- las redirecciones no se siguen solas: cada salto se vuelve a validar, máximo 3;
- solo JPEG, PNG, WebP o GIF (nunca SVG, que servido desde el CRM podría
  ejecutar scripts), de hasta 300 KB, leídos con tope;
- 5 segundos por intento y **un** reintento si el fallo fue de red, 5xx o 429.

Si aun así no se pudo, la tarjeta sale igual, sin imagen, y abrir el contacto la
vuelve a intentar en segundo plano, como mucho una vez cada 10 minutos por
anuncio. Eso cubre también las conversaciones que 016 guardó antes de que
existiera la copia: su `raw` conserva la URL, y mientras Meta no la caduque la
imagen aparece sola al abrir el contacto.

En pruebas, con los mocks habilitados (nunca en producción), se acepta además el
origen de `META_GRAPH_BASE_URL`, donde el wa-mock sirve creativos de mentira.

## Campaña, conjunto de anuncios y gasto (Marketing API, opcional)

El webhook de WhatsApp solo dice **de qué anuncio** vino la conversación (`source_id`). No trae el nombre del
anuncio, ni su conjunto, ni su campaña, ni cuánto costó. Para eso hay un conector opcional con la Marketing API de
Meta (spec [038](../specs/038-meta-marketing-api/spec.md)), detrás de la misma bandera `ATRIBUCION`.

**Cómo conectarlo** — Ajustes → Anuncios → tarjeta *Meta Ads* → bloque *Campañas y gasto*:

1. **ID de la cuenta publicitaria**: Administrador de anuncios → Configuración de la cuenta. Sirve con o sin `act_`.
2. **Token con el permiso `ads_read`**: se crea con un *usuario del sistema* en el Business Manager (Configuración del
   negocio → Usuarios → Usuarios del sistema → Generar token, con la app y el permiso `ads_read`, y asignándole la
   cuenta publicitaria). **No sirve el token de WhatsApp.** Se guarda cifrado y no vuelve a mostrarse.
3. **Conectar** guarda *y prueba*: un token que Meta rechaza no se guarda, y el mensaje dice si es el token, el permiso
   o la cuenta.

**Qué hace después**, siempre en segundo plano (la ingesta del mensaje jamás espera a Meta):

- **Se lee la cuenta publicitaria ENTERA** (spec [039](../specs/039-meta-catalogo-completo-y-drilldown/spec.md)), no solo
  los anuncios que ya escribieron: cada 12 horas se lista todo (`/{act}/ads`, con su campaña, conjunto y estado, también
  lo pausado) y el gasto se trae de todos los anuncios. Por eso una campaña pausada o sin conversaciones aparece con su
  gasto. Un anuncio que gastó y ya no está en el listado (borrado) entra por su gasto, con el nombre que Meta le dio.
- El gasto diario se sincroniza cada 3 horas, por **ventanas de 7 días** (como máximo 4 por pasada, para no agotar la
  cuota de Meta): la de los últimos 7 días siempre se vuelve a pedir porque Meta revisa las cifras recientes, y hacia
  atrás se trae el historial (90 días la primera vez, en varias pasadas de un minuto).
- **Si en Resultados eliges un rango más viejo** de lo ya traído (hasta 366 días), la pantalla encarga el relleno y dice
  «Trayendo de Meta el gasto de este periodo…»; la lectura nunca espera a Meta.
- **Cuadre con la cuenta**: además del gasto por anuncio se trae el de la cuenta entera. Debajo de la tabla, Resultados
  dice «Gasto de tu cuenta en Meta» y, si lo desglosado no lo alcanza (anuncios eliminados que Meta ya no devuelve),
  una línea **«Sin desglosar por anuncio»** con la diferencia: nunca se maquilla.
- Una ventana de gasto que Meta devuelve cortada **no se guarda** (dinero a medias es peor que dinero viejo): se conserva
  lo anterior y Ajustes avisa.
- Los anuncios que llegan por WhatsApp y no están en la cuenta (de otra cuenta, borrados) se consultan por su id, como en
  la 038.

**Dónde se ve**: la tarjeta de origen del contacto muestra «Campaña › Conjunto › Anuncio», y **Resultados → Origen y
anuncios** agrupa por campaña, conjunto o anuncio y suma gasto, costo por conversación, por prospecto y
por cita (esta última solo con la agenda encendida). Un costo en «—» significa que falta el gasto o no hubo resultados:
nunca es un cero que parezca dato. Un anuncio con gasto y sin conversaciones **sí aparece**: es el dinero tirado.

**Navegar como en el Administrador de Anuncios**: la vista arranca por campaña. Un clic en el nombre de una campaña baja a
sus conjuntos; un clic en un conjunto, a sus anuncios. Arriba salen las migas de pan («Todas las campañas › Campaña ›
Conjunto»), cada tramo clicable para volver. Las pestañas Campaña | Conjunto | Anuncio y los dos selectores usan las
mismas reglas que el clic (subir de pestaña quita los filtros de abajo). Al pie hay una fila de **Total** de todo lo
filtrado, y las campañas y anuncios pausados llevan su insignia.

**Casillas, como en Meta** (spec [040](../specs/040-resultados-seleccion-y-creativos/spec.md)): cada fila de las tres
pestañas lleva una casilla a la izquierda, con una maestra en la cabecera. Las campañas marcadas filtran las pestañas
**Conjunto** y **Anuncio**; los conjuntos marcados, la pestaña **Anuncio**; los anuncios marcados solo cambian el Total.
Volver a una pestaña conserva sus casillas, y cambiar las de arriba vacía las de abajo. Sobre la tabla, píldoras dicen de
dónde viene el filtro («Conjuntos de 2 campañas», «Quitar») y cuánto hay marcado («3 conjuntos seleccionados», «Limpiar»).
La fila de **Total** se recalcula (en el servidor, con las mismas reglas de costos) sobre lo marcado en la pestaña actual,
o sobre toda la vista si no hay nada marcado.

**Vista previa de los creativos**: la sincronización trae también el creativo de cada anuncio (`creative{…}` y
`preview_shareable_link`) y **copia la imagen al volumen local** (no se enlaza a Meta: sus URL caducan y el CRM no admite
imágenes de otros hosts). En la pestaña Anuncio la miniatura es la real (el megáfono solo si no hay imagen), y un clic en
ella o en el ojo abre un modal con la imagen en grande, el titular, el texto principal, la campaña y el conjunto, y un
enlace a la vista previa nativa de Meta si hay. Si Meta rechaza el listado con creativos por pesado (error 1), se reintenta
sin ellos: el catálogo y el gasto siguen llegando y Ajustes avisa.

**En Ajustes → Anuncios**: una sola tarjeta *Meta Ads* con las dos conexiones (campañas y gasto; conversiones). El
dataset de las conversiones se elige de una lista de la cuenta publicitaria (con «Escribir el ID a mano» por si el de
WhatsApp no aparece). El registro de eventos reportados queda en un acordeón cerrado, y el enrutamiento por anuncio
muestra el nombre real de cada anuncio, conjunto y campaña, y permite elegir el anuncio de la cuenta al vincularlo.

**Si algo falla**: nada de lo core se afecta. El conector lo dice en Ajustes (token vencido, falta `ads_read`) y
Resultados muestra el aviso; con el límite de uso de Meta espera y reintenta solo; si un anuncio no se puede leer lo
reintenta con espera creciente. **Desconectar** conserva lo ya traído y solo detiene la sincronización.

Cosas que conviene saber: el gasto es el de la zona horaria de la cuenta publicitaria (si difiere de la del negocio, el
día de borde puede correrse); los costos por prospecto y por cita son gasto ÷ resultados del periodo, una aproximación
coherente con el resto de Resultados, no una atribución causal; y Instagram y Messenger siguen sin esta jerarquía.

## Cómo saber si está funcionando

Ajustes → Anuncios → **Actividad**. Ahí está lo último que se reportó, con su
estado:

- **Enviado** — Meta acusó recibo (`fbtrace_id` es la referencia que pide su
  soporte para rastrear un evento).
- **Fallido** — Meta lo rechazó, o el token venció, o se cayó la red. El motivo
  está escrito tal cual lo dijo Meta.
- **Omitido** — no había nada que reportar: la conversación no vino de un
  anuncio, o falta configurar el dataset.

Esa tabla es la fuente de verdad, no el Administrador de eventos: sus reportes
tardan y sus APIs de estadísticas **están ciegas a los eventos de mensajería**
(devuelven vacío aunque el dataset esté recibiendo eventos).

## Gotchas de Meta que cuesta descubrir solo

Esto es lo que se aprendió operando esta integración en producción durante
meses. Ninguno aparece con esa claridad en la documentación oficial:

1. **Meta responde `200` aunque descarte tu evento.** El único acuse real es
   `events_received >= 1`. Vocero lo comprueba y marca la fila como fallida
   cuando llega en cero — si no, un evento tirado a la basura se vería idéntico
   a uno bueno.
2. **No existe el evento de prueba sintético.** Meta valida el `ctwa_clid`
   contra un clic real: cualquier valor inventado devuelve `code 100 /
   error_subcode 2804087`. La única forma de registrar una conversión es un lead
   que de verdad hizo clic en tu anuncio.
3. **`custom_data` es lo único reglable.** Si algún día envuelves estos eventos
   en una *conversión personalizada*, sus reglas solo pueden mirar `custom_data`
   y la URL — `event_name` y el origen de acción **no son parámetros
   reglables**. Por eso cada evento sale con `lead_stage`: sin él, la conversión
   personalizada se queda en cero para siempre y nada te dice por qué.
4. **El catálogo de eventos es cerrado.** `business_messaging` solo acepta
   14 nombres (`Purchase`, `QualifiedLead`, `InitiateCheckout`, `ViewContent`…).
   Un nombre propio es un `400` opaco.
5. **`QualifiedLead` solo es elegible en campañas de CLIENTES POTENCIALES.** Si
   optimizas una campaña de **ventas** con destino de mensajes, ese evento no
   aparece en el selector (ver la receta de abajo).
6. **El aviso "sin evento de conversión configurado"** que Meta pinta en el
   selector de la campaña puede quedarse ahí para siempre aunque tu dataset esté
   recibiendo eventos: ese registro es un constructo del píxel web y no se puede
   escribir para un dataset de mensajería pura. Es cosmético; la campaña publica
   igual y la atribución va por el `ctwa_clid`.

## Receta: optimizar una campaña de VENTAS

Como `QualifiedLead` no es elegible ahí, quien quiera optimizar una campaña de
ventas con destino de mensajes necesita un evento que **sí** esté en la
intersección de "campaña de ventas" y "catálogo de mensajería":
`InitiateCheckout`, `ViewContent` o `Purchase`.

Vocero **no** hace esto de fábrica a propósito: duplicar cada lead calificado
como "inició pago" es una decisión de negocio, no una verdad del CRM, y quien la
tome debe saber que lo está haciendo. Si la quieres, son tres líneas en tu fork:

```ts
// src/server/attribution/conversions.ts — dentro de reportStageChange,
// después de emitir QualifiedLead:
await emitConversion(
  input.organizationId,
  row.conversationId,
  "InitiateCheckout",           // el espejo que tu campaña de ventas sí acepta
  { lead_stage: "qualified" }
);
```

`emitConversion` es público justamente para esto: hereda el dedup, el manejo del
acuse y el registro en la actividad. Dos advertencias ganadas a golpes:

- El espejo debe acompañar a un envío **recién intentado**. Si lo emites por un
  lead calificado hace semanas, saldrá con la fecha de hoy y romperá la
  atribución.
- Deja `Purchase` para la venta cerrada. Y **jamás** dispares un `Purchase` con
  un importe de prueba: un solo valor falso envenena la optimización por valor.

## Preguntas frecuentes

**¿Y los leads de antes de encender la bandera?** No se atribuyen: sin `ATRIBUCION`
el CRM no guarda el `ctwa_clid`, y sin él no hay nada que reportar. Tampoco se
pierde gran cosa — la ventana de atribución de Meta se mide en días. De qué
anuncio llegaron sí lo sabes: eso se guarda siempre, solo que sin el clic.

**¿Qué pasa si Meta está caído?** El lead se mueve igual. La conversión queda
registrada como fallida con el motivo. Ninguna parte de tu operación depende de
que Meta conteste.

**¿Y el Laboratorio?** Una conversación de prueba **nunca** produce un evento.
Es el mismo guardrail que impide que el Laboratorio mande WhatsApps reales.

**¿Se puede apagar?** Sí: quita `ATRIBUCION` y toda la superficie de la
Conversions API desaparece, y los clics nuevos dejan de guardarse (de qué anuncio
llegó cada conversación se sigue viendo). O desconecta el dataset desde la
pantalla y deja de reportarse, conservando la bitácora de lo que ya se dijo.
