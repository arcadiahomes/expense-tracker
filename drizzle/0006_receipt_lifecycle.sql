ALTER TABLE "receipts" ADD COLUMN "capture_source" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "page_count" integer;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "delete_reason" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "replaces_id" uuid;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "ocr" jsonb;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "ocr_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "confirmed" jsonb;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "confirmed_by" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "duplicate_of_id" uuid;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "duplicate_reason" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "duplicate_ack_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "duplicate_ack_by" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_replaces_id_receipts_id_fk" FOREIGN KEY ("replaces_id") REFERENCES "public"."receipts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_duplicate_of_id_receipts_id_fk" FOREIGN KEY ("duplicate_of_id") REFERENCES "public"."receipts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_duplicate_ack_by_users_id_fk" FOREIGN KEY ("duplicate_ack_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "receipts_sha256_index" ON "receipts" USING btree ("sha256");