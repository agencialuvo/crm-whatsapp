ALTER TABLE "credit_topup" ADD COLUMN "gateway" text;--> statement-breakpoint
ALTER TABLE "credit_topup" ADD COLUMN "gateway_order_id" text;--> statement-breakpoint
ALTER TABLE "credit_topup" ADD COLUMN "gateway_charge_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_topup_gateway_order_uq" ON "credit_topup" USING btree ("gateway_order_id") WHERE "credit_topup"."gateway_order_id" is not null;--> statement-breakpoint
CREATE INDEX "credit_topup_gateway_charge_idx" ON "credit_topup" USING btree ("gateway_charge_id");