ALTER TABLE "booking" ADD COLUMN "calendar_event_calendar_id" text;--> statement-breakpoint
ALTER TABLE "google_credentials" ADD COLUMN "calendar_summary" text;--> statement-breakpoint
ALTER TABLE "google_credentials" ADD COLUMN "busy_calendars" jsonb;--> statement-breakpoint
ALTER TABLE "google_credentials" ADD COLUMN "granted_scopes" text;--> statement-breakpoint
-- Mejora 2: las citas que YA tienen evento en Google viven en el calendario configurado hasta hoy (uno por
-- negocio). Se anota para que, si se cambia el calendario de publicación, la sincronización sepa desde dónde
-- moverlo. Idempotente: solo toca filas sin dato.
UPDATE "booking" AS b
SET "calendar_event_calendar_id" = g."calendar_id"
FROM "google_credentials" AS g
WHERE g."organization_id" = b."organization_id"
  AND b."calendar_event_calendar_id" IS NULL
  AND (b."calendar_event_id" IS NOT NULL OR (b."connector" = 'google' AND b."external_ref" IS NOT NULL));
