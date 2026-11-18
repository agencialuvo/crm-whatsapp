CREATE TABLE "billing_checkout" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"created_by_user_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"mp_preapproval_id" text,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"payer_email" text,
	"failure_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "billing_payment" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"plan_id" text,
	"plan_name" text,
	"mp_preapproval_id" text NOT NULL,
	"mp_authorized_payment_id" text NOT NULL,
	"mp_payment_id" text,
	"status" text NOT NULL,
	"status_detail" text,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"retry_attempt" integer DEFAULT 0 NOT NULL,
	"debit_date" timestamp,
	"paid_at" timestamp,
	"applied_at" timestamp,
	"needs_review" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_webhook_event" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"topic" text NOT NULL,
	"resource_id" text NOT NULL,
	"action" text,
	"live_mode" boolean,
	"status" text DEFAULT 'received' NOT NULL,
	"organization_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "billing_provider" text;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "mp_preapproval_id" text;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "mp_payer_id" text;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "mp_status" text;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "billed_amount_cents" integer;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "billed_currency" text;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "pending_plan_id" text;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "last_payment_at" timestamp;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "next_payment_at" timestamp;--> statement-breakpoint
ALTER TABLE "subscription_event" ADD COLUMN "provider_ref" text;--> statement-breakpoint
ALTER TABLE "billing_checkout" ADD CONSTRAINT "billing_checkout_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_checkout" ADD CONSTRAINT "billing_checkout_plan_id_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_checkout" ADD CONSTRAINT "billing_checkout_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_payment" ADD CONSTRAINT "billing_payment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bck_org_created_idx" ON "billing_checkout" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bck_mp_preapproval_uq" ON "billing_checkout" USING btree ("mp_preapproval_id") WHERE "billing_checkout"."mp_preapproval_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "bpy_authorized_payment_uq" ON "billing_payment" USING btree ("mp_authorized_payment_id");--> statement-breakpoint
CREATE INDEX "bpy_org_created_idx" ON "billing_payment" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bwh_request_uq" ON "billing_webhook_event" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "bwh_status_received_idx" ON "billing_webhook_event" USING btree ("status","received_at");--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_pending_plan_id_plan_id_fk" FOREIGN KEY ("pending_plan_id") REFERENCES "public"."plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_mp_preapproval_uq" ON "subscription" USING btree ("mp_preapproval_id") WHERE "subscription"."mp_preapproval_id" is not null;