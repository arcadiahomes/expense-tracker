-- Data step for the owner/accountant/engineer/viewer roles: existing site managers become owners.
-- Runs before 0002, which recreates the site_role enum from the schema.
ALTER TYPE "public"."site_role" RENAME VALUE 'manager' TO 'owner';
