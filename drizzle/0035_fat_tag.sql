CREATE TABLE "expense_item" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"is_fixed" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"total_price_cents" integer NOT NULL,
	"notes" text,
	"expense_date" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "expense_item_qty_pos" CHECK ("expense_item"."quantity" > 0),
	CONSTRAINT "expense_item_total_price_nonneg" CHECK ("expense_item"."total_price_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "expense_item" ADD CONSTRAINT "expense_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_item_org_date_idx" ON "expense_item" USING btree ("organization_id","expense_date");