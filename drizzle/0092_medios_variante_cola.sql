ALTER TABLE "media_library_item" ADD COLUMN "variant_attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_library_item" ADD COLUMN "variant_lease_until" timestamp;--> statement-breakpoint
ALTER TABLE "media_library_item" ADD COLUMN "variant_next_attempt_at" timestamp;--> statement-breakpoint
ALTER TABLE "media_library_item" ADD CONSTRAINT "media_library_item_variant_attempts_ck" CHECK ("media_library_item"."variant_attempts" >= 0);