CREATE TABLE "subscription_event" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"type" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"from_plan_id" text,
	"from_plan_name" text,
	"to_plan_id" text,
	"to_plan_name" text,
	"period_end_before" timestamp,
	"period_end_after" timestamp,
	"source" text NOT NULL,
	"actor_user_id" text,
	"reason" text,
	"approximate" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "super_admin_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_user_id" text,
	"actor_email" text,
	"action" text NOT NULL,
	"target_organization_id" text,
	"target_organization_name" text,
	"target_user_id" text,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"ip" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan" ADD COLUMN "trial_days" integer;--> statement-breakpoint
ALTER TABLE "plan" ADD COLUMN "currency" text DEFAULT 'PEN' NOT NULL;--> statement-breakpoint
ALTER TABLE "plan" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "trial_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "converted_at" timestamp;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "status_changed_at" timestamp;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "is_super_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_event" ADD CONSTRAINT "subscription_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_event" ADD CONSTRAINT "subscription_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "super_admin_audit" ADD CONSTRAINT "super_admin_audit_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sev_org_occurred_idx" ON "subscription_event" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "sev_type_occurred_idx" ON "subscription_event" USING btree ("type","occurred_at");--> statement-breakpoint
CREATE INDEX "saa_created_idx" ON "super_admin_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "saa_target_org_idx" ON "super_admin_audit" USING btree ("target_organization_id","created_at");--> statement-breakpoint
ALTER TABLE "plan" ADD CONSTRAINT "plan_trial_days_nonneg" CHECK ("plan"."trial_days" is null or "plan"."trial_days" >= 0);
-- 045: los planes anteriores se RETIRAN (no se borran): las organizaciones que ya los tienen conservan su
-- acceso (el guardia de módulos no mira `active`) y el panel los muestra como «Plan anterior».
UPDATE "plan" SET "active" = false WHERE "slug" IN ('basico', 'salon');--> statement-breakpoint

-- 045: cada suscripción existente nace en la historia con un `trial_started` APROXIMADO (fecha de creación).
-- Las filas aproximadas cuentan en los totales pero jamás en la conversión: hasta hoy ninguna prueba vencía
-- ni se cobraba, y contarlas inventaría pruebas que nadie vio empezar.
INSERT INTO "subscription_event" ("id", "organization_id", "type", "from_status", "to_status", "to_plan_id", "to_plan_name", "period_end_after", "source", "approximate", "occurred_at")
SELECT 'sev_mig_' || s."id", s."organization_id", 'trial_started', NULL, s."status", s."plan_id", p."name", s."current_period_end", 'system', true, s."created_at"
FROM "subscription" s JOIN "plan" p ON p."id" = s."plan_id"
ON CONFLICT ("id") DO NOTHING;
