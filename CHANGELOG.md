# Cambios

Qué trae cada versión de Vocero CRM y qué hacer para actualizar. La versión
sigue el SemVer del [README](README.md#versiones): una menor trae funciones
nuevas y actualizar es redesplegar. Desde 1.4.0, cada tag `vX.Y.Z` publica la
imagen `ghcr.io/kevinrivm/vocero-crm:X.Y.Z`.

## Sin publicar

- **Panel**: el filtro de equipo lleva la etiqueta «Profesional:» a su izquierda. Al elegir a alguien, tarjetas, gráficos, servicios top y rendimiento se recalculan solo con su actividad (los cumpleaños del mes son de todos los clientes).
- **Panel sin segundo scroll ni espacio vacío**: la tabla oculta para lectores de pantalla de los gráficos quedaba posicionada fuera del área con scroll y alargaba toda la página. El área de contenido ahora es `relative`, así que nada oculto puede ensanchar el documento (comprobado en Panel, Resultados, Caja, Clientes y Citas).
- **Barra lateral**: en escritorio, si la ventana es baja y el menú no cabe, ahora se desplaza (antes lo cortaba y no se llegaba a Ajustes ni a cerrar sesión).

### Carga masiva desde Excel y «Copiar URL» en Medios (módulo SALON)

- **Carga masiva:** botón «Carga masiva» junto a «Nuevo…» en Servicios y ofertas, Equipo y Clientes. La ventana
  baja la plantilla `.xlsx` del módulo (encabezados exactos, filas de ejemplo y hoja de instrucciones), recibe el
  archivo (arrastrar o elegir) y muestra cuántas filas entraron y cuáles no, con su fila y columna.
- **Reglas:** cada fila se valida con el MISMO esquema Zod del formulario; las filas válidas entran en lotes dentro
  de una transacción y una fila mala no frena a las demás. Máx. 500 filas y 2 MB por archivo. Lo que ya existe se
  omite (mismo nombre en servicios, ofertas y equipo; mismo celular en clientes: si ya es contacto pasa a cliente
  sin duplicarse, y no se registra ninguna venta). Solo dueño o administrador.
- **Imágenes:** `imagen_url` / `foto_url` aceptan la URL copiada desde Medios; solo valen imágenes de la biblioteca
  de la propia organización.
- **Medios:** vuelve «Copiar URL» (en la tarjeta y en la ventana del archivo) con aviso «¡URL copiada!».
- API: `POST /api/negocio/carga-masiva?modulo=` y `GET /api/negocio/carga-masiva/plantilla?modulo=`. Nueva dependencia: `exceljs`.

### Auditoría de seguridad y limpieza

- **Seguridad:** `POST /api/negocio/ventas` ya no deja que un miembro del equipo fije una comisión distinta ni
  ponga la venta en otro día (solo dueño/administrador; 403). La pantalla oculta la fecha a un miembro.
- **Limpieza:** se quitó código muerto del salón (secciones de reporte sin uso, `dateLabel`, `salesQuerySchema`)
  y exports que nadie importaba; sin cambios de comportamiento.

### Caja: nombre solo con letras y fecha de atención; Clientes: fecha al 50 %

- **Caja:** «Nombre del cliente» solo admite letras y espacios (no se teclean números ni signos; el aviso sale
  al salir del campo; también lo exige la API). Nuevo «Fecha de atención» junto a «Atendió», cada uno al 50 %:
  hoy guarda «ahora»; otro día (pasado o futuro) lo guarda a ese día.
- **Clientes → Nuevo cliente:** «Fecha de atención» ocupa el 50 % de la fila, igual que «Atendió».

### Cerrar sesión pide confirmación

- El botón de la barra lateral abre «¿Seguro que quieres cerrar sesión?» (centrado, con X, Escape y clic fuera
  para cancelar); solo «Cerrar sesión» sale.

### Medios: solo archivos locales, vista compacta y borrado en lote

- **Sin enlaces:** se quitó «Insertar desde URL» (botón, ventana, `POST /api/medios/url` y la descarga
  remota con su guardia SSRF), y «Copiar URL», «Abrir» y la barra con la ruta del archivo. Solo se sube
  desde el dispositivo. La ruta pública del archivo sigue sirviendo las imágenes en la app.
- **Vista compacta:** el visor de pantalla completa pasó a una ventana centrada, con el nombre editable
  (`PATCH /api/medios/[id]`; la URL interna no cambia), Descargar y Borrar.
- **Galería:** tacho de borrado rápido al pasar el cursor y casillas de selección con «Eliminar
  seleccionados» (`POST /api/medios/eliminar`; los que no se pueden borrar se avisan sin frenar al resto).

### Entrada directa al Panel (módulo SALON)

- Con SALON encendido, la raíz `/` (y, por tanto, iniciar sesión) lleva al Panel y «Panel» queda activo. Un
  miembro del equipo, que no ve el Panel, entra a Citas (con agenda) o a Contactos. Sin SALON, todo igual.

### Barra lateral de la v1.0 (módulo SALON)

- **Orden:** Trabajo → Panel · Caja · Citas · Clientes · Contactos · Servicios · Equipo · Medios; Sistema → Ajustes.
- **Oculto hasta la v2.0:** Bandeja, Pipeline y el bloque Agente (Guía de inicio, Agente, Laboratorio, Resultados).
  Solo se quitan los enlaces: las rutas siguen funcionando. `NAV_V2` en `src/lib/nav.ts` los devuelve al menú.

### Caja: «Editar venta» con auditoría (módulo SALON)

- **Editar:** cada fila de Caja tiene un lápiz (dueño/administrador) que abre «Editar venta»: ítems
  (carrito con «Otro» y su detalle), quién atendió, monto cobrado y comisión puntual opcional. El cliente,
  la fecha y el método de pago no cambian aquí. `PUT /api/negocio/ventas/[id]`.
- **Auditoría:** tabla `service_sale_edit` (migración `0032`): en la misma transacción que la corrección
  guarda la venta antes y después (profesional, monto, comisión, ítems), quién y cuándo. Sin cambios reales
  no escribe nada. Sin clave foránea a la venta, así el rastro sobrevive a una anulación.
- **Sincronización:** el historial y las métricas de la ficha del Cliente y el Panel leen de las ventas, así
  que se actualizan solos. El reparto y la comisión se recalculan con las reglas vigentes.

### Clientes: «Nuevo cliente» con el mismo carrito que Caja (módulo SALON)

- **Mismo formulario que «Registrar venta»:** Nombre + Celular, Cumpleaños, Atendió (con la Fecha de
  atención al lado), Servicios y ofertas (carrito con «Otro» y su detalle obligatorio), Monto cobrado
  (suma automática, editable), Método de pago y Comisión distinta (%). Los campos viven en
  `src/components/negocio/sale-cart.tsx` y los usan los dos modales.
- **API:** `POST /api/negocio/clientes` recibe `items`, `amountCents`, `paymentMethod` y
  `customCommissionPercentage`; ya no hay un solo servicio ni precio de lista fijo.
- **Editar cliente:** solo datos del perfil (Nombre, Celular, Cumpleaños, Notas); las ventas se ven en el
  historial y no se editan desde ahí (solo la fecha, con auditoría).

### Caja: detalle obligatorio en «Otro» y búsqueda por celular sin duplicados (módulo SALON)

- **«Otro» con detalle:** al agregar «Otro» al carrito (y al dar de alta un cliente con «Otro») aparece
  «Escribe qué servicio u oferta es…», obligatorio (máx. 80). Se guarda en `service_sale_item.note`
  (migración `0031`) y Caja y el historial del cliente lo muestran como «Otro: Peinado para evento».
- **Autocompletado por celular:** `GET /api/negocio/contactos/buscar` consolida por celular normalizado
  cuando se escribe un número (una sola ficha por teléfono: la que ya es cliente o, si empatan, la más
  reciente). Por nombre sigue mostrando todas las coincidencias.

### Caja: ventas con varios servicios y «Yape / Plin» unificado (módulo SALON)

- **Carrito de venta**: «Registrar venta» admite varios servicios u ofertas en el mismo ticket (se buscan y agregan uno a uno, cada uno con su X para quitarlo; «Otro» lleva su propio precio). El «Monto cobrado» es la suma de los ítems y se puede editar a mano («Usar la suma» lo restablece). Solo salen los profesionales que dan TODO lo del carrito.
- **Se guarda por ítem** (`service_sale_item`): si el monto se editó, el total se reparte proporcional entre los ítems sin perder un centavo, así el desglose por servicio del Panel y de Caja suma exactamente lo cobrado. La comisión se calcula por ítem (cada servicio con su porcentaje) y se suma. Una venta con varios ítems cuenta como UNA atención; el ranking de servicios cuenta cada ítem.
- **Ya no se bloquea el precio de lista**: el monto cobrado puede diferir de la suma de los precios (antes la API devolvía `price_mismatch`). El Historial de Clientes y Caja muestran todos los servicios de cada venta unidos con « + ». `POST /api/negocio/ventas` acepta `items` (la forma de un solo ítem sigue valiendo).
- **Yape y Plin son un solo método** («Yape / Plin»): Efectivo, Yape / Plin, Tarjeta y Otro. Las ventas anteriores se convierten solas.
- Migración `0030_ventas_con_varios_items` (crea los ítems y convierte las ventas existentes, un ítem por venta). **Actualizar**: redesplegar.

### Panel rediseñado como centro de mando (módulo SALON)

- **4 tarjetas con tendencia**: ventas del mes (o del periodo), ticket promedio (ventas ÷ atenciones), atenciones y tasa de retención (de los clientes atendidos en el periodo, % con 2 o más visitas). «Este mes» se compara con el mismo tramo del mes anterior; cualquier otro rango, con el tramo anterior de igual duración.
- **Gráficos** (HTML/CSS, sin librerías): ingresos por día, semana (32-92 días) o mes con detalle al pasar el cursor; métodos de pago en dona (Efectivo, Yape/Plin, Tarjeta, Otro); servicios y ofertas top por ingresos o por veces vendido; rendimiento del equipo con ventas y comisión por profesional.
- **Selector**: Hoy, Esta semana, Este mes, Mes pasado o fechas a mano (calendario); el filtro por profesional sigue. Los cumpleaños del mes se conservan. `GET /api/negocio/panel` suma `retention`, `comparison` y `series`. Sin migración.

### Avisos de validación sin prisa y autocompletado global (Contactos, Clientes y Caja)

- Los avisos rojos de nombre y celular ya no aparecen mientras se teclea: solo al salir del campo con la información a medias, o al pulsar crear/guardar. En Contactos el botón ya no se apaga: al pulsarlo con algo mal muestra los avisos. `PhoneInput` acepta `onBlur`.
- **Autocompletado global**: en Caja (registrar venta) y en el alta de Clientes, al escribir el celular (3+ dígitos) o el nombre se buscan TODOS los contactos de WhatsApp con celular —clientes o no— («Cliente registrado encontrado» / «Contacto de WhatsApp encontrado»). Al elegir uno se completan sus datos y la venta se registra sobre ese contacto: si solo era de WhatsApp pasa a ser cliente (`salon_client = true`) sin duplicar su ficha. Nueva ruta `GET /api/negocio/contactos/buscar` (equipo del salón).

### Contactos: formulario de alta con validación en vivo

- **Celular** (antes «Teléfono con código de país»): +51 fijo, solo dígitos, exactamente 9, con máscara `921 926 452`. Se envía como `51921926452`.
- **Nombre** solo con letras y espacios (placeholder «Ej. Carlos Mendoza») y **Notas** con un ejemplo del rubro. Errores bajo cada campo y botón inhabilitado hasta que sean válidos. La API de contactos no se endureció: sigue aceptando otros países y nombres libres (importaciones y scripts).

### Integridad de contactos, clientes y Caja (módulo SALON)

- **Bandeja**: al borrar una conversación junto con el contacto, si tiene ventas en Caja se muestra una advertencia (el dinero y las comisiones se conservan en los reportes; se van conversaciones, leads y ficha). No bloquea. `GET /api/contacts/:id` devuelve `salesCount`.
- **Auditoría de la fecha de una venta**: corregir la fecha de una atención deja una fila en `service_sale_date_change` (quién, cuándo, fecha anterior y nueva) dentro de la misma transacción. La venta pasa sola al periodo correcto de Caja y comisiones. La tabla solo se inserta y no depende de la venta, así que el rastro sobrevive si la venta se anula.
- Alta de clientes: una carrera con el mismo celular ya no deja una venta sin persona; el borrado masivo decide y borra en una sola transacción con los contactos bloqueados.
- Migración `0029_auditoria_fecha_venta`. **Actualizar**: redesplegar.

### Clientes: campos estrictos, fechas sin hora y historial de atenciones (módulo SALON)

- **Nombre solo con letras y espacios** y **celular de exactamente 9 dígitos** (+51 fijo), validados igual en pantalla y en la API.
- **Fecha de atención** con un calendario propio que se ve y se elige como `DD/MM/AAAA` (sin horas en pantalla); también al corregir la fecha de una atención del historial.
- **Registrado el: DD/MM/AAAA** en la cabecera de la ficha (automático, no editable).
- El celular se ve `+51 912 345 678` en la lista y en la ficha.
- Al crear un cliente la ventana se cierra sola y la lista se refresca.
- **Historial de atenciones**: fecha, servicio u oferta, profesional, método de pago y monto.
- **Alta con detección de clientes existentes**: al escribir el celular (3 o más dígitos) o el nombre se sugieren clientes ya registrados («Cliente registrado encontrado: …»); al elegir uno se completan su nombre y cumpleaños y el foco pasa a la atención. Al guardar no se duplica: la atención se suma a su historial (una visita más y su monto al total invertido). Ya no responde 409 `client_exists` al dar de alta a un cliente repetido; `GET /api/negocio/clientes` acepta `?limit=`.
- **Lista de Clientes**: contador («Mostrando 10 de 45 clientes»), paginación de 10 en 10, casillas para seleccionar (con maestra por página) y barra «Eliminar seleccionados»: quien tiene historia (atenciones, conversaciones, citas…) solo deja de aparecer en Clientes y se conserva todo; quien no tiene nada se borra por completo. El número de «Visitas» abre la línea de tiempo del cliente. Nueva ruta `POST /api/negocio/clientes/eliminar`.

### Equipo: foto, celular, nombre estricto y servicios por profesional (módulo SALON)

- **Foto del profesional** elegida de la galería de Medios (buscador, borrar desde la galería y
  solo imágenes: el video se bloquea en pantalla y en el servidor). Se ve en la tabla de Equipo.
- **Celular**: la etiqueta pasa de «Teléfono (opcional)» a «Celular», con el **+51** fijo y
  exactamente **9 dígitos** (solo números; se guarda como `+51987654321`). Sigue siendo opcional.
- **Nombre solo con letras y espacios** (tildes y ñ incluidas): números y signos no se pueden
  teclear ni pegar, y la API los rechaza. Un celular o nombre guardado antes en otro formato se
  muestra y se corrige al editar.
- **Quién da cada servicio se elige solo desde Servicios y Ofertas** (la lista de profesionales,
  sin detallar = todos). El perfil del profesional no guarda ni restringe servicios: todo profesional
  activo se puede elegir en cualquiera. La lista de Equipo muestra foto, nombre, celular y acciones.
- Migraciones `0027_equipo_foto_y_servicios` (foto) y `0028_equipo_sin_servicios` (retira la tabla
  `staff_allowed_service`). **Actualizar**: redesplegar.

### Imagen y profesionales en Servicios y Ofertas (módulo SALON)

- **Imagen** arriba del nombre, elegida de la biblioteca de **Medios** (sin escribir URL): una
  ventana deja elegir una imagen existente o subir una nueva (JPG/PNG hasta 3 MB, WEBP/AVIF hasta
  1,5 MB), con previsualización y «Cambiar imagen» / «Eliminar». La lista de Servicios y Ofertas
  muestra la miniatura.
- **«Detallar profesionales que dan el servicio (Opcional)»** bajo el nombre: apagada, lo dan
  todos los profesionales (es lo normal y lo que se guarda: sin filas); encendida, una lista con
  buscador para marcar cuáles. Igual en Servicios y en Ofertas.
- **La regla se cumple**: la caja y la ficha del cliente solo ofrecen a quienes dan lo que se
  vende, la API rechaza el resto (`409 staff_not_assigned`) y el agente de IA sabe quién da qué
  cuando está detallado. «Otro» lo cobra cualquiera.
- **Galería del selector**: buscador por nombre bajo el encabezado, botón para borrar cada
  imagen (con confirmación; el campo del formulario se vacía al instante si era la elegida) y
  solo imágenes: el video se bloquea en la pantalla **y en el servidor** (`POST /api/medios?tipo=image`).
- **Profesionales**: el buscador de la lista está siempre visible. La previsualización (lista y
  ojo) muestra «Todos los profesionales» cuando no se detalló ninguno (sin enumerarlos) y, con
  detallados, `Profesional: Cheo` (uno) o `Profesionales: Cheo, Mari` (varios). Igual en Servicios
  y en Ofertas.
- Si se borra el medio, el servicio queda sin imagen; si se borra un profesional, sale de las listas
  (si era el único, el servicio vuelve a ser de todos). Migración `0026_imagen_y_profesionales`.
- **Actualizar**: redesplegar; la migración se aplica al arrancar.

### Medios: biblioteca de imágenes y videos

- **Medios** (`/medios`, cualquier miembro del equipo): una biblioteca al estilo de WordPress.
  Cuadrícula de archivos, filtro por tipo, búsqueda por nombre y vista ampliada (lightbox) con
  flechas del teclado. Cada archivo tiene su URL pública lista para **Copiar URL**.
- **Dos formas de agregar**: subir desde el dispositivo (también arrastrando, varios a la vez, con
  barra de avance) o **Insertar desde URL**: el servidor descarga el enlace y lo guarda.
- **Límites** (validados en el navegador y, sobre todo, en el servidor): JPG y PNG hasta 3 MB,
  WEBP y AVIF hasta 1,5 MB, MP4 hasta 50 MB. El formato se decide por los bytes del archivo, no
  por su nombre ni su `Content-Type`; SVG, GIF y HTML se rechazan.
- **Enlaces externos protegidos contra SSRF**: la IP se valida al conectar (y en cada redirección),
  se rechazan direcciones internas, credenciales en la URL y puertos que no sean 80/443.
- El archivo vive en `MEDIA_DIR/<org>/medios/`, sin servicios de terceros. La URL se sirve con
  `Range` (el video se reproduce en Safari), `nosniff` y una CSP que no deja ejecutar nada.
  Migración `0025_modulo_medios`. Prueba: `pnpm test:e2e:medios`.
- **Actualizar**: redesplegar; la migración se aplica al arrancar.

### Panel ejecutivo y analítica (módulo SALON)

- **Panel** (`/panel`, dueño/administrador): KPIs del periodo (ingresos, ganancia neta,
  comisiones, ticket promedio, citas), rendimiento por profesional, ranking de servicios y
  ofertas, y los clientes que cumplen años este mes (con enlace para saludar por WhatsApp).
  Un selector de fechas recalcula todo.
- **Panel** concentra el análisis: tarjetas por profesional (servicios, vendido, comisión,
  neto, ticket), ranking de demanda y filtro por profesional (`?staffId=`). **Caja** queda
  para el dinero: indicadores, cuadre por método de pago y la tabla de ventas con anulación.

### Icono de la pestaña

- El icono predeterminado es `src/medios/favicon-agencia-luvo.png`. Mientras el negocio no suba
  el suyo en Ajustes → Marca, la pestaña (login incluido) lleva el de Agencia Luvo; al subirlo
  manda el suyo, y al quitarlo vuelve al de la agencia. Cambiar nombre o color no lo altera.

### Clientes del salón (módulo SALON)

- **Clientes** (`/clientes`, dueño/administrador): un contacto pasa a ser
  cliente en cuanto tiene su primera venta en Caja (no hay marca que
  mantener: se deduce de las ventas con ese contacto). Tabla con nombre,
  celular, cumpleaños, visitas, última visita y total invertido, búsqueda por
  nombre o celular, y ficha con el historial (fecha, servicio u oferta,
  profesional, monto) donde se completa o corrige el cumpleaños.
- **CRUD completo**: «Nuevo cliente», editar (nombre, celular, cumpleaños, notas) y eliminar
  (solo lo quita de Clientes; el contacto y sus ventas se conservan). Migración `0023`.
  Regla: un cliente siempre adquirió un servicio, así que «Nuevo cliente» pide servicio u
  oferta, quién atendió y método de pago, y registra esa primera venta (al precio de lista).
- **Alta de cliente afinada**: celular «999 999 999», desplegables con buscador (día y mes lado a lado),
  fecha de la atención editable (hoy por defecto) y la opción **Otro** (precio a criterio, también en Caja).
  «Otro» usa un servicio comodín por organización que no aparece en el catálogo. Migración `0024`.
- Al cobrar se piden nombre y celular (se reutiliza o crea el contacto) y,
  opcional, el cumpleaños (día y mes; migración `0022`).
- El monto cobrado queda en el precio de lista: el servidor rechaza con 400
  cualquier otro.

### Páginas en español y sin tema oscuro

- **Las URL de las páginas ahora están en español**: `/bandeja`, `/contactos`,
  `/citas`, `/agente`, `/laboratorio`, `/resultados`, `/guia-de-inicio`,
  `/ajustes` (con `/ajustes/anuncios`, `/ia`, `/marca`, `/calendario`,
  `/canales`, `/equipo` y `/plantillas`), `/iniciar-sesion` y `/registro`.
  `/pipeline` y los canales (`instagram`, `messenger`, `tiktok`, `whatsapp`) conservan su
  nombre. Las URL antiguas redirigen (308) a las nuevas, así que los enlaces
  guardados siguen funcionando. **`/api/*` no cambia**: es el contrato publicado.
- **Se eliminó el tema oscuro** y su botón. La barra lateral sigue siendo azul marino.
- **Servicios, Equipo y Caja** son páginas propias con su entrada en el menú, debajo
  de Citas (antes eran pestañas de `/negocio`). **La agenda por sillas ya no es un
  ítem aparte: es la vista principal de Citas** (`/citas`), con una pestaña «Vista
  por sillas» y otra «Calendario y bloqueos». El botón **Agendar cita** (y cada
  celda «Libre») abre un formulario con cliente, hora con cupo y profesional libre
  a esa hora; `/agenda-por-sillas` redirige a `/citas?pestana=sillas`.
- **Restablecer la contraseña con un código por correo.** En el inicio de sesión,
  «¿Olvidaste tu contraseña?» pide el correo, envía un código de 6 dígitos (vale
  10 minutos, un solo uso, 5 intentos) y con él se elige la contraseña nueva en
  `/recuperar-contrasena`. Al restablecer, se cierran las sesiones abiertas. No
  revela si un correo tiene cuenta y limita las solicitudes por correo y por IP.
  **Es opcional y apagado por defecto**: necesita `SMTP_HOST` y `SMTP_FROM` (el
  SMTP de tu propio negocio; ver `.env.example`). Sin ellas la pantalla lo
  explica y el resto del CRM funciona igual. Agrega la dependencia `nodemailer`.
- **Las cuentas se crean solo por backend.** Se eliminó la pantalla de registro
  (`/registro`) y el enlace «Crear la cuenta inicial»; `POST /api/auth/sign-up/email`
  responde 403 siempre. La primera cuenta (que crea la organización) y las
  siguientes se dan de alta con `pnpm crear-usuario` (en el contenedor,
  `node crear-usuario.mjs`); el propietario sigue creando las del equipo desde
  Ajustes → Equipo. **Antes de actualizar**: los arneses E2E que se registraban
  por la API necesitan `ALLOW_SIGNUP=true` en la instancia de prueba.
- **La moneda por defecto son soles (PEN)** y se puede cambiar en Ajustes → Marca →
  Moneda del negocio; el módulo Negocio (precios, caja, comisiones) y el agente
  usan esa misma moneda. Un negocio que ya guardó otra moneda la conserva.
- Color principal por defecto: `#0328ba`. Los campos de contraseña llevan un ojo
  para mostrarla u ocultarla.

### Módulo para barberías, salones y manicure (031)

Opcional y apagado por defecto: con `SALON=on` aparecen **Servicios, Equipo, Caja y Agenda por sillas** en el menú (debajo de Citas),
con servicios y combos de publicidad pagada, equipo con comisiones y horarios,
caja con cierres diarios y mensuales y una agenda por sillas donde varios
profesionales atienden a la vez. Sin la variable, nada cambia. La agenda por
sillas necesita además `AGENDA=on`. Detalle en
[specs/031-modulo-salon](specs/031-modulo-salon/spec.md).

#### Actualizar

1. Respalda la base y redespliega. La migración `0021` es aditiva y corre sola
   al arrancar.
2. **Cambia un índice** de `booking`: `booking_org_active_slot_uq` pasa a ser
   único por instante *y silla*. Para quien no usa sillas es exactamente lo de
   siempre (las citas sin asignar siguen chocando entre sí).
3. Para encender el módulo pon `SALON=on` y **redespliega**.

## 1.6.0 — 2026-10-14

La versión multicanal. Instagram, Messenger y ahora TikTok llegan a la misma
bandeja que WhatsApp, se conectan pegando la llave de Zernio y se vigilan desde
una sola pantalla. El agente escribe como se debe en cada red y ya no se queda
callado ante un saludo. Y llegan dos cosas que pedían los negocios con
clientes de siempre: importar contactos y marcarlos «sin agente». Con solo
WhatsApp encendido, todo funciona como antes.

### Actualizar desde 1.5.1

1. Respalda la base, como siempre.
2. Redespliega con la imagen `1.6.0` (compose: `git pull` y
   `docker compose up -d`; Coolify: cambia la etiqueta y redespliega). Las
   migraciones `0018` a `0020` son aditivas y corren solas al arrancar.
3. Si ya tenías Instagram o Messenger por Zernio, no hay que reconectar nada.
   Al arrancar, el log dice `[boot] N secreto(s) de firma de Zernio
   cifrado(s) en reposo`: es la 030 haciendo su trabajo, una sola vez.
4. Para encender canales, pon `CHANNELS` (por ejemplo
   `whatsapp,instagram,messenger,tiktok`) y **redespliega**: un reinicio no
   carga variables nuevas. Después abre Configuración → Estado.
5. Si tienes un cerebro externo por despacho: en Instagram y Messenger, entre
   las 24 horas y los 7 días, `POST /api/bot/messages` ahora responde 409
   `window_closed` a la IA; y tras eliminar una conversación llega un evento
   `conversation.deleted` a la misma URL. Mira `type` antes de buscar
   `messages`.

TikTok está probado con el simulador y aún no con un mensaje real: la cuenta
Business de prueba sigue en revisión.

### Cambios

- **Canal de TikTok** (022), opcional y apagado por defecto: con `tiktok` en
  `CHANNELS`, los mensajes directos de tu cuenta TikTok Business entran a la
  misma bandeja, con su distintivo, y los contesta el operador o el agente.
  Llega por Zernio, con tu propia cuenta; se conecta en Ajustes → TikTok.
  Vocero aplica lo que TikTok impone y lo dice claro: ventana de 48 horas sin
  forma de reabrir, hasta 10 mensajes tras el último del cliente (el undécimo
  responde 409 `message_limit`) y texto de hasta 6,000 caracteres.
  **Aún sin probar con un mensaje real de TikTok** (solo con simulador): la
  cuenta Business de prueba está en revisión.
- **Migración `0018_canal_tiktok`**: crea la tabla `tiktok_credentials`.
  Aditiva; corre sola al arrancar y queda vacía si no usas el canal.
- **Pulido de la bandeja multicanal** (028). En Instagram, Messenger y TikTok
  el compositor ya no ofrece adjuntos, ubicación ni contacto, que esos canales
  no mandan. La bandeja vacía y el filtro de un canal sin conversaciones dicen
  qué pasa («Nadie ha escrito por Instagram todavía»). Con más de un canal, el
  menú, la pestaña y la pantalla de entrada dicen «multicanal». Y al cambiar de
  conversación ya no se arrastran el borrador ni el archivo elegido: antes un
  adjunto escogido para una persona podía salir en la conversación de otra.
  Los avatares de nombres con emoji («Kevin Belier 🐏») ya no salen rotos.
- **El agente contesta los saludos** (029). Un «Hola, prueba» —lo primero que
  escribe quien estrena su agente— se quedaba sin respuesta: el agente lo tomaba
  por un mensaje de prueba y callaba. Ahora solo calla ante un cierre («ok»,
  «gracias», un emoji). Y deja de gastar un segundo llamado al modelo en cada
  turno después del primero, así que contesta antes. Sin nada que configurar.
- **Importar contactos** (027). En Contactos, «Importar»: un CSV con una
  columna de nombre y una de teléfono (con código de país). Se lee en tu
  navegador y te enseña qué va a entrar y qué se queda fuera, con su motivo,
  antes de crear nada. No duplica ni le cambia el nombre a quien ya existía, y
  no crea conversaciones ni leads. Hasta 2,000 renglones por archivo.
- **Contactos «sin agente»** (027). Una casilla al importar, y otra en «Editar»
  de cada contacto: el agente no le responde a esa persona. Sus mensajes
  llegan a la bandeja y los atiendes tú; vale para el agente incluido y para un
  cerebro por despacho. Pensado para clientes o miembros que ya son tuyos.
- **Migración `0019_contact_ai_paused`**: una columna en `contact`, con
  valor por defecto. Aditiva; corre sola al arrancar y deja a todos tus
  contactos con agente, como estaban.
- **El secreto de firma de Zernio, cifrado** (030). Instagram, Messenger y
  TikTok guardaban en claro el secreto con el que se comprueba que un webhook
  viene de Zernio; ahora va cifrado con tu `ENCRYPTION_KEY`, como el token.
  Quien leyera un respaldo de la base podía fabricar mensajes que el CRM
  aceptaba como reales. No hay que reconectar nada.
- **Migración `0020_secreto_zernio_cifrado`**: tres columnas nulas en cada
  tabla de credenciales de canal. Aditiva; corre sola al arrancar. Después,
  al arrancar la app, los secretos que ya tenías se cifran y la columna vieja
  queda vacía; el log dice cuántos (`[boot] N secreto(s) de firma de Zernio
  cifrado(s) en reposo`). La columna vieja se quita en una versión mayor: no
  saltes de una 1.5 directo a esa, pasa antes por la 1.6.
- **Eliminar una conversación** (026). En la bandeja, al fondo de Detalles:
  se borran los mensajes, sus adjuntos (también el archivo) y la ficha; el
  contacto conserva sus notas y su etapa, salvo que marques «Borrar también el
  contacto y su lead». Es irreversible y solo lo ve quien administra el
  negocio. Una cita agendada por venir lo detiene: primero se cancela.
- **El cerebro olvida lo borrado** (026). Con el despacho activo, tras eliminar
  una conversación el CRM manda un evento `conversation.deleted` a la misma
  URL y con la misma firma que un turno (un intento, sin reintentos). Si tu
  cerebro recibe despachos, mira `type` antes de buscar `messages`: un
  cuerpo con `type` no es un turno. Y trata un `conversation.id` nuevo para
  una persona que ya conocías como una conversación nueva. Detalle en
  `specs/021-despacho-estandar/contracts/despacho.md`.
- **En Instagram, Messenger y TikTok el agente ya no escribe con asteriscos**
  (024). El agente incluido y los cerebros externos marcan negritas como en
  WhatsApp; esas redes no las dibujan y el cliente veía `*así*`. Ahora el
  texto de la IA sale plano en esos canales: sin marcas, con `•` en las listas
  y los enlaces como `texto: URL`. WhatsApp no cambia, y lo que escribe una
  persona en la bandeja tampoco.
- **Ventana humana en Instagram y Messenger** (024). Pasadas 24 horas del
  último mensaje del cliente la bandeja ya no esconde el cuadro de texto ni
  pide una plantilla que esos canales no tienen: una persona puede contestar
  hasta 7 días (sale con la etiqueta de agente humano de Meta) y la bandeja
  dice cuánto queda. Pasados los 7 días lo explica en vez de dejar que Meta
  rechace el envío.
- **La IA deja de usar esa etiqueta.** Entre 24 horas y 7 días, en Instagram
  y Messenger, `POST /api/bot/messages` responde 409 `window_closed` (antes
  enviaba con la etiqueta, que Meta reserva a personas). Es lo que ya decían
  `windowOpen` y el contrato del despacho; el agente incluido pasa la
  conversación a una persona, como en WhatsApp.
- **Instagram ya tiene pantalla** (023): Configuración → Instagram. Antes el
  canal solo se podía conectar llamando a la API a mano.
- **Conectar por Zernio es pegar la llave** (023), en Instagram, Messenger y
  TikTok. Vocero encuentra la cuenta con esa llave (y si hay varias, las
  ofrece para elegir), da de alta el webhook en tu Zernio limitado a tus
  cuentas y genera el secreto de firma. Ya no se copia un `accountId` ni se
  captura un secreto. Arregla dos fallos silenciosos: guardar el id del perfil
  en vez del de la cuenta (el webhook respondía 200 y cada mensaje se
  descartaba) y tener un secreto distinto por canal (uno rechazaba todo con
  401).
- **Configuración → Estado** (023): todos los canales encendidos, si están
  conectados, cuándo entró el último mensaje y, por Zernio, cómo están la
  cuenta y el webhook, con un botón para repararlo. Aparece si tienes algún
  canal social encendido.
- La firma de Zernio vale con cualquiera de los secretos de tus canales y con
  el que Zernio tenga para el webhook de esta instancia: un secreto mal
  capturado deja de tumbar un canal.
- Conectar Instagram pasa a ser cosa del propietario, como ya lo eran
  Messenger y TikTok.
- `/api/bot/messages` gana el 409 `message_limit`. En `/api/bot/context` y en
  el despacho, la ventana (`windowOpen`, `windowRemainingMs`,
  `windowExpiresAt`) es la del canal de la conversación; para WhatsApp,
  Instagram y Messenger sigue siendo de 24 horas.

## 1.5.1 — 2026-10-13

Sale antes que la 1.6.0 por un arreglo que no espera: el agente dejaba sin
contestar el segundo mensaje cuando el cliente escribía dos veces seguidas.
Trae también lo que ya estaba en `main` camino a la 2.0.0 (el despacho al
cerebro), que no cambia nada si no tocas tus variables.

### Actualizar desde 1.5.0

Redespliega con la imagen `1.5.1` (compose: `git pull` y
`docker compose up -d`; Coolify: cambia la etiqueta y redespliega). Respalda
la base antes, como siempre. Las migraciones `0016` y `0017` son aditivas y
corren solas al arrancar.

### Cambios

- **Despacho al cerebro** (#89): con `BRAIN_DISPATCH_URL` y `BOT_API_KEY`, el
  CRM le pasa cada turno a tu cerebro externo con un `POST` firmado, en vez de
  que el cerebro reciba el webhook de Meta. Vale para WhatsApp, Instagram y
  Messenger. Mientras está activo, el agente incluido no contesta; si el
  cerebro no recibe el turno, la conversación queda con una persona. La
  tarjeta «Quién responde» y `pnpm doctor` dicen si está activo o qué falta.
  Contrato en `specs/021-despacho-estandar/contracts/despacho.md`.
- **Migración `0016_despacho_al_cerebro`**: crea la tabla `dispatch`. Aditiva;
  corre sola al arrancar y queda vacía si no usas el despacho.
- **El agente ya no deja sin contestar el segundo mensaje** (025). Si el
  cliente escribía otra vez mientras se pensaba la respuesta a lo anterior,
  ese mensaje quedaba detrás de la respuesta y se daba por atendido. Ahora
  quien lleva el turno recuerda qué mensajes debe: con el despacho, el cerebro
  recibe ese mensaje en su propio despacho; con el agente incluido, el modelo
  lo lee después de su propia respuesta y gasta un turno más, solo uno.
- **Si una persona contesta desde la bandeja dentro de la ventana de
  agrupado, el agente incluido ya no contesta encima.** Con el despacho ya era
  así. La IA de la conversación sigue encendida para el siguiente mensaje.
- **Migración `0017_dispatch_message_ids`**: una columna nula en `dispatch`.
  Aditiva; corre sola al arrancar.
- El contrato del despacho gana dos garantías: `messages` nunca llega vacío, y
  un mensaje puede ser anterior a tu última respuesta (deduplica por
  `messages[].id`, como ya pedía).
- Si ya tienes Nea delante del CRM, **no pongas `BRAIN_DISPATCH_URL` todavía**:
  Nea 1.x recibe el webhook por su cuenta y le llegaría cada mensaje dos
  veces. El despacho es para la Nea que lo reciba
  ([nea-agent#37](https://github.com/kevinrivm/nea-agent/issues/37)).

## 1.5.0 — 2026-10-08

Primera versión del plan [docs/plan-1.5-y-2.0.md](docs/plan-1.5-y-2.0.md):
todo lo de aquí se actualiza redesplegando. El agente incluido, Nea y el
contrato `/api/bot/*` no cambian; la arquitectura del agente es tema de 2.0.

### Actualizar desde 1.4.0

Redespliega con la imagen `1.5.0` (compose: `git pull` y
`docker compose up -d`; Coolify: cambia la etiqueta y redespliega). Respalda
la base antes, como siempre.

- **Migración `0015_token_de_ia`**: crea la tabla `ai_credentials`. Aditiva;
  corre sola al arrancar.
- **La IA se configura en Ajustes → IA.** Tus `OPENROUTER_*` del entorno
  siguen valiendo: son el respaldo cuando no hay nada guardado en la
  interfaz. Si pegas una llave en Ajustes, esa manda.
- **Al entrar verás la Guía de inicio** mientras falte un paso o el agente
  siga apagado. El menú funciona igual; es solo la primera pantalla.
- **Webhook de Meta**: al volver a guardar la conexión de WhatsApp, el CRM
  registra su webhook en el número por sí solo. Si usas Nea u otro cerebro
  con override en la WABA, el CRM lo detecta y no lo pisa.
- **Adjuntos**: HTML, SVG y XHTML ya no se aceptan como documento, y lo que no
  sea imagen, audio, video o PDF se descarga en vez de abrirse en el
  navegador.
- `/api/health` trae dos campos nuevos (`features`, `mediaWritable`); los de
  antes no cambian.

### Nuevo

- **Guía de inicio** (#102): primera pantalla con los pasos (agente,
  proveedor de IA, WhatsApp y, con `AGENDA=on`, agenda), pistas de lo que
  falta y el botón «Encender». Solo para dueños y administradores.
- **Ajustes → IA** (#100): proveedor (OpenRouter u otro compatible con
  OpenAI), modelo y llave cifrada, con «Probar conexión» y «Traer modelos».
  La llave se pausa sola si el proveedor responde 401 o 402 y la app lo
  avisa con un enlace para arreglarlo.
- **Webhook automático y desconectar el número** (#98): guardar la conexión
  registra el webhook en Meta; «Registrar en Meta» reintenta; «Desconectar»
  suelta el número sin tocar la bandeja.
- **Menú agrupado y Ajustes en secciones** (#104): Trabajo, Agente,
  Resultados y Ajustes; dentro de Ajustes, Canales, Agente y Negocio.
- **Plantillas explicadas** (#95): para qué sirven, ejemplos, idiomas con
  nombre, vista previa y avisos de rechazo previsible; un ejemplo realista
  por variable. **29 monedas** agrupadas en Marca.
- **`pnpm init-env` y `pnpm doctor`** (#97): el `.env` con los secretos ya
  generados, y una comprobación línea por línea del entorno, la base, el
  volumen y la conexión con Meta.
- **Manifests para Render, Fly y Railway** (#99), con botón «Deploy to
  Render».
- **`AGENTS.md`** (#94): la guía neutral del repo para cualquier asistente o
  persona; `CLAUDE.md` delega en ella.
- **Respuestas de botón** (#101): los botones de plantilla y las respuestas
  interactivas entran a la bandeja como texto, abren la ventana de 24 h y
  llegan al agente.

### Cambió

- `/api/health` dice qué banderas están encendidas y si el volumen de
  adjuntos se puede escribir (#96).
- La imagen deja fuera los snapshots de `drizzle/meta` (1.2 MB) (#96).
- Next 15.5.27 en el lockfile; `pnpm audit --prod` pasa de 33 a 21 entradas,
  todas de desarrollo o transitivas (#101).
- El interruptor del Agente solo se bloquea para encender sin IA; apagar se
  puede siempre (#100).
- El reloj de la agenda ya no se corta en pantallas chicas (#95).

### Corregido

- Adjuntos servidos con `nosniff` y `CSP sandbox`; `inline` solo para tipos
  previsualizables (#101).
- Los fixtures de pruebas usan un número ficticio (#101).

## 1.4.0 — 2026-09-30

### Actualizar desde 1.3.0

Actualizar es redesplegar: no hay variables obligatorias nuevas ni nada que
reconectar. Respalda la base antes, como en cualquier actualización.

- **Cómo.** En Coolify, con la app que construye desde el repo (la de la guía
  hasta 1.3.0), redespliega. Con docker compose, `git pull` y
  `docker compose up -d`: el compose ahora descarga la imagen publicada. Con
  `--build` la sigue construyendo desde el código, que es lo que necesitas en
  un VPS ARM (la imagen es `linux/amd64`) o si tu fork tiene cambios propios.
- **Migraciones.** Corren solas al arrancar el contenedor, sin
  Pre-Deployment Command. Hay dos nuevas, y las dos solo agregan:
  - `0013_nombre_del_contacto`: la columna `contact.name_source`.
  - `0014_anuncio_de_origen`: la columna `ad_attribution.image_asset_id`, su
    llave foránea a `media_asset` y un índice.

  Van en una sola transacción: si una falla no queda ninguna, la app no
  arranca y el log dice `[migrate] falló tras varios intentos`. Si tu fork
  tiene migraciones propias posteriores a la `0012`, comprueba después que
  existan esas dos columnas: el migrador salta en silencio toda migración
  cuyo `when` no sea mayor que el de la última aplicada. Si falta una, corre a
  mano su SQL de `drizzle/`.
- **Nombres de contacto.** El nombre ahora sigue al perfil de WhatsApp, salvo
  que lo haya escrito una persona en el CRM. La `0013` deja como «del perfil»
  todos los contactos que ya existían: uno que renombraste a mano tomará su
  nombre de WhatsApp la próxima vez que escriba. Para conservar esos nombres,
  corre esto en la consola de Postgres justo después de actualizar (antes la
  columna no existe; con docker compose,
  `docker compose exec postgres psql -U postgres -d vocero`):

  ```sql
  UPDATE "contact" SET "name_source" = 'manual';
  ```

  Con eso ningún contacto viejo sigue a su perfil; los nuevos, sí. Quien
  escriba entre el arranque y el `UPDATE` ya habrá tomado su nombre de perfil.
- **Adjuntos, logo e icono.** La imagen los guarda en `/data/media` (trae
  `MEDIA_DIR=/data/media`) y arranca como root solo para darle el volumen de
  `/data` al usuario de la app. Qué hacer según cómo esté tu contenedor:

  | Tu instancia en 1.3.0 | Qué hacer |
  |---|---|
  | `MEDIA_DIR` sin definir o `./.dev-media` (la guía y el `.env.example` de 1.3.0) | Quita `MEDIA_DIR` si la tienes y monta un volumen en `/data` si aún no hay (en Coolify, un persistent storage). No hay nada que rescatar: esa ruta no era escribible y guardar un adjunto, el logo o el icono fallaba. |
  | Volumen en `/data/media`, con `MEDIA_DIR=/data/media` (la nota del `.env.example` de 1.3.0) | No muevas el volumen: 1.4.0 usa esa misma ruta y le arregla los permisos al arrancar. `MEDIA_DIR` ya sobra. Para montarlo en `/data`, como dice la guía nueva, primero pasa su contenido a una carpeta `media/` dentro del volumen. |
  | `MEDIA_DIR=/data/media` sin volumen | Tus archivos están dentro del contenedor y el redeploy los borra. Sácalos antes de actualizar (`docker cp <contenedor>:/data/media ./media`); con el volumen ya en `/data`, devuélvelos (`docker cp ./media/. <contenedor>:/data/media`) y reinicia la app para que el contenedor les dé dueño. |
  | docker compose | Nada: el compose nuevo monta el volumen `vocero_app_data` en `/data`. El de 1.3.0 no montaba volumen para la app, así que no había archivos guardados. |

  La imagen ya no declara `USER`: `docker exec` entra como root. Para actuar
  como la app, `docker exec -u vocero …`.
- **Variables.** Ninguna obligatoria nueva.
  - `BRAIN_HEALTH_URL` (opcional): el `/health` de tu cerebro externo, p. ej.
    `http://nea:8000/health`, para la tarjeta «Quién responde a tus
    clientes». Tiene que ser una URL `http://` o `https://` completa; si no
    lo es, la tarjeta lo marca como problema de configuración y el resto de
    la app sigue funcionando ([#74]). Vacía cuenta como no definida.
  - `SOURCE_COMMIT` escrito a mano en la plataforma: si el build no trae su
    propio commit, la barra lo marca «commit sin verificar» y `/api/health`
    responde `"commitVerified":false`. Quítalo, o pásalo como build arg en
    cada build (README → Versiones). La imagen publicada ya trae el suyo.
  - Solo docker compose: `VOCERO_CRM_VERSION` elige la versión de la imagen
    (por defecto, la de esta versión). Y el compose ahora le pasa a la app
    `CHANNELS`, `AGENDA`, `ATRIBUCION`, `BOT_API_KEY` y `BRAIN_HEALTH_URL`: en
    1.3.0 no le llegaban, así que lo que tengas escrito de ellas en tu `.env`
    empieza a surtir efecto.
- **Banderas.** `AGENDA`, `ATRIBUCION` y `CHANNELS` no cambian de nombre y
  siguen apagadas por defecto. Cambia lo que cubre `ATRIBUCION`: de qué
  anuncio llegó cada conversación (titular, texto, creativo, enlace) se guarda
  y se ve siempre, con o sin la bandera. Sin ella no se guarda el `ctwa_clid`
  ni se le reporta nada a Meta.
- **Override del webhook (cerebro externo o modo agencia).** En 1.3.0, cada
  vez que guardabas la conexión en Configuración → WhatsApp (o rotabas el
  token) se re-suscribía la app sin cuerpo, que es como Meta borra el
  override de callback de la WABA. 1.4.0 ya no lo hace, pero no devuelve uno
  que ya se perdió: revisa `GET /{WABA_ID}/subscribed_apps` y, si falta
  `override_callback_uri`, vuelve a ponerlo con la URL de quien debe recibir
  los webhooks (la llamada está en README → modo agencia, paso 4).
- **Si conectas tu propio cerebro por `/api/bot/*`.**
  - Límite nuevo: primero se autentica y después se cuenta. Con la llave
    buena hay 1200 llamadas por minuto (antes 600, contadas antes de mirar la
    llave). Las fallidas, sin llave o con una mala, se frenan por IP: pasadas
    30 en un minuto responden `429 rate_limited` («Demasiados intentos
    fallidos») en vez de `401`. Si tu bot recibe ese 429, revisa su llave.
  - `GET /api/bot/availability` sin `limit`, `perDay` ni `days` ahora
    devuelve los defaults del contrato (12 huecos, 3 por día, 5 días); antes,
    un solo hueco.
  - Lo demás es aditivo (`booking` en el contexto, `date` y `query` en los
    huecos): un bot que no lee los campos nuevos no nota nada.
- **Imagen publicada.** `ghcr.io/kevinrivm/vocero-crm:1.4.0`, solo
  `linux/amd64`, con el commit horneado. Es el camino nuevo para instalar
  ([INSTALL-IA.md](INSTALL-IA.md)). Una instancia que construye desde el repo
  puede seguir así. Si la pasas a la imagen con otra app de Coolify, su
  volumen de `/data` es otro: copia los archivos antes de apagar la vieja.

### Nuevo

- **Resultados** (`/results`, en el menú, sin bandera): ventas, origen y
  anuncios, el agente y lo que se está cayendo, contra el periodo anterior.
  Todo sale de la base propia: sin gasto publicitario ni conectores, y el
  Laboratorio no cuenta. Las citas del agente, solo con `AGENDA`. Los días se
  cortan en la zona de la agenda; si no hay agenda configurada, en
  `America/Mexico_City`. ([#70])
- **De qué anuncio llegó cada conversación**, sin bandera: marca «Anuncio ·
  titular» y filtro «Anuncios» en la bandeja; tarjeta con el creativo, el
  texto y el enlace en el panel del contacto y en el cajón del trato. La
  imagen del creativo se copia al volumen (solo de hosts de Meta, hasta
  300 KB). Solo WhatsApp. ([#67])
- **Calendario de Citas** (con `AGENDA`): vistas Día, Semana, Mes y Lista en
  la zona del negocio, panel de la cita con «Abrir conversación», reprogramar
  con todos los huecos de la ventana y bloquear un horario tocando la
  rejilla. `GET /api/bookings` acepta `from` y `to` (hasta 92 días); sin
  ellos responde igual que antes. ([#66])
- **«Quién responde a tus clientes»**, arriba de la pantalla Agente: el
  agente incluido, tu cerebro externo o los dos, con aviso rojo porque el
  cliente recibiría dos respuestas. `GET /api/agent/brain-status`. ([#69])
- Para tu bot, con `AGENDA`: `GET /api/bot/context` trae las citas del lead
  (`booking`), y `GET /api/bot/availability` con `date=AAAA-MM-DD` da las
  horas libres de ese día, con `query` diciendo hasta dónde llega lo
  consultado. ([#65], [#71])
- El logo que subes se ve en la barra lateral, en el login y en la vista
  previa de Configuración → Marca. ([#64])
- La imagen de Docker se construye en cada PR y se publica en GHCR con cada
  tag. ([#68])
- `/api/health` dice si el commit salió del build (`commitVerified`). ([#65])

### Cambió

- La barra lateral es azul marino en los dos temas, y el tema oscuro sube la
  página un escalón sobre ella: diálogos y cajones flotan, su texto pasa AA de
  contraste y el foco por teclado se ve. Con un acento propio claro (verde,
  amarillo…), la tinta de botones y distintivos pasa de blanco a casi negro
  cuando el blanco no llega a 4.5:1. ([#64], [#72])
- El Agente y «IA en esta conversación» usan el mismo interruptor, con el
  pomo dentro de la pista. ([#64])
- El nombre del contacto sigue a su perfil de WhatsApp, salvo que lo haya
  escrito una persona. ([#56])
- `/api/bot/*` autentica antes de contar: 1200 llamadas por minuto con llave
  válida y 30 fallidas por minuto por IP. ([#73])
- `ATRIBUCION` ya no decide si ves el anuncio de origen: solo el `ctwa_clid`,
  la Conversions API y Configuración → Anuncios. ([#67])
- La imagen trae `MEDIA_DIR=/data/media` y un entrypoint que deja `/data`
  escribible antes de bajar al usuario de la app. ([#63])
- La insignia de versión marca «commit sin verificar» cuando el commit no
  salió del build. ([#65])
- docker compose usa la imagen publicada, `--build` la construye desde el
  código, y ahora le pasa a la app `CHANNELS`, `AGENDA`, `ATRIBUCION`,
  `BOT_API_KEY` y `BRAIN_HEALTH_URL`.

### Corregido

- Cuando el patrón de respaldo detecta que el cliente pide un humano, el
  agente le avisa antes del traspaso («Claro, te comunico con una persona del
  equipo. En breve te responden.»); antes lo traspasaba sin mandarle nada.
  ([#65])
- El agente incluido reserva el horario que el cliente elige; antes no
  acertaba el instante y la conversación entraba en bucle. ([#54])
- A un contacto sin teléfono (solo BSUID) se le responde; antes Meta
  devolvía 131026. ([#57])
- Con Postgres fuera de UTC, un saliente enseñaba otra hora en el hilo que en
  la lista. Las filas escritas antes conservan su valor; en Docker nunca
  pasó. ([#58])
- En la instalación por defecto, guardar un adjunto, el logo o el icono
  fallaba por permisos. ([#63])
- Guardar la conexión de WhatsApp, o rotar el token, borraba el override de
  callback de la WABA y dejaba sin mensajes a un cerebro externo. ([#63])
- La prueba de conexión de Google Calendar daba 403 con credenciales
  correctas, y un cambio de credenciales de Google o Zoom tardaba hasta una
  hora en surtir efecto. ([#55])
- A «¿mañana en la tarde?» tu bot solo veía las primeras horas del día:
  `/api/bot/availability` ignoraba `date`. ([#71])
- `GET /api/bot/context?waIdentity=bsuid:…` respondía 404 a quien escribió
  primero con teléfono. ([#73])
- 600 llamadas por minuto sin llave dejaban a tu bot en 429. ([#73])
- Calendario: el bloqueo tomaba la hora del navegador, reprogramar ofrecía
  solo 12 huecos, cada evento recalculaba la disponibilidad y la lista se
  quedaba en las últimas 200 citas. ([#66])
- El pomo del interruptor del Agente no se veía y, encendido, se salía de la
  pista. ([#56], [#64])

Gracias a @Diony7004, @federicorv25, @fondeur27-09-73, @dev-bahari,
@davidcaroo y @dean-wya por los reportes, los diagnósticos y el código.

## 1.3.0 y anteriores

Sin entrada aquí: lo anterior está en el tag
[`v1.3.0`](https://github.com/kevinrivm/vocero-crm/tree/v1.3.0) (2026-09-01).

[#54]: https://github.com/kevinrivm/vocero-crm/pull/54
[#55]: https://github.com/kevinrivm/vocero-crm/pull/55
[#56]: https://github.com/kevinrivm/vocero-crm/pull/56
[#57]: https://github.com/kevinrivm/vocero-crm/pull/57
[#58]: https://github.com/kevinrivm/vocero-crm/pull/58
[#63]: https://github.com/kevinrivm/vocero-crm/pull/63
[#64]: https://github.com/kevinrivm/vocero-crm/pull/64
[#65]: https://github.com/kevinrivm/vocero-crm/pull/65
[#66]: https://github.com/kevinrivm/vocero-crm/pull/66
[#67]: https://github.com/kevinrivm/vocero-crm/pull/67
[#68]: https://github.com/kevinrivm/vocero-crm/pull/68
[#69]: https://github.com/kevinrivm/vocero-crm/pull/69
[#70]: https://github.com/kevinrivm/vocero-crm/pull/70
[#71]: https://github.com/kevinrivm/vocero-crm/pull/71
[#72]: https://github.com/kevinrivm/vocero-crm/pull/72
[#73]: https://github.com/kevinrivm/vocero-crm/pull/73
[#74]: https://github.com/kevinrivm/vocero-crm/pull/74
