CREATE TABLE "automation_execution_log" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"flow_id" text NOT NULL,
	"step_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"status" text NOT NULL,
	"metadata" jsonb,
	"executed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_execution_log" ADD CONSTRAINT "automation_execution_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_execution_log" ADD CONSTRAINT "automation_execution_log_flow_id_automation_flow_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."automation_flow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_execution_log" ADD CONSTRAINT "automation_execution_log_step_id_automation_step_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."automation_step"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_execution_log" ADD CONSTRAINT "automation_execution_log_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_log_org_contact_idx" ON "automation_execution_log" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE INDEX "automation_log_flow_step_idx" ON "automation_execution_log" USING btree ("flow_id","step_id");--> statement-breakpoint
CREATE INDEX "automation_log_executed_at_idx" ON "automation_execution_log" USING btree ("executed_at");