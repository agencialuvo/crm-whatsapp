CREATE TABLE "credit_account" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"plan_balance" integer DEFAULT 0 NOT NULL,
	"topup_balance" integer DEFAULT 0 NOT NULL,
	"unlimited" boolean DEFAULT false NOT NULL,
	"cut_enabled" boolean DEFAULT false NOT NULL,
	"overdraft_limit" integer DEFAULT 0 NOT NULL,
	"plan_period_start" timestamp,
	"plan_period_end" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "credit_account_plan_nonneg" CHECK ("credit_account"."plan_balance" >= 0),
	CONSTRAINT "credit_account_overdraft_nonneg" CHECK ("credit_account"."overdraft_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_alert" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"period_start" timestamp NOT NULL,
	"threshold" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"bucket" text NOT NULL,
	"service" text,
	"amount" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"period_start" timestamp,
	"actor_user_id" text,
	"note" text,
	"meta" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "credit_ledger_amount_nonzero" CHECK ("credit_ledger"."amount" <> 0),
	CONSTRAINT "credit_ledger_kind_sign" CHECK (("credit_ledger"."kind" in ('grant', 'topup') and "credit_ledger"."amount" > 0) or ("credit_ledger"."kind" in ('expire', 'spend', 'refund') and "credit_ledger"."amount" < 0) or "credit_ledger"."kind" in ('adjustment', 'reversal'))
);
--> statement-breakpoint
CREATE TABLE "credit_pack" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"units" integer NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" text DEFAULT 'PEN' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "credit_pack_units_pos" CHECK ("credit_pack"."units" > 0),
	CONSTRAINT "credit_pack_price_nonneg" CHECK ("credit_pack"."price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_rate" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"service" text NOT NULL,
	"category" text,
	"unit_kind" text NOT NULL,
	"amount" integer NOT NULL,
	"effective_from" timestamp DEFAULT now() NOT NULL,
	"created_by_user_id" text,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "credit_rate_amount_nonneg" CHECK ("credit_rate"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_topup" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"pack_id" text,
	"units" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"mp_payment_id" text,
	"created_by_user_id" text,
	"failure_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "credit_topup_units_pos" CHECK ("credit_topup"."units" > 0)
);
--> statement-breakpoint
CREATE TABLE "credit_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"service" text NOT NULL,
	"source" text,
	"model" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"estimated" boolean DEFAULT false NOT NULL,
	"category" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"conversation_id" text,
	"ref_type" text,
	"ref_id" text,
	"charged_units" integer DEFAULT 0 NOT NULL,
	"would_cut" boolean DEFAULT false NOT NULL,
	"idempotency_key" text,
	"meta" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "credit_usage_charged_nonneg" CHECK ("credit_usage"."charged_units" >= 0)
);
--> statement-breakpoint
ALTER TABLE "credit_account" ADD CONSTRAINT "credit_account_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_alert" ADD CONSTRAINT "credit_alert_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_rate" ADD CONSTRAINT "credit_rate_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_topup" ADD CONSTRAINT "credit_topup_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_topup" ADD CONSTRAINT "credit_topup_pack_id_credit_pack_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."credit_pack"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_topup" ADD CONSTRAINT "credit_topup_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_usage" ADD CONSTRAINT "credit_usage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_account_org_uq" ON "credit_account" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_alert_org_period_threshold_uq" ON "credit_alert" USING btree ("organization_id","period_start","threshold");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_org_idem_uq" ON "credit_ledger" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "credit_ledger_org_created_idx" ON "credit_ledger" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_ledger_org_service_idx" ON "credit_ledger" USING btree ("organization_id","service","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_rate_key_from_uq" ON "credit_rate" USING btree ("key","effective_from");--> statement-breakpoint
CREATE INDEX "credit_topup_org_created_idx" ON "credit_topup" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_topup_mp_payment_uq" ON "credit_topup" USING btree ("mp_payment_id") WHERE "credit_topup"."mp_payment_id" is not null;--> statement-breakpoint
CREATE INDEX "credit_usage_org_created_idx" ON "credit_usage" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_usage_service_created_idx" ON "credit_usage" USING btree ("service","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_usage_org_idem_uq" ON "credit_usage" USING btree ("organization_id","idempotency_key") WHERE "credit_usage"."idempotency_key" is not null;