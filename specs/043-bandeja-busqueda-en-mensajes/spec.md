# 043 — Bandeja: búsqueda también por el texto de los mensajes

**Created**: 2026-11-17

**Status**: **Implementada** (2026-11-17). Verificada contra Postgres real (`bandeja-escala-live`, prueba 9, con 60 000 mensajes) y de punta a punta (`pnpm test:e2e:bandeja-escala`). Pendiente de commit.

**Carril**: ciclo corto. Amplía la búsqueda de `GET /api/conversations?q=` (042), añade una migración de un índice y ajusta el filtrado local de deltas. Sin bandera: es el núcleo. No cambia el contrato de la API ni sus DTOs.

## Qué cambia para el operador

Escribir «tinte», «precio» o «minutos» en el buscador de la Bandeja deja las conversaciones cuyo **nombre, teléfono o cualquier mensaje** contiene esa palabra. Sin importar mayúsculas ni acentos («tínte» = «TINTE»). Una conversación aparece una sola vez aunque tenga diez mensajes que coincidan. Los chips (Todas / No leídas / Anuncios), la etapa, el canal y «cargar más» siguen funcionando junto con la búsqueda, y los contadores cuentan lo mismo que se ve.

## Diseño

- **Servidor** (`src/server/search-sql.ts`, `src/server/inbox/queries.ts`): `busquedaEnMensajes(conversation.id, q)` es un `EXISTS (select 1 from message …)` con la misma normalización que el nombre (`lower(translate(...))`, comodines de LIKE escapados). `EXISTS` y no `JOIN`/`DISTINCT`: no duplica y no rompe la paginación por cursor ni el orden. Se une al filtro de nombre/teléfono con `OR` dentro de `filtrosBase`, así lista, contadores y chips usan la misma condición y la multi-tenencia sigue (el `EXISTS` cuelga de una conversación ya acotada a la organización).
- **Mínimo de 3 caracteres** para mirar mensajes (`MIN_CONTENT_CHARS`): con 1–2 letras casi todo hilo coincide. Nombre y teléfono siguen buscando desde la primera letra.
- **Índice** (migración `0078`): GIN de trigramas (`pg_trgm`) sobre `lower(translate(text, …))`, la MISMA expresión que la consulta. Medido con 60 000 mensajes: **988 ms sin índice → 28 ms con él**. Si el alojamiento no permite crear la extensión, la migración **no falla**: avisa y la búsqueda funciona sin índice (más lenta con millones de mensajes).
- **Cliente** (`inbox-state.ts`): el cliente no tiene el texto de los mensajes, así que con una búsqueda activa una fila que YA está en la lista no se retira porque su nombre no coincida (sí se retira por etapa, canal o «No leídas»), y una fila nueva solo entra por nombre/teléfono; el resto lo trae el servidor al buscar de nuevo. El input ya era no controlado y con debounce: no pierde el foco. El placeholder dice «Buscar nombre, teléfono o mensaje…».

## Fuera de alcance

- Texto completo con raíces/sinónimos (`tsvector`): la búsqueda es por subcadena, como la de nombre.
- Buscar en el texto de plantillas aún no enviadas, notas o adjuntos (solo `message.text`).
- Resaltar la coincidencia dentro del hilo.

## Riesgos

- Crear el índice no es `CONCURRENTLY` (las migraciones corren en transacción): bloquea las escrituras de `message` mientras se construye. En una base con millones de mensajes, conviene actualizar en un momento tranquilo. El índice ocupa espacio comparable al texto indexado.
- Una búsqueda con letras y 3 o más dígitos («calle 123») también coincide por teléfono (comportamiento previo de 042, compartido con Contactos).
