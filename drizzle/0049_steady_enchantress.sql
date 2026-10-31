CREATE TABLE "cash_register_shift" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"opened_by_user_id" text NOT NULL,
	"closed_by_user_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"initial_cash_cents" integer DEFAULT 0 NOT NULL,
	"final_cash_cents" integer,
	"expected_cash_cents" integer,
	"total_sales_cents" integer DEFAULT 0 NOT NULL,
	"total_commissions_cents" integer DEFAULT 0 NOT NULL,
	"total_expenses_cents" integer DEFAULT 0 NOT NULL,
	"net_profit_cents" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp DEFAULT now() NOT NULL,
	"closed_at" timestamp,
	"notes" text,
	CONSTRAINT "cash_register_shift_initial_nonneg" CHECK ("cash_register_shift"."initial_cash_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_ui_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"table_page_sizes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cash_register_shift" ADD CONSTRAINT "cash_register_shift_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_register_shift" ADD CONSTRAINT "cash_register_shift_opened_by_user_id_user_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_register_shift" ADD CONSTRAINT "cash_register_shift_closed_by_user_id_user_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_ui_preferences" ADD CONSTRAINT "user_ui_preferences_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_ui_preferences" ADD CONSTRAINT "user_ui_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_register_shift_org_status_idx" ON "cash_register_shift" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "cash_register_shift_org_date_idx" ON "cash_register_shift" USING btree ("organization_id","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_ui_preferences_org_user_uq" ON "user_ui_preferences" USING btree ("organization_id","user_id");