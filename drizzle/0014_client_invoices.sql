CREATE TABLE "client_invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(12, 3) DEFAULT '1' NOT NULL,
	"unit" text DEFAULT 'nos' NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"amount" numeric(14, 2) GENERATED ALWAYS AS (round("client_invoice_items"."quantity" * "client_invoice_items"."unit_price", 2)) STORED NOT NULL,
	CONSTRAINT "client_invoice_items_quantity_positive" CHECK ("client_invoice_items"."quantity" > 0),
	CONSTRAINT "client_invoice_items_unit_price_nonnegative" CHECK ("client_invoice_items"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "client_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"invoice_number" text NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date NOT NULL,
	"client_name" text NOT NULL,
	"client_address" text,
	"client_gstin" text,
	"gst_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_on" date,
	"paid_method" "payment_method",
	"paid_reference" text,
	"paid_by" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	CONSTRAINT "client_invoices_organizationId_invoiceNumber_unique" UNIQUE("organization_id","invoice_number"),
	CONSTRAINT "client_invoices_due_after_invoice" CHECK ("client_invoices"."due_date" >= "client_invoices"."invoice_date"),
	CONSTRAINT "client_invoices_gst_range" CHECK ("client_invoices"."gst_percent" between 0 and 28),
	CONSTRAINT "client_invoices_paid_has_method" CHECK ("client_invoices"."paid_on" is null or "client_invoices"."paid_method" is not null),
	CONSTRAINT "client_invoices_cancel_has_reason" CHECK ("client_invoices"."cancelled_at" is null or length(btrim("client_invoices"."cancel_reason")) > 0),
	CONSTRAINT "client_invoices_paid_or_cancelled" CHECK ("client_invoices"."paid_on" is null or "client_invoices"."cancelled_at" is null)
);
--> statement-breakpoint
ALTER TABLE "client_invoice_items" ADD CONSTRAINT "client_invoice_items_invoice_id_client_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."client_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_invoices" ADD CONSTRAINT "client_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_invoices" ADD CONSTRAINT "client_invoices_site_id_construction_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."construction_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_invoices" ADD CONSTRAINT "client_invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_invoices" ADD CONSTRAINT "client_invoices_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_invoices" ADD CONSTRAINT "client_invoices_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_invoice_items_invoice_id_index" ON "client_invoice_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "client_invoices_site_id_invoice_date_index" ON "client_invoices" USING btree ("site_id","invoice_date");