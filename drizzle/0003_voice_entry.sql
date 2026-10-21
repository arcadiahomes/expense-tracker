CREATE TABLE "voice_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"client_key" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"transcript" text,
	"language" text NOT NULL,
	"extractor" text NOT NULL,
	"expense_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_batches_createdBy_clientKey_unique" UNIQUE("created_by","client_key")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "voice_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "voice_batches" ADD CONSTRAINT "voice_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_batches" ADD CONSTRAINT "voice_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;