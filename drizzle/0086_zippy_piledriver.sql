CREATE TABLE "menu_config" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"base_key" text,
	"config" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "menu_config_kind" CHECK ("menu_config"."kind" in ('active', 'template')),
	CONSTRAINT "menu_config_name" CHECK (("menu_config"."kind" = 'active' and "menu_config"."name" is null) or ("menu_config"."kind" = 'template' and char_length("menu_config"."name") between 1 and 60))
);
--> statement-breakpoint
ALTER TABLE "menu_config" ADD CONSTRAINT "menu_config_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "menu_config_org_idx" ON "menu_config" USING btree ("organization_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "menu_config_active_uq" ON "menu_config" USING btree ("organization_id") WHERE "menu_config"."kind" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "menu_config_template_name_uq" ON "menu_config" USING btree ("organization_id",lower("name")) WHERE "menu_config"."kind" = 'template';