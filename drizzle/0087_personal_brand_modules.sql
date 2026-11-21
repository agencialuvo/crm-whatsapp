-- Marca personal opera con Servicios (salon), Caja (finances) y Agenda. El catálogo base (BASE_CATEGORIES) ya se
-- sembró en los entornos existentes y ON CONFLICT DO NOTHING no lo actualiza, así que se ajusta aquí.
-- Idempotente y acotada: solo toca la fila personal_brand y solo si aún tiene los módulos antiguos.
UPDATE "business_category"
SET "default_modules" = '["agenda","salon","finances"]'::jsonb
WHERE "key" = 'personal_brand'
  AND "default_modules" = '["agenda"]'::jsonb;
