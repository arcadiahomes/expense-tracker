-- Data step for expense approvals: every expense recorded before approvals existed was
-- entered directly and counted at once, so it stays approved, as if by whoever entered it
-- when they entered it. Totals don't change. Runs before 0010 adds the status checks.
UPDATE "expenses"
SET "submitted_at" = coalesce("submitted_at", "created_at"),
    "reviewed_at" = coalesce("reviewed_at", "created_at"),
    "reviewed_by" = coalesce("reviewed_by", "created_by")
WHERE "status" = 'approved';
