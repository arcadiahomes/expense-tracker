# Backup and recovery

There are two things to protect: the **Postgres database** (Neon), which holds every record, and the
**receipt bucket** (R2/S3, or a Vercel Blob store), which holds the files those records point to. Uploaded files are referenced by
`receipts.storage_key`, so restore both to roughly the same point in time.

Targets with the setup below: **RPO** (data you can lose) of a few seconds for the database and up to 24 hours
for files (R2 with a daily copy), or seconds with S3 versioning. **RTO** (time to recover) is under an hour.

## Database (Neon)

### What Neon keeps automatically

Neon keeps a change history for every branch for the project's **history retention** window
(Settings → History retention; set it as long as your plan allows). Within that window you can recover
the database as it was at any moment, to the second.

### Daily logical backup (off-Neon copy)

History retention doesn't protect against losing the Neon project or account. Keep an independent copy too.
Run this daily from a trusted machine or a scheduled CI job whose secrets are only readable by admins:

```bash
# Direct (non-pooled) connection string of the production branch.
pg_dump "$DIRECT_DATABASE_URL" --format=custom --no-owner --no-privileges \
  --file="arcadia-$(date -u +%Y%m%dT%H%MZ).dump"
```

Use a `pg_dump` with the same or a newer major version as the Neon Postgres. Encrypt the file
(e.g. `age` or `gpg`) and store it somewhere other than Neon and the receipt bucket, with object lock or
versioning. Keep 30 daily and 12 monthly copies. **The dump contains financial and personal data**: treat it
as production data, never attach it to tickets, and never load it into a preview or test branch.

### Recovering from a bad change (deleted or overwritten records)

Use this when you know roughly when it happened, e.g. a wrong import at 14:05.

1. In Neon, open the production branch → **Restore** → *Point in time*, choose a moment just before the
   mistake, and restore to a **new branch** (e.g. `restore-2026-10-21-1400`). Production keeps running.
2. Connect to the new branch and check the records you need (`psql` or `npm run db:studio` with its URL).
   `audit_log` shows who changed what and when, which helps pick the moment.
3. Choose one:
   - **Copy a few rows back.** Export the affected rows from the restore branch and insert or update them on
     production in one transaction. Then record what you did. `audit_log` is append-only, so add a row
     rather than editing history.
   - **Roll the whole database back** (everything since that moment is lost). Announce downtime, then in Neon
     restore the production branch itself to that time. Neon keeps the pre-restore state as a backup branch.
     Or point `DATABASE_URL` in Vercel at the restore branch and redeploy.
4. Delete the restore branch when finished; it holds a full copy of production data.

### Recovering from a lost project (from the daily dump)

```bash
# A new, empty Neon project/branch. Use its DIRECT connection string.
pg_restore --no-owner --no-privileges --dbname "$NEW_DIRECT_DATABASE_URL" arcadia-YYYYMMDDTHHMMZ.dump
DIRECT_DATABASE_URL="$NEW_DIRECT_DATABASE_URL" npm run db:migrate   # applies anything newer than the dump; no-op otherwise
```

Then update `DATABASE_URL` and `DIRECT_DATABASE_URL` in Vercel and redeploy. Sessions are in the database, so
signed-in users stay signed in, unless you also rotate `BETTER_AUTH_SECRET`.

### Bad migration

Migrations are additive (see [deployment.md](deployment.md)), so the usual fix is a new migration. If a
migration damaged data, restore a branch to just before it ran (above), and keep the code that expects the
old schema deployed until the data is repaired.

## Receipt files (R2/S3/Blob)

- **AWS S3:** turn on **Versioning** and a lifecycle rule that expires *noncurrent* versions after 90 days.
  A deleted or replaced file can be restored by removing its delete marker or restoring the previous version.
  Cross-region replication to a second bucket protects against losing the bucket.
- **Cloudflare R2** has no object versioning. Copy the bucket daily to a second bucket or another provider,
  e.g. with `rclone sync r2:arcadia-receipts backup:arcadia-receipts-YYYYMMDD` (or `rclone copy` into a dated
  prefix), using a read-only token for the source.
- **Vercel Blob** has no object versioning, and rclone can't read it. Copy the store daily with a small
  script that pages through `list()` from `@vercel/blob` and `get()`s each object into a second store or an
  S3/R2 bucket under the same pathname (the pathname is `receipts.storage_key`).
- The app deletes a file's object when a receipt is replaced or removed. The database row stays, soft-deleted
  with who, when and why. To bring one back, restore the object to the same key (`receipts.storage_key`) and
  clear `deleted_at` on the row.
- After a database point-in-time restore, rows may reference files deleted later. Those files are in the
  bucket's versions or backup copy under the same key.

## Secrets

Keep `BETTER_AUTH_SECRET`, the bucket keys and the database passwords in a password manager as well as in
Vercel. If one leaks: rotate the Neon role password (Roles → Reset password) and the bucket key, update Vercel,
redeploy. Rotating `BETTER_AUTH_SECRET` signs everyone out. Signed file links expire within 5 minutes anyway.

## Restore drill (quarterly)

1. Restore production to a new Neon branch at "1 hour ago". Check its schema is current:
   `DIRECT_DATABASE_URL=<restore branch, direct> npm run db:migrate` should have nothing to apply.
2. `pg_restore` the latest daily dump into a scratch database and compare counts:
   `select count(*) from expenses; select sum(total_amount) from expenses where deleted_at is null and status = 'approved';`
3. Restore one deleted receipt object from versions or backup and open it through the app.
4. Write down how long each step took. Delete the scratch branch and database.
