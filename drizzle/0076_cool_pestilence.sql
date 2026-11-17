CREATE TABLE "message_status_orphan" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"wa_message_id" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_status_orphan" ADD CONSTRAINT "message_status_orphan_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_status_orphan_wa_uq" ON "message_status_orphan" USING btree ("wa_message_id");--> statement-breakpoint
CREATE INDEX "message_status_orphan_received_idx" ON "message_status_orphan" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "message_unconfirmed_idx" ON "message" USING btree ("created_at") WHERE "message"."direction" = 'out' and "message"."status" = 'pending' and "message"."wa_message_id" is null;