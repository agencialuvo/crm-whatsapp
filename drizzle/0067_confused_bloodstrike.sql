ALTER TABLE "automation_queue" ADD COLUMN "booking_id" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "confirmed_at" timestamp;--> statement-breakpoint
ALTER TABLE "automation_queue" ADD CONSTRAINT "automation_queue_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_queue_booking_idx" ON "automation_queue" USING btree ("booking_id");