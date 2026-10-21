CREATE TABLE "invitation_sites" (
	"invitation_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"role" "site_role" NOT NULL,
	CONSTRAINT "invitation_sites_invitation_id_site_id_pk" PRIMARY KEY("invitation_id","site_id")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "invitation_sites" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "site_memberships" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "site_memberships" ALTER COLUMN "role" SET DEFAULT 'viewer'::text;--> statement-breakpoint
DROP TYPE "public"."site_role";--> statement-breakpoint
CREATE TYPE "public"."site_role" AS ENUM('owner', 'accountant', 'engineer', 'viewer');--> statement-breakpoint
ALTER TABLE "invitation_sites" ALTER COLUMN "role" SET DATA TYPE "public"."site_role" USING "role"::"public"."site_role";--> statement-breakpoint
ALTER TABLE "site_memberships" ALTER COLUMN "role" SET DEFAULT 'viewer'::"public"."site_role";--> statement-breakpoint
ALTER TABLE "site_memberships" ALTER COLUMN "role" SET DATA TYPE "public"."site_role" USING "role"::"public"."site_role";--> statement-breakpoint
ALTER TABLE "organization_members" ADD COLUMN "selected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invitation_sites" ADD CONSTRAINT "invitation_sites_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_sites" ADD CONSTRAINT "invitation_sites_site_id_construction_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."construction_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitation_sites_site_id_index" ON "invitation_sites" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "invitations_organization_id_index" ON "invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitations_email_index" ON "invitations" USING btree ("email");