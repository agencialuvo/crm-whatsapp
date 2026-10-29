ALTER TABLE "loyalty_settings" DROP CONSTRAINT "loyalty_stamps_pos";--> statement-breakpoint
ALTER TABLE "loyalty_settings" DROP CONSTRAINT "loyalty_settings_service_id_restriction_service_id_fk";
--> statement-breakpoint
ALTER TABLE "loyalty_settings" ADD COLUMN "stamp_icon_media_id" text;--> statement-breakpoint
ALTER TABLE "loyalty_settings" ADD COLUMN "milestones" jsonb DEFAULT '[{"stamps":10,"title":"Corte de cabello gratis","rewardType":"service_free"}]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_settings" ADD CONSTRAINT "loyalty_settings_stamp_icon_media_id_media_library_item_id_fk" FOREIGN KEY ("stamp_icon_media_id") REFERENCES "public"."media_library_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Conserva el premio ya configurado: pasa a ser el único hito del arreglo.
UPDATE "loyalty_settings" SET "milestones" = jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
	'stamps', "stamps_required",
	'title', "reward_description",
	'rewardType', "reward_type",
	'discountPercentage', "discount_percentage",
	'serviceIdRestriction', "service_id_restriction"
)));--> statement-breakpoint
ALTER TABLE "loyalty_settings" DROP COLUMN "stamps_required";--> statement-breakpoint
ALTER TABLE "loyalty_settings" DROP COLUMN "reward_description";--> statement-breakpoint
ALTER TABLE "loyalty_settings" DROP COLUMN "reward_type";--> statement-breakpoint
ALTER TABLE "loyalty_settings" DROP COLUMN "discount_percentage";--> statement-breakpoint
ALTER TABLE "loyalty_settings" DROP COLUMN "service_id_restriction";