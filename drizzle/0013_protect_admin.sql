-- The organization owner is the one permanent admin. Refuse removing or demoting them
-- (deleting their user cascades here too) and deactivating them, whatever path the write
-- takes. Deleting the whole organization is still allowed: its row is already gone when
-- the cascade reaches the membership.
CREATE FUNCTION protect_org_owner_membership() RETURNS trigger AS $$
BEGIN
  IF OLD.role = 'owner'
     AND (TG_OP = 'DELETE' OR NEW.role <> 'owner' OR NEW.user_id <> OLD.user_id OR NEW.organization_id <> OLD.organization_id)
     AND EXISTS (SELECT 1 FROM organizations WHERE id = OLD.organization_id) THEN
    RAISE EXCEPTION 'The organization admin can''t be removed or demoted.' USING ERRCODE = 'P0001', HINT = 'protect_admin';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER organization_members_protect_owner
  BEFORE UPDATE OR DELETE ON organization_members
  FOR EACH ROW EXECUTE FUNCTION protect_org_owner_membership();--> statement-breakpoint
CREATE FUNCTION protect_org_owner_user() RETURNS trigger AS $$
BEGIN
  IF NEW.deactivated_at IS NOT NULL AND OLD.deactivated_at IS NULL
     AND EXISTS (SELECT 1 FROM organization_members WHERE user_id = NEW.id AND role = 'owner') THEN
    RAISE EXCEPTION 'The organization admin can''t be deactivated.' USING ERRCODE = 'P0001', HINT = 'protect_admin';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER users_protect_owner
  BEFORE UPDATE OF deactivated_at ON users
  FOR EACH ROW EXECUTE FUNCTION protect_org_owner_user();
