ALTER TABLE "booking" ADD COLUMN "service_id" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "combo_id" text;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_combo_id_combo_id_fk" FOREIGN KEY ("combo_id") REFERENCES "public"."combo"("id") ON DELETE set null ON UPDATE no action;