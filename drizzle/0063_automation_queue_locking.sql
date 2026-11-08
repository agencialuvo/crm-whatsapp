ALTER TABLE "automation_execution_log" ADD COLUMN "queue_id" text;--> statement-breakpoint
ALTER TABLE "automation_queue" ADD COLUMN "locked_at" timestamp;--> statement-breakpoint
ALTER TABLE "automation_queue" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_queue" ADD COLUMN "max_attempts" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_execution_log" ADD CONSTRAINT "automation_execution_log_queue_id_automation_queue_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."automation_queue"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_log_queue_success_uq" ON "automation_execution_log" USING btree ("queue_id") WHERE "automation_execution_log"."status" = 'success';