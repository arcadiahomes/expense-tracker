CREATE TYPE "public"."password_link_purpose" AS ENUM('setup', 'reset');--> statement-breakpoint
CREATE TABLE "password_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" "password_link_purpose" NOT NULL,
	"created_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_links_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deactivated_by" text;--> statement-breakpoint
ALTER TABLE "password_links" ADD CONSTRAINT "password_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_links" ADD CONSTRAINT "password_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "password_links_user_id_index" ON "password_links" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_members_one_owner" ON "organization_members" USING btree ("organization_id") WHERE role = 'owner';