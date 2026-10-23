# Deploying to Vercel and Neon

This is the production setup: the app on Vercel, Postgres on Neon, receipts in a private
S3-compatible bucket (Cloudflare R2 or AWS S3). Nothing here creates accounts or sets
variables for you. Each step says where to click or what to run.

## 1. Neon (database)

1. Create a Neon project in **AWS Asia Pacific (Singapore)** (`aws-ap-southeast-1`), or in the region
   closest to your users. Every page makes several round trips, so the app and the database must sit together.
2. Keep the default branch (`main`) as **production**. Create two more branches from it:
   - `preview` for Vercel preview deployments (safe to reset from `main`);
   - `test` for `npm test` and `npm run e2e`. **Tests drop its schema on every run.**
3. Copy each branch's connection strings (Dashboard → Connect):
   - **Pooled** (host contains `-pooler`): `DATABASE_URL` for the app.
   - **Direct** (no `-pooler`): `DIRECT_DATABASE_URL` for migrations.
   Both must end with `?sslmode=require` (Neon adds it, along with `channel_binding=require`).
4. Settings → **History retention**: set it as long as your plan allows (7 days or more) for point-in-time
   restore. See [backup-and-recovery.md](backup-and-recovery.md).
5. Optional: a separate role with only the privileges the app needs. The default `neondb_owner` works but
   can drop tables. Migrations need the owner; the app needs `select, insert, update, delete` on `public`.

## 2. Receipt storage (R2 or S3)

Vercel's file system doesn't keep files, so production must use `STORAGE_DRIVER=s3`. The server refuses to
start on Vercel without it.

**Cloudflare R2:** create a bucket (no public access, no custom domain). Under R2 → Manage API tokens,
create an *Object Read & Write* token scoped to that bucket. The endpoint is
`https://<account-id>.r2.cloudflarestorage.com` and the region is `auto`.

