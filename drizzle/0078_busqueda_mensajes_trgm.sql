-- 043: búsqueda por el TEXTO de los mensajes en la Bandeja (`like '%palabra%'`).
-- Un índice de trigramas sobre la MISMA expresión que usa la consulta (minúsculas y sin acentos, ver
-- `busquedaEnMensajes` en src/server/search-sql.ts) evita recorrer toda la tabla `message`.
-- pg_trgm viene con PostgreSQL (contrib), pero algunos alojamientos no dejan crear extensiones: en ese caso
-- NO se aborta la migración; la búsqueda funciona igual, solo que sin índice (más lenta con millones de mensajes).
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS message_text_trgm_idx ON message USING gin (
    lower(translate(text, 'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ', 'aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC')) gin_trgm_ops
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'búsqueda por mensaje sin índice de trigramas: %', SQLERRM;
END $$;
