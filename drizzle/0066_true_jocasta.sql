CREATE TABLE "ad_flow" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source_id" text NOT NULL,
	"headline" text,
	"service_id" text,
	"combo_id" text,
	"prompt_rules" text,
	"active" boolean DEFAULT true NOT NULL,
	"exclusive" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ad_flow_one_target" CHECK ("ad_flow"."service_id" is null or "ad_flow"."combo_id" is null)
);
--> statement-breakpoint
ALTER TABLE "ad_flow" ADD CONSTRAINT "ad_flow_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_flow" ADD CONSTRAINT "ad_flow_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_flow" ADD CONSTRAINT "ad_flow_combo_id_combo_id_fk" FOREIGN KEY ("combo_id") REFERENCES "public"."combo"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_flow_org_source_uq" ON "ad_flow" USING btree ("organization_id","source_id");