**AWS S3:** create a bucket with *Block all public access* on, versioning on and SSE-S3 encryption.
Create an IAM user or role with `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on `arn:aws:s3:::<bucket>/*` only.

Turn on **object versioning** (S3) or keep a scheduled copy (R2, see the backup guide) so a deleted receipt can be recovered.

## 3. Vercel (app)

1. Import the repository in Vercel (Add New → Project). The framework is detected as Next.js; `vercel.json`
   sets `npm ci`, `npm run build` and the function region `sin1` (Singapore, next to the Neon region above).
   If you chose another Neon region, change `regions` to the matching Vercel region.
2. Settings → Environment Variables. Mark every value **Sensitive**. Set **Production** and **Preview** separately:

| Variable | Production | Preview | Notes |
|---|---|---|---|
| `DATABASE_URL` | `main` branch, pooled | `preview` branch, pooled | Required. |
| `DIRECT_DATABASE_URL` | `main` branch, direct | `preview` branch, direct | Only for migrations (step 4). Not read by the app. |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` | a **different** random value | Required, 32+ chars. Changing it signs everyone out. |
| `BETTER_AUTH_URL` | `https://<your domain>` | leave unset | Production must match the browser URL exactly. Previews use `VERCEL_URL` / `VERCEL_BRANCH_URL` automatically. |
| `STORAGE_DRIVER` | `s3` | `s3` | Required on Vercel. |
| `S3_BUCKET` | production bucket | a separate preview bucket | |
| `S3_REGION` | `auto` (R2) or the AWS region | same | |
| `S3_ENDPOINT` | R2 endpoint (omit for AWS) | same | |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | bucket-scoped key | preview bucket key | |
| `SENTRY_DSN` | your Sentry project DSN | optional | Optional. Errors also go to Vercel logs either way. |
| `ANTHROPIC_API_KEY` | optional | optional | Voice reading and receipt OCR. Without it the rule-based reader is used and OCR is off. |
| `VOICE_AI`, `RECEIPT_OCR` | optional `off` | | Switch the AI features off without removing the key. |

   **Never set in production:** `DATABASE_URL_TEST`,
   `APP_TODAY`, `RATE_LIMIT=off`, `SKIP_ENV_CHECK`.

3. Settings → Domains: add your domain. Then set `BETTER_AUTH_URL` to `https://<that domain>` and redeploy.
4. **Run migrations before the first deploy**, and before every deploy that adds a file under `drizzle/`.
   From a trusted machine (not from the Vercel build, which shouldn't hold the owner credentials):

   ```bash
   DIRECT_DATABASE_URL='<main branch, direct>' npm run db:migrate
   ```

   Migrations are additive and run in order (`drizzle/meta/_journal.json`). A migration that drops or
   rewrites data must be split: ship code that works with both shapes, migrate, then remove the old shape.
5. Deploy (push to the production branch, or Deployments → Redeploy). On start, the server checks its
   configuration (`src/server/env.ts`) and refuses to run with a missing secret, a non-https auth URL
   or local file storage. The error names the variable but never prints its value.
6. Create the admin once (from the same trusted machine, with production's `DATABASE_URL` and `BETTER_AUTH_URL`):

   ```bash
   ADMIN_EMAIL=... ADMIN_NAME="..." ORGANIZATION_NAME="Arcadia Home" npm run admin:bootstrap
   ```

   Open the printed one-time link to set the admin password. Running it again does nothing once an admin
   exists. `npm run admin:reset-link` issues a new link if the admin can't sign in. There is no sign-up:
   the admin creates every other account on `/engineers`.
7. Smoke test on the production URL:
   - sign in as the admin, sign out, sign in; `/sign-up` says accounts are created by the admin;
   - create an assistant engineer, open their link in a private window, set a password, check they land on "My entries";
   - create a site, add an expense, attach a photo receipt and open it (the link should expire after 5 minutes);
   - download an Excel and a PDF report;
   - check Vercel → Logs for `"level":"error"` lines, and Sentry if configured.

## 4. Preview deployments

Previews use the `preview` Neon branch and bucket, never production data. To refresh the preview data from
production, **reset the branch from its parent** in Neon (Branches → preview → Reset from parent) only if
production contains nothing you aren't allowed to copy. Otherwise migrate it and create an admin:

```bash
DIRECT_DATABASE_URL='<preview direct>' npm run db:migrate
DATABASE_URL='<preview pooled>' npm run admin:bootstrap
```

## 5. Release checklist

```bash
npm ci
npm run lint
npm run typecheck
npm test            # against DATABASE_URL_TEST (the Neon `test` branch)
npm run build
npm run e2e         # optional: Playwright against a production build and the test branch
```

Then migrate (step 3.4) and deploy. To roll back the code, promote the previous deployment in Vercel
(Deployments → ⋯ → Promote). Migrations aren't rolled back automatically. Because they are additive, the
previous code still works against the newer schema.

## 6. Security settings this deployment relies on

- **Rate limits** (Postgres-backed, shared by all instances): sign-in per IP and per email, password links per IP,
  AI reads per user, report downloads per user, browser error reports per IP (`src/server/rate-limit.ts`),
  plus Better Auth's limits on `/api/auth/*` (`src/lib/auth.ts`). Client IPs come from `x-real-ip` /
  `x-forwarded-for`, which Vercel sets. Behind another proxy, make sure it overwrites those headers.
- **Uploads** are at most 4 MB (Vercel's request limit is 4.5 MB). Phones' larger JPEG/PNG/WebP photos are
  shrunk in the browser first. Files are checked by content and stored privately, and are served only through
  5-minute signed links.
- **Headers** (`next.config.ts`): `no-store` on every page and API response, `X-Frame-Options: DENY`,
  `frame-ancestors 'none'`, HSTS, a narrow `Permissions-Policy` (camera and microphone for this site only).
- **CSRF**: Next.js rejects server actions whose `Origin` doesn't match the host. Better Auth checks the origin
  of its own endpoints against `BETTER_AUTH_URL` (and the preview URLs).
- **Secrets** are server-only (no `NEXT_PUBLIC_` variables). `.env*` is gitignored.

## 7. Monitoring

- Every server error (pages, route handlers, server actions, proxy) and every unexpected action failure is
  logged as one JSON line with `"level":"error"`: source, path without the query string, error and stack,
  release (git SHA) and user id. Request bodies, query strings, cookies and amounts are never logged.
  Vercel → Logs (filter `level:error`), or a log drain.
- With `SENTRY_DSN` set, the same events go to Sentry (`src/server/monitoring.ts`, no SDK). Signed-in
  users' browser errors go there too, via `/api/client-errors` (rate limited).
- Suggested alerts: any new Sentry issue; Neon compute at its max for 10+ minutes; Neon storage near the plan limit.
