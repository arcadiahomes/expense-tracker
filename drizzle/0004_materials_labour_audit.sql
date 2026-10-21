CREATE TYPE "public"."labour_payment_kind" AS ENUM('wage', 'advance');--> statement-breakpoint
ALTER TYPE "public"."expense_source" ADD VALUE 'purchase';--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid,
	"actor_id" text,
	"actor_name" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"summary" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "material_purchase_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"amount" numeric(14, 2) GENERATED ALWAYS AS (round("material_purchase_items"."quantity" * "material_purchase_items"."unit_price", 2)) STORED NOT NULL,
	CONSTRAINT "material_purchase_items_quantity_positive" CHECK ("material_purchase_items"."quantity" > 0),
	CONSTRAINT "material_purchase_items_price_nonnegative" CHECK ("material_purchase_items"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "material_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"supplier_id" uuid,
	"purchase_date" date NOT NULL,
	"invoice_number" text,
	"delivery_ref" text,
	"payment_method" "payment_method" NOT NULL,
	"total_amount" numeric(14, 2) NOT NULL,
	"expense_id" uuid,
	"supplier_bill_id" uuid,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "material_purchases_money_link" CHECK (("material_purchases"."expense_id" is null) <> ("material_purchases"."supplier_bill_id" is null) or ("material_purchases"."voided_at" is not null and "material_purchases"."expense_id" is null)),
	CONSTRAINT "material_purchases_total_positive" CHECK ("material_purchases"."total_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "material_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"used_on" date NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"purpose" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	CONSTRAINT "material_usage_quantity_positive" CHECK ("material_usage"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"default_unit_price" numeric(14, 2),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "materials_organizationId_name_unique" UNIQUE("organization_id","name"),
	CONSTRAINT "materials_price_nonnegative" CHECK ("materials"."default_unit_price" >= 0)
);
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "labour_kind" "labour_payment_kind";--> statement-breakpoint
ALTER TABLE "labour_attendance" ADD COLUMN "work_type" text;--> statement-breakpoint
ALTER TABLE "labour_attendance" ADD COLUMN "day_rate" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_site_id_construction_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."construction_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_purchase_items" ADD CONSTRAINT "material_purchase_items_purchase_id_material_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."material_purchases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_purchase_items" ADD CONSTRAINT "material_purchase_items_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_purchases" ADD CONSTRAINT "material_purchases_site_id_construction_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."construction_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_purchases" ADD CONSTRAINT "material_purchases_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_purchases" ADD CONSTRAINT "material_purchases_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_purchases" ADD CONSTRAINT "material_purchases_supplier_bill_id_supplier_bills_id_fk" FOREIGN KEY ("supplier_bill_id") REFERENCES "public"."supplier_bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_purchases" ADD CONSTRAINT "material_purchases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_purchases" ADD CONSTRAINT "material_purchases_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_usage" ADD CONSTRAINT "material_usage_site_id_construction_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."construction_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_usage" ADD CONSTRAINT "material_usage_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_usage" ADD CONSTRAINT "material_usage_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_usage" ADD CONSTRAINT "material_usage_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "materials" ADD CONSTRAINT "materials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_organization_id_created_at_index" ON "audit_log" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_site_id_created_at_index" ON "audit_log" USING btree ("site_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_entity_type_entity_id_index" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "material_purchase_items_purchase_id_index" ON "material_purchase_items" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "material_purchase_items_material_id_index" ON "material_purchase_items" USING btree ("material_id");--> statement-breakpoint
CREATE INDEX "material_purchases_site_id_purchase_date_index" ON "material_purchases" USING btree ("site_id","purchase_date");--> statement-breakpoint
CREATE INDEX "material_purchases_supplier_id_index" ON "material_purchases" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "material_usage_site_id_material_id_index" ON "material_usage" USING btree ("site_id","material_id");