ALTER TABLE "expense_item" DROP CONSTRAINT "expense_item_units_pos";--> statement-breakpoint
ALTER TABLE "expense_item" DROP CONSTRAINT "expense_item_inventory_item_id_inventory_item_id_fk";--> statement-breakpoint
ALTER TABLE "expense_item" ALTER COLUMN "quantity" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "expense_item" ALTER COLUMN "quantity" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "expense_item" DROP COLUMN "inventory_item_id";--> statement-breakpoint
ALTER TABLE "expense_item" DROP COLUMN "units_per_package";--> statement-breakpoint
ALTER TABLE "expense_item" DROP COLUMN "unit_name";--> statement-breakpoint
ALTER TABLE "inventory_adjustment" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inventory_item" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "staff_supply_delivery" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "inventory_adjustment" CASCADE;--> statement-breakpoint
DROP TABLE "staff_supply_delivery" CASCADE;--> statement-breakpoint
DROP TABLE "inventory_item" CASCADE;
