CREATE TABLE "automation_edge" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"flow_id" text NOT NULL,
	"source_step_id" text NOT NULL,
	"target_step_id" text NOT NULL,
	"source_handle" text DEFAULT 'default' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_run" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"flow_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"current_step_id" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"waiting_for" text,
	"dedupe_key" text NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "automation_queue" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "automation_edge" ADD CONSTRAINT "automation_edge_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_edge" ADD CONSTRAINT "automation_edge_flow_id_automation_flow_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."automation_flow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_edge" ADD CONSTRAINT "automation_edge_source_step_id_automation_step_id_fk" FOREIGN KEY ("source_step_id") REFERENCES "public"."automation_step"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_edge" ADD CONSTRAINT "automation_edge_target_step_id_automation_step_id_fk" FOREIGN KEY ("target_step_id") REFERENCES "public"."automation_step"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_flow_id_automation_flow_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."automation_flow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_current_step_id_automation_step_id_fk" FOREIGN KEY ("current_step_id") REFERENCES "public"."automation_step"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_edge_source_handle_uq" ON "automation_edge" USING btree ("source_step_id","source_handle");--> statement-breakpoint
CREATE INDEX "automation_edge_flow_idx" ON "automation_edge" USING btree ("flow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_run_dedupe_uq" ON "automation_run" USING btree ("organization_id","flow_id","contact_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "automation_run_flow_status_idx" ON "automation_run" USING btree ("flow_id","status");--> statement-breakpoint
CREATE INDEX "automation_run_org_contact_idx" ON "automation_run" USING btree ("organization_id","contact_id");--> statement-breakpoint
ALTER TABLE "automation_queue" ADD CONSTRAINT "automation_queue_run_id_automation_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_queue_run_idx" ON "automation_queue" USING btree ("run_id");