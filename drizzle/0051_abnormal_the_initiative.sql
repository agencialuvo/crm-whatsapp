ALTER TABLE "loyalty_settings" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_settings" ADD COLUMN "eligible_service_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_settings" ADD COLUMN "birthday_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_settings" ADD COLUMN "birthday_percentage" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_settings" ADD COLUMN "birthday_service_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;