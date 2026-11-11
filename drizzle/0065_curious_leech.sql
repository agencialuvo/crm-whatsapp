CREATE TABLE "expense_name_hidden" (
	"organization_id" text NOT NULL,
	"is_fixed" boolean NOT NULL,
	"name_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "expense_name_hidden_organization_id_is_fixed_name_key_pk" PRIMARY KEY("organization_id","is_fixed","name_key")
);
--> statement-breakpoint
ALTER TABLE "expense_item" ADD COLUMN "measure_unit" text;--> statement-breakpoint
ALTER TABLE "expense_name_hidden" ADD CONSTRAINT "expense_name_hidden_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- «Docena» deja de ser una presentación: era un paquete de 12 unidades (idempotente).
UPDATE "expense_item" SET "presentation" = 'package', "units_per_package" = 12 WHERE "presentation" = 'dozen';
