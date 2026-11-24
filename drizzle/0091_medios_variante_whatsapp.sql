ALTER TABLE "media_library_item" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "media_library_item" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "media_library_item" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "media_library_item" ADD COLUMN "variant_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_library_item" ADD COLUMN "variant_error" text;--> statement-breakpoint
ALTER TABLE "media_library_item" ADD COLUMN "variant_storage_key" text;--> statement-breakpoint
ALTER TABLE "media_library_item" ADD COLUMN "variant_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "media_library_item" ADD COLUMN "variant_mime_type" text;--> statement-breakpoint
ALTER TABLE "media_library_item" ADD COLUMN "variant_width" integer;--> statement-breakpoint
ALTER TABLE "media_library_item" ADD COLUMN "variant_height" integer;--> statement-breakpoint
ALTER TABLE "media_library_item" ADD COLUMN "variant_processed_at" timestamp;--> statement-breakpoint
CREATE INDEX "media_library_item_variant_processing_idx" ON "media_library_item" USING btree ("variant_status") WHERE "media_library_item"."variant_status" = 'processing';--> statement-breakpoint
ALTER TABLE "media_library_item" ADD CONSTRAINT "media_library_item_variant_status_ck" CHECK ("media_library_item"."variant_status" in ('none', 'processing', 'ready', 'failed'));--> statement-breakpoint
ALTER TABLE "media_library_item" ADD CONSTRAINT "media_library_item_variant_size_ck" CHECK ("media_library_item"."variant_size_bytes" is null or ("media_library_item"."variant_size_bytes" > 0 and "media_library_item"."variant_size_bytes" <= 16777216));--> statement-breakpoint
ALTER TABLE "media_library_item" ADD CONSTRAINT "media_library_item_variant_needs_ready_ck" CHECK ("media_library_item"."variant_status" = 'none' or "media_library_item"."status" = 'ready');--> statement-breakpoint
ALTER TABLE "media_library_item" ADD CONSTRAINT "media_library_item_variant_ready_ck" CHECK ("media_library_item"."variant_status" <> 'ready' or ("media_library_item"."variant_storage_key" is not null and "media_library_item"."variant_size_bytes" is not null and "media_library_item"."variant_mime_type" is not null));