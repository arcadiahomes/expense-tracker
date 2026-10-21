CREATE TYPE "public"."expense_status" AS ENUM('draft', 'pending_approval', 'approved', 'rejected');--> statement-breakpoint
ALTER TYPE "public"."site_role" ADD VALUE 'assistant' BEFORE 'viewer';--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"site_id" uuid,
	"kind" text NOT NULL,
	"expense_id" uuid,
	"title" text NOT NULL,
	"body" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "status" "expense_status" DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "approval_note" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_site_id_construction_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."construction_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_id_organization_id_created_at_index" ON "notifications" USING btree ("user_id","organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_expense_id_index" ON "notifications" USING btree ("expense_id");--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expenses_pending_idx" ON "expenses" USING btree ("site_id","submitted_at") WHERE "expenses"."status" = 'pending_approval' and "expenses"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "expenses_creator_status_idx" ON "expenses" USING btree ("created_by","status");