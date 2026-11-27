CREATE TABLE "birthday_alert" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "birthday_rescue_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"auto_enabled" boolean DEFAULT false NOT NULL,
	"flow_id" text,
	"window_days" integer DEFAULT 7 NOT NULL,
	"min_gap_days" integer DEFAULT 7 NOT NULL,
	"send_hour" integer DEFAULT 10 NOT NULL,
	"benefit_text" text,
	"last_auto_run_on" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "birthday_alert" ADD CONSTRAINT "birthday_alert_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "birthday_rescue_settings" ADD CONSTRAINT "birthday_rescue_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "birthday_rescue_settings" ADD CONSTRAINT "birthday_rescue_settings_flow_id_automation_flow_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."automation_flow"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "birthday_alert_org_key_uq" ON "birthday_alert" USING btree ("organization_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "birthday_rescue_settings_org_uq" ON "birthday_rescue_settings" USING btree ("organization_id");