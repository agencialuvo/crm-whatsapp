CREATE TABLE "ignored_number" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"key" text NOT NULL,
	"label" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by_user_id" text,
	CONSTRAINT "ignored_number_key_nonempty" CHECK (length(trim("ignored_number"."key")) > 0),
	CONSTRAINT "ignored_number_label_len" CHECK ("ignored_number"."label" is null or length("ignored_number"."label") <= 80)
);
--> statement-breakpoint
ALTER TABLE "ignored_number" ADD CONSTRAINT "ignored_number_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ignored_number" ADD CONSTRAINT "ignored_number_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ignored_number_org_channel_key_uq" ON "ignored_number" USING btree ("organization_id","channel","key");