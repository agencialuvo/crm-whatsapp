CREATE TABLE "google_watch_channel" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"staff_id" text,
	"calendar_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"resource_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp,
	"last_error" text,
	"last_notified_at" timestamp,
	"last_message_number" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "google_watch_channel" ADD CONSTRAINT "google_watch_channel_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_watch_channel" ADD CONSTRAINT "google_watch_channel_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "google_watch_channel_channel_uq" ON "google_watch_channel" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "google_watch_channel_source_idx" ON "google_watch_channel" USING btree ("organization_id","staff_id");