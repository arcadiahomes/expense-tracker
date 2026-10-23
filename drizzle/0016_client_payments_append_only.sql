-- Client payments are an append-only ledger: a wrong entry is corrected with a linked
-- reversal, never edited or removed. Updates are always refused. Deletes are refused unless
-- they cascade from the invoice, site or organization going away, which runs inside the
-- foreign key's own trigger (so this one fires one level deeper).
CREATE FUNCTION client_payments_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'client payments are append-only: record a refund or reversal instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER client_payments_append_only
  BEFORE UPDATE OR DELETE ON client_payments
  FOR EACH ROW EXECUTE FUNCTION client_payments_append_only();--> statement-breakpoint
-- Invoices marked as paid before this ledger existed were paid in full: give each one a
-- payment for its total, numbered in its organization's receipt series for the payment's
-- financial year, oldest first.
INSERT INTO client_payments (organization_id, site_id, invoice_id, kind, receipt_number, amount, paid_on, method, reference, notes, client_key, created_by)
SELECT p.organization_id, p.site_id, p.id, 'payment',
       'RCT/' || p.fy || '/' || lpad((row_number() OVER (PARTITION BY p.organization_id, p.fy ORDER BY p.paid_on, p.created_at, p.id))::text, 4, '0'),
       p.total, p.paid_on, p.paid_method, p.paid_reference, 'Invoice marked as paid in full', gen_random_uuid(), coalesce(p.paid_by, p.created_by)
FROM (
  SELECT i.*, t.subtotal + round(t.subtotal * i.gst_percent / 100, 2) AS total,
         fy.start || '-' || lpad(((fy.start + 1) % 100)::text, 2, '0') AS fy
  FROM client_invoices i
  CROSS JOIN LATERAL (SELECT coalesce(sum(amount), 0) AS subtotal FROM client_invoice_items WHERE invoice_id = i.id) t
  CROSS JOIN LATERAL (SELECT CASE WHEN extract(month FROM i.paid_on) >= 4 THEN extract(year FROM i.paid_on)::int ELSE extract(year FROM i.paid_on)::int - 1 END AS start) fy
  WHERE i.paid_on IS NOT NULL AND i.cancelled_at IS NULL
) p
WHERE p.total > 0
ORDER BY p.paid_on, p.created_at, p.id;
