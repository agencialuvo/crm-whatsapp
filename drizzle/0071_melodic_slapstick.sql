ALTER TABLE "automation_flow" ADD COLUMN "editor_mode" text DEFAULT 'simple' NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_flow" ADD COLUMN "viewport" jsonb;--> statement-breakpoint
ALTER TABLE "automation_flow" ADD COLUMN "entry_step_id" text;--> statement-breakpoint
ALTER TABLE "automation_flow" ADD CONSTRAINT "automation_flow_entry_step_id_automation_step_id_fk" FOREIGN KEY ("entry_step_id") REFERENCES "public"."automation_step"("id") ON DELETE set null ON UPDATE no action;