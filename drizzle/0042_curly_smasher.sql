ALTER TABLE "expense_item" ADD COLUMN "units_per_package" integer;--> statement-breakpoint
ALTER TABLE "expense_item" ADD COLUMN "unit_name" text;--> statement-breakpoint
ALTER TABLE "expense_item" ADD CONSTRAINT "expense_item_units_pos" CHECK ("expense_item"."units_per_package" > 0);