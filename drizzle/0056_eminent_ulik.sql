ALTER TABLE "combo" ALTER COLUMN "duration_minutes" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "combo" ALTER COLUMN "duration_minutes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ALTER COLUMN "duration_minutes" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "service" ALTER COLUMN "duration_minutes" DROP NOT NULL;