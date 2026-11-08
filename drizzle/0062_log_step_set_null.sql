ALTER TABLE "automation_execution_log" DROP CONSTRAINT "automation_execution_log_step_id_automation_step_id_fk";
--> statement-breakpoint
ALTER TABLE "automation_execution_log" ALTER COLUMN "step_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_execution_log" ADD CONSTRAINT "automation_execution_log_step_id_automation_step_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."automation_step"("id") ON DELETE set null ON UPDATE no action;