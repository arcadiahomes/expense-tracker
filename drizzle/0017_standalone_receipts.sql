ALTER TABLE "client_payments" ALTER COLUMN "invoice_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "client_payments" ADD COLUMN "received_from" text;--> statement-breakpoint
ALTER TABLE "client_payments" ADD CONSTRAINT "client_payments_payer" CHECK ("client_payments"."invoice_id" is not null or length(btrim("client_payments"."received_from")) > 0);