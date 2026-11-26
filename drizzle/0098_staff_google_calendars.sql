CREATE TABLE "staff_calendar_invite" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"staff_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_by_user_id" text,
	"used_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_google_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"staff_id" text NOT NULL,
	"refresh_token_cipher" text NOT NULL,
	"refresh_token_iv" text NOT NULL,
	"refresh_token_tag" text NOT NULL,
	"account_email" text,
	"granted_scopes" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"connected_at" timestamp,
	"last_error" text,
	"last_ok_at" timestamp,
	"busy_status" text,
	"busy_synced_at" timestamp,
	"busy_error" text,
	"busy_attempts" integer DEFAULT 0 NOT NULL,
	"busy_next_at" timestamp,
	"busy_blocks" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff_calendar_invite" ADD CONSTRAINT "staff_calendar_invite_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_calendar_invite" ADD CONSTRAINT "staff_calendar_invite_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_calendar_invite" ADD CONSTRAINT "staff_calendar_invite_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_google_connection" ADD CONSTRAINT "staff_google_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_google_connection" ADD CONSTRAINT "staff_google_connection_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_calendar_invite_token_uq" ON "staff_calendar_invite" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "staff_calendar_invite_staff_idx" ON "staff_calendar_invite" USING btree ("organization_id","staff_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_google_connection_staff_uq" ON "staff_google_connection" USING btree ("organization_id","staff_id");