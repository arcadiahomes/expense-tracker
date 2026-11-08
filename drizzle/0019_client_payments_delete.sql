-- Client payments stay append-only against updates and stray deletes. A receipt can now be
-- deleted on purpose: the app's deleteClientPayment sets app.client_payment_delete for its
-- own transaction (set_config(..., true)), checks access and audits it first. Cascades from
-- the invoice, site or organization going away still run one trigger level deeper.
CREATE OR REPLACE FUNCTION client_payments_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR (pg_trigger_depth() < 2 AND coalesce(current_setting('app.client_payment_delete', true), '') <> 'on') THEN
    RAISE EXCEPTION 'client payments are append-only: record a refund or reversal instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
