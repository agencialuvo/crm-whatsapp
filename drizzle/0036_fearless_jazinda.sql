CREATE TABLE "inventory_item" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"unit_name" text DEFAULT 'unidad' NOT NULL,
	"stock_quantity" integer DEFAULT 0 NOT NULL,
	"cost_per_unit_cents" integer NOT NULL,
	"min_stock_alert" integer DEFAULT 5,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_item_stock_nonneg" CHECK ("inventory_item"."stock_quantity" >= 0),
	CONSTRAINT "inventory_item_cost_nonneg" CHECK ("inventory_item"."cost_per_unit_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "staff_supply_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"inventory_item_id" text NOT NULL,
	"staff_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"total_cost_cents" integer NOT NULL,
	"notes" text,
	"delivered_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "staff_supply_qty_pos" CHECK ("staff_supply_delivery"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "inventory_item" ADD CONSTRAINT "inventory_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_supply_delivery" ADD CONSTRAINT "staff_supply_delivery_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_supply_delivery" ADD CONSTRAINT "staff_supply_delivery_inventory_item_id_inventory_item_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_supply_delivery" ADD CONSTRAINT "staff_supply_delivery_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_item_org_idx" ON "inventory_item" USING btree ("organization_id","active");--> statement-breakpoint
CREATE INDEX "staff_supply_org_date_idx" ON "staff_supply_delivery" USING btree ("organization_id","delivered_at");--> statement-breakpoint
CREATE INDEX "staff_supply_org_staff_idx" ON "staff_supply_delivery" USING btree ("organization_id","staff_id");--> statement-breakpoint
CREATE INDEX "staff_supply_item_idx" ON "staff_supply_delivery" USING btree ("inventory_item_id");