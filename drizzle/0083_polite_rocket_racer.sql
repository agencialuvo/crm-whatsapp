CREATE TABLE "whatsapp_media_cache" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"media_item_id" text NOT NULL,
	"phone_number_id" text NOT NULL,
	"wa_media_id" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_asset" ADD COLUMN "library_item_id" text;--> statement-breakpoint
ALTER TABLE "media_library_item" ADD COLUMN "storage" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_library_item" ADD COLUMN "storage_key" text;--> statement-breakpoint
ALTER TABLE "media_library_item" ADD COLUMN "status" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_media_cache" ADD CONSTRAINT "whatsapp_media_cache_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_media_cache" ADD CONSTRAINT "whatsapp_media_cache_media_item_id_media_library_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_library_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_media_cache_item_phone_uq" ON "whatsapp_media_cache" USING btree ("media_item_id","phone_number_id");--> statement-breakpoint
CREATE INDEX "whatsapp_media_cache_org_exp_idx" ON "whatsapp_media_cache" USING btree ("organization_id","expires_at");