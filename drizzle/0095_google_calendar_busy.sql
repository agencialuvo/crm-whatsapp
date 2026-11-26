DROP INDEX "booking_org_active_slot_uq";--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "busy_source" text;--> statement-breakpoint
ALTER TABLE "calendar_settings" ADD COLUMN "google_busy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "google_credentials" ADD COLUMN "busy_status" text;--> statement-breakpoint
ALTER TABLE "google_credentials" ADD COLUMN "busy_synced_at" timestamp;--> statement-breakpoint
ALTER TABLE "google_credentials" ADD COLUMN "busy_error" text;--> statement-breakpoint
ALTER TABLE "google_credentials" ADD COLUMN "busy_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "google_credentials" ADD COLUMN "busy_next_at" timestamp;--> statement-breakpoint
ALTER TABLE "google_credentials" ADD COLUMN "busy_blocks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_org_active_slot_uq" ON "booking" USING btree ("organization_id","scheduled_at",coalesce("staff_id", '')) WHERE "booking"."status" in ('agendada','realizada') and "booking"."is_test" = false and "booking"."busy_source" is null;