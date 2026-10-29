CREATE TABLE "customer_loyalty_card" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"current_stamps" integer DEFAULT 0 NOT NULL,
	"total_stamps_earned" integer DEFAULT 0 NOT NULL,
	"total_rewards_redeemed" integer DEFAULT 0 NOT NULL,
	"wallet_pass_identifier" text,
	"last_stamped_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "customer_loyalty_card_wallet_pass_identifier_unique" UNIQUE("wallet_pass_identifier"),
	CONSTRAINT "clc_current_stamps_nonneg" CHECK ("customer_loyalty_card"."current_stamps" >= 0)
);
--> statement-breakpoint
CREATE TABLE "loyalty_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"stamps_required" integer DEFAULT 10 NOT NULL,
	"reward_description" text DEFAULT 'Corte de cabello gratis' NOT NULL,
	"reward_type" text DEFAULT 'service_free' NOT NULL,
	"discount_percentage" integer,
	"service_id_restriction" text,
	"card_title" text DEFAULT 'Tarjeta VIP' NOT NULL,
	"brand_color" text DEFAULT '#111827' NOT NULL,
	"logo_media_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_stamps_pos" CHECK ("loyalty_settings"."stamps_required" > 0)
);
--> statement-breakpoint
CREATE TABLE "loyalty_transaction" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"card_id" text NOT NULL,
	"sale_id" text,
	"type" text NOT NULL,
	"stamps_change" integer NOT NULL,
	"notes" text,
	"staff_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_loyalty_card" ADD CONSTRAINT "customer_loyalty_card_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_loyalty_card" ADD CONSTRAINT "customer_loyalty_card_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_settings" ADD CONSTRAINT "loyalty_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_settings" ADD CONSTRAINT "loyalty_settings_service_id_restriction_service_id_fk" FOREIGN KEY ("service_id_restriction") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_settings" ADD CONSTRAINT "loyalty_settings_logo_media_id_media_library_item_id_fk" FOREIGN KEY ("logo_media_id") REFERENCES "public"."media_library_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transaction" ADD CONSTRAINT "loyalty_transaction_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transaction" ADD CONSTRAINT "loyalty_transaction_card_id_customer_loyalty_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."customer_loyalty_card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transaction" ADD CONSTRAINT "loyalty_transaction_sale_id_service_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."service_sale"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transaction" ADD CONSTRAINT "loyalty_transaction_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_loyalty_card_org_contact_uq" ON "customer_loyalty_card" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE INDEX "customer_loyalty_card_org_idx" ON "customer_loyalty_card" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_settings_org_uq" ON "loyalty_settings" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "loyalty_transaction_org_card_idx" ON "loyalty_transaction" USING btree ("organization_id","card_id");--> statement-breakpoint
CREATE INDEX "loyalty_transaction_org_created_idx" ON "loyalty_transaction" USING btree ("organization_id","created_at");