CREATE TABLE "meta_account_spend" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"day" date NOT NULL,
	"spend" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meta_ad" ADD COLUMN "effective_status" text;--> statement-breakpoint
ALTER TABLE "meta_ad" ADD COLUMN "listed_at" timestamp;--> statement-breakpoint
ALTER TABLE "meta_ads_settings" ADD COLUMN "catalog_synced_at" timestamp;--> statement-breakpoint
ALTER TABLE "meta_ads_settings" ADD COLUMN "spend_covered_since" date;--> statement-breakpoint
ALTER TABLE "meta_ads_settings" ADD COLUMN "spend_backfill_from" date;--> statement-breakpoint
ALTER TABLE "meta_ads_settings" ADD COLUMN "account_timezone" text;--> statement-breakpoint
ALTER TABLE "meta_account_spend" ADD CONSTRAINT "meta_account_spend_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meta_account_spend_org_day_uq" ON "meta_account_spend" USING btree ("organization_id","day");