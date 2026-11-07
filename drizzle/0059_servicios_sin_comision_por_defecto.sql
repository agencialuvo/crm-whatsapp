-- La comisión no tiene valor de fábrica: la define cada negocio. Hasta la migración 0057 la
-- columna valía 50 por defecto, así que todo servicio creado sin escribirla quedó con 50. Se
-- vacía ese 50 (sin porcentaje = sin comisión, ver `resolveCommissionPercentage`). Lo pactado
-- por profesional (`staff_service_commission`) y el global de cada profesional NO se tocan.
-- Se aplica una sola vez (lo registra el diario de migraciones): lo que el negocio escriba después se respeta.
UPDATE "service" SET "default_commission_percentage" = NULL WHERE "default_commission_percentage" = 50;
