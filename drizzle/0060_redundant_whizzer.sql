CREATE TABLE "automation_flow" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"trigger_type" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"flow_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"step_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"scheduled_for" timestamp NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_step" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"flow_id" text NOT NULL,
	"step_type" text NOT NULL,
	"config" jsonb NOT NULL,
	"position_x" integer DEFAULT 0 NOT NULL,
	"position_y" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_flow" ADD CONSTRAINT "automation_flow_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_queue" ADD CONSTRAINT "automation_queue_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_queue" ADD CONSTRAINT "automation_queue_flow_id_automation_flow_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."automation_flow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_queue" ADD CONSTRAINT "automation_queue_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_queue" ADD CONSTRAINT "automation_queue_step_id_automation_step_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."automation_step"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_step" ADD CONSTRAINT "automation_step_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_step" ADD CONSTRAINT "automation_step_flow_id_automation_flow_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."automation_flow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_flow_org_idx" ON "automation_flow" USING btree ("organization_id","active");--> statement-breakpoint
CREATE INDEX "automation_queue_status_scheduled_idx" ON "automation_queue" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "automation_queue_org_contact_idx" ON "automation_queue" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE INDEX "automation_step_flow_idx" ON "automation_step" USING btree ("flow_id");