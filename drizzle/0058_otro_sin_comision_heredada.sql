-- «Otro» es un cobro a criterio: no tiene porcentaje propio. El servicio comodín nació cuando
-- la columna valía 50 por defecto y, al estar oculto del catálogo, nadie pudo corregirlo.
-- Re-ejecutable: solo toca el comodín.
UPDATE "service" SET "default_commission_percentage" = NULL WHERE "is_other" = true AND "default_commission_percentage" IS NOT NULL;
