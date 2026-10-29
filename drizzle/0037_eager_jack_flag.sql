CREATE TABLE "inventory_adjustment" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"inventory_item_id" text NOT NULL,
	"quantity_delta" integer NOT NULL,
	"reason" text NOT NULL,
	"value_cents" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_adjustment" ADD CONSTRAINT "inventory_adjustment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustment" ADD CONSTRAINT "inventory_adjustment_inventory_item_id_inventory_item_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_adjustment_org_date_idx" ON "inventory_adjustment" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "inventory_adjustment_item_idx" ON "inventory_adjustment" USING btree ("inventory_item_id");