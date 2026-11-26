ALTER TABLE "google_credentials" ALTER COLUMN "client_secret_cipher" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "google_credentials" ALTER COLUMN "client_secret_iv" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "google_credentials" ALTER COLUMN "client_secret_tag" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "calendar_event_id" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "calendar_sync_status" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "calendar_sync_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "calendar_sync_next_at" timestamp;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "calendar_synced_at" timestamp;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "calendar_sync_error" text;--> statement-breakpoint
ALTER TABLE "calendar_settings" ADD COLUMN "google_sync" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_settings" ADD COLUMN "google_sync_phone" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "google_credentials" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "google_credentials" ADD COLUMN "account_email" text;--> statement-breakpoint
ALTER TABLE "google_credentials" ADD COLUMN "connected_at" timestamp;--> statement-breakpoint
ALTER TABLE "google_credentials" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "google_credentials" ADD COLUMN "last_ok_at" timestamp;--> statement-breakpoint
CREATE INDEX "booking_calendar_sync_due_idx" ON "booking" USING btree ("calendar_sync_next_at") WHERE "booking"."calendar_sync_status" in ('pending', 'error') and "booking"."calendar_sync_next_at" is not null;