CREATE TYPE "public"."org_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."site_role" AS ENUM('manager', 'engineer', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."site_status" AS ENUM('active', 'on_hold', 'completed');--> statement-breakpoint
CREATE TYPE "public"."attendance_status" AS ENUM('present', 'half_day', 'absent');--> statement-breakpoint
CREATE TYPE "public"."expense_source" AS ENUM('manual', 'voice', 'bill_payment', 'import');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'upi', 'bank', 'cheque', 'credit');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"phone" text,
	"job_title" text,
	"language" text DEFAULT 'en' NOT NULL,
	"date_format" text DEFAULT 'd MMM yyyy' NOT NULL,
	"number_style" text DEFAULT 'full' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "construction_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"location" text NOT NULL,
	"client_name" text,
	"status" "site_status" DEFAULT 'active' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "construction_sites_organizationId_name_unique" UNIQUE("organization_id","name")
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"organization_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "org_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_members_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "site_memberships" (
	"site_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "site_role" DEFAULT 'viewer' NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_memberships_site_id_user_id_pk" PRIMARY KEY("site_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "expense_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "expense_categories_organizationId_code_unique" UNIQUE("organization_id","code")
);
--> statement-breakpoint
CREATE TABLE "expense_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expense_id" uuid NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(12, 3) DEFAULT '1' NOT NULL,
	"unit" text DEFAULT 'nos' NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"amount" numeric(14, 2) GENERATED ALWAYS AS (round("expense_items"."quantity" * "expense_items"."unit_price", 2)) STORED NOT NULL,
	CONSTRAINT "expense_items_quantity_positive" CHECK ("expense_items"."quantity" > 0),
	CONSTRAINT "expense_items_unit_price_nonnegative" CHECK ("expense_items"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"expense_date" date NOT NULL,
	"description" text NOT NULL,
	"total_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"payment_method" "payment_method" DEFAULT 'cash' NOT NULL,
	"source" "expense_source" DEFAULT 'manual' NOT NULL,
	"supplier_id" uuid,
	"labour_worker_id" uuid,
	"supplier_bill_id" uuid,
	"voice_transcript" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "expenses_total_nonnegative" CHECK ("expenses"."total_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "labour_attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"status" "attendance_status" DEFAULT 'present' NOT NULL,
	"hours" numeric(4, 1),
	"wage_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"expense_id" uuid,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "labour_attendance_siteId_workerId_workDate_unique" UNIQUE("site_id","worker_id","work_date")
);
--> statement-breakpoint
CREATE TABLE "labour_workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"trade" text,
	"phone" text,
	"daily_wage" numeric(14, 2),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "labour_workers_organizationId_name_unique" UNIQUE("organization_id","name")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"supplier_bill_id" uuid,
	"expense_id" uuid,
	"amount" numeric(14, 2) NOT NULL,
	"paid_on" date NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"expense_id" uuid,
	"supplier_bill_id" uuid,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_storageKey_unique" UNIQUE("storage_key"),
	CONSTRAINT "receipts_has_parent" CHECK ("receipts"."expense_id" is not null or "receipts"."supplier_bill_id" is not null),
	CONSTRAINT "receipts_size_positive" CHECK ("receipts"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "site_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"category_id" uuid,
	"amount" numeric(14, 2) NOT NULL,
	"note" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_budgets_siteId_categoryId_unique" UNIQUE NULLS NOT DISTINCT("site_id","category_id"),
	CONSTRAINT "site_budgets_amount_nonnegative" CHECK ("site_budgets"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "supplier_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"bill_number" text NOT NULL,
	"bill_date" date NOT NULL,
	"due_date" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"description" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_bills_supplierId_billNumber_unique" UNIQUE("supplier_id","bill_number"),
	CONSTRAINT "supplier_bills_amount_positive" CHECK ("supplier_bills"."amount" > 0),
	CONSTRAINT "supplier_bills_due_after_bill" CHECK ("supplier_bills"."due_date" >= "supplier_bills"."bill_date")
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"gstin" text,
	"phone" text,
	"address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_organizationId_name_unique" UNIQUE("organization_id","name")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_sites" ADD CONSTRAINT "construction_sites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_sites" ADD CONSTRAINT "construction_sites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_memberships" ADD CONSTRAINT "site_memberships_site_id_construction_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."construction_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_memberships" ADD CONSTRAINT "site_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_memberships" ADD CONSTRAINT "site_memberships_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_items" ADD CONSTRAINT "expense_items_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_site_id_construction_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."construction_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_labour_worker_id_labour_workers_id_fk" FOREIGN KEY ("labour_worker_id") REFERENCES "public"."labour_workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_supplier_bill_id_supplier_bills_id_fk" FOREIGN KEY ("supplier_bill_id") REFERENCES "public"."supplier_bills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labour_attendance" ADD CONSTRAINT "labour_attendance_site_id_construction_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."construction_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labour_attendance" ADD CONSTRAINT "labour_attendance_worker_id_labour_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."labour_workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labour_attendance" ADD CONSTRAINT "labour_attendance_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labour_attendance" ADD CONSTRAINT "labour_attendance_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labour_workers" ADD CONSTRAINT "labour_workers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_site_id_construction_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."construction_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_supplier_bill_id_supplier_bills_id_fk" FOREIGN KEY ("supplier_bill_id") REFERENCES "public"."supplier_bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_site_id_construction_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."construction_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_supplier_bill_id_supplier_bills_id_fk" FOREIGN KEY ("supplier_bill_id") REFERENCES "public"."supplier_bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_budgets" ADD CONSTRAINT "site_budgets_site_id_construction_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."construction_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_budgets" ADD CONSTRAINT "site_budgets_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_budgets" ADD CONSTRAINT "site_budgets_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_site_id_construction_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."construction_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_index" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_index" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_index" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "construction_sites_organization_id_status_index" ON "construction_sites" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "organization_members_user_id_index" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "site_memberships_user_id_index" ON "site_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "expense_items_expense_id_index" ON "expense_items" USING btree ("expense_id");--> statement-breakpoint
CREATE INDEX "expenses_site_date_idx" ON "expenses" USING btree ("site_id","expense_date" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "expenses_site_id_category_id_expense_date_index" ON "expenses" USING btree ("site_id","category_id","expense_date");--> statement-breakpoint
CREATE INDEX "expenses_supplier_id_index" ON "expenses" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "expenses_labour_worker_id_index" ON "expenses" USING btree ("labour_worker_id");--> statement-breakpoint
CREATE INDEX "expenses_created_by_index" ON "expenses" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "labour_attendance_site_id_work_date_index" ON "labour_attendance" USING btree ("site_id","work_date");--> statement-breakpoint
CREATE INDEX "payments_supplier_bill_id_index" ON "payments" USING btree ("supplier_bill_id");--> statement-breakpoint
CREATE INDEX "payments_site_id_paid_on_index" ON "payments" USING btree ("site_id","paid_on");--> statement-breakpoint
CREATE INDEX "receipts_expense_id_index" ON "receipts" USING btree ("expense_id");--> statement-breakpoint
CREATE INDEX "receipts_supplier_bill_id_index" ON "receipts" USING btree ("supplier_bill_id");--> statement-breakpoint
CREATE INDEX "receipts_site_id_index" ON "receipts" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "supplier_bills_site_id_due_date_index" ON "supplier_bills" USING btree ("site_id","due_date");