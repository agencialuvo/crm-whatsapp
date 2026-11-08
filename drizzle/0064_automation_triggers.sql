ALTER TABLE "automation_flow" ADD COLUMN "trigger_config" jsonb;--> statement-breakpoint
ALTER TABLE "automation_queue" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_queue_dedupe_uq" ON "automation_queue" USING btree ("organization_id","flow_id","contact_id","dedupe_key");