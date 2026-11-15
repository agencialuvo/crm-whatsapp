CREATE TABLE "meta_ad" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"ad_id" text NOT NULL,
	"ad_name" text,
	"adset_id" text,
	"adset_name" text,
	"campaign_id" text,
	"campaign_name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"locked_at" timestamp,
	"last_error" text,
	"synced_at" timestamp,
	"spend_synced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meta_ad_spend" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"ad_id" text NOT NULL,
	"day" date NOT NULL,
	"spend" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meta_ads_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"ad_account_id" text NOT NULL,
	"token_cipher" text NOT NULL,
	"token_iv" text NOT NULL,
	"token_tag" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_error" text,
	"account_name" text,
	"currency" text,
	"paused_until" timestamp,
	"rate_hits" integer DEFAULT 0 NOT NULL,
	"last_spend_sync_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meta_ad" ADD CONSTRAINT "meta_ad_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_ad_spend" ADD CONSTRAINT "meta_ad_spend_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_ads_settings" ADD CONSTRAINT "meta_ads_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meta_ad_org_ad_uq" ON "meta_ad" USING btree ("organization_id","ad_id");--> statement-breakpoint
CREATE INDEX "meta_ad_org_status_due_idx" ON "meta_ad" USING btree ("organization_id","status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "meta_ad_org_campaign_idx" ON "meta_ad" USING btree ("organization_id","campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meta_ad_spend_org_ad_day_uq" ON "meta_ad_spend" USING btree ("organization_id","ad_id","day");--> statement-breakpoint
CREATE INDEX "meta_ad_spend_org_day_idx" ON "meta_ad_spend" USING btree ("organization_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "meta_ads_settings_org_uq" ON "meta_ads_settings" USING btree ("organization_id");