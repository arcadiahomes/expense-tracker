CREATE TYPE "public"."client_payment_kind" AS ENUM('payment', 'refund', 'reversal');--> statement-breakpoint
CREATE TABLE "client_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "client_payments_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"kind" "client_payment_kind" NOT NULL,
	"receipt_number" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"paid_on" date NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" text,
	"notes" text,
	"related_id" uuid,
	"client_key" uuid NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_payments_seq_unique" UNIQUE("seq"),
	CONSTRAINT "client_payments_organizationId_receiptNumber_unique" UNIQUE("organization_id","receipt_number"),
	CONSTRAINT "client_payments_organizationId_clientKey_unique" UNIQUE("organization_id","client_key"),
	CONSTRAINT "client_payments_amount_positive" CHECK ("client_payments"."amount" > 0),
	CONSTRAINT "client_payments_not_credit" CHECK ("client_payments"."method" <> 'credit'),
	CONSTRAINT "client_payments_related" CHECK (("client_payments"."kind" = 'payment') = ("client_payments"."related_id" is null)),
	CONSTRAINT "client_payments_refund_has_reason" CHECK ("client_payments"."kind" = 'payment' or length(btrim("client_payments"."notes")) > 0)
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "client_invoices" ADD COLUMN "client_phone" text;--> statement-breakpoint
ALTER TABLE "client_invoices" ADD COLUMN "client_email" text;--> statement-breakpoint
ALTER TABLE "client_payments" ADD CONSTRAINT "client_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_payments" ADD CONSTRAINT "client_payments_site_id_construction_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."construction_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_payments" ADD CONSTRAINT "client_payments_invoice_id_client_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."client_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_payments" ADD CONSTRAINT "client_payments_related_id_client_payments_id_fk" FOREIGN KEY ("related_id") REFERENCES "public"."client_payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_payments" ADD CONSTRAINT "client_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_payments_invoice_id_seq_index" ON "client_payments" USING btree ("invoice_id","seq");--> statement-breakpoint
CREATE INDEX "client_payments_site_id_paid_on_index" ON "client_payments" USING btree ("site_id","paid_on");--> statement-breakpoint
CREATE INDEX "client_payments_related_id_index" ON "client_payments" USING btree ("related_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_payments_one_reversal" ON "client_payments" USING btree ("related_id") WHERE kind = 'reversal';