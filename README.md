# Arcadia Home

Construction site expense ledger: sites, expenses with approvals, budgets, labour attendance and wages,
material purchases and stock, supplier bills and balances, voice entry (English and Malayalam), receipts,
and PDF/Excel reports.

Built with Next.js 16 (App Router, Cache Components) on Neon Postgres, using Drizzle ORM and Better Auth
(email and password). It installs as a PWA on phones.

- **Deploying:** [docs/deployment.md](docs/deployment.md) covers Vercel, Neon, R2/S3, environment variables, migrations and monitoring.
- **Backups:** [docs/backup-and-recovery.md](docs/backup-and-recovery.md) covers point-in-time restore, daily dumps, receipt files and restore drills.
- **Mobile and offline:** [docs/mobile.md](docs/mobile.md).
- **Architecture and rules for contributors:** [CLAUDE.md](CLAUDE.md).

## Local setup

1. **Neon.** Create a project and two branches: one for development and a `test` branch.
   **Tests drop and recreate the test branch's schema on every run.** `npm test` refuses to run if
   `DATABASE_URL_TEST` points at the same database as `DATABASE_URL`.
2. **Environment.** `cp .env.example .env` and fill it in (table below). Never commit `.env`.
3. **Install, migrate, seed, run** (Node 24):

```bash
npm ci
npm run db:migrate     # applies drizzle/*.sql using DIRECT_DATABASE_URL
npm run db:seed        # optional: fictional demo org: 8 users, 6 sites, ~1,800 expenses, bills, attendance
npm run dev            # http://localhost:3000
```

### Accounts: one admin, no public sign-up

There is no registration page or API. The organization owner is the one permanent admin; they create every
other account (assistant engineers) on **Assistant engineers** (`/engineers`), and each person sets their
own password through a one-time link that expires in 48 hours.

Create the admin once, from a machine that has the database credentials (there is no web page for this):

```bash
ADMIN_EMAIL=you@yourcompany.in ADMIN_NAME="Your Name" ORGANIZATION_NAME="Arcadia Home" npm run admin:bootstrap
```

It prints a one-time link; open it to set the admin password. It refuses to run again once an admin exists
(nothing is changed), so it can't be used to take over the account. If the admin forgets their password:
`npm run admin:reset-link` prints a new one-time link (the old password works until the link is used).
Passwords never go in environment variables, and the link is shown only in your terminal.

To add an assistant engineer: sign in as the admin → **Assistant engineers** → **Add assistant engineer** →
full name, email, sites → **Create account**. Copy the link shown (it is shown once) and send it to them
privately. From the same page you can change their sites, send a password reset link, or deactivate them
(they're signed out at once; their entries stay).

### Demo data

The seed is entirely made up: people's names, `@arcadia.example` addresses (a reserved domain that can't
receive mail), supplier names, amounts and documents. It contains no real personal or financial data. All
demo users share the password in `SEED_DEMO_PASSWORD`:

| Sign-in | Role |
|---|---|
| `arun@arcadia.example` | org owner (owner of every site) |
| `meera@arcadia.example` | accountant on every site |
| `suresh@`, `priya@`, `neethu@`, `omkar@` | engineers on their own site |
| `rahul@arcadia.example` | assistant engineer (entries need approval) |
| `kavya@arcadia.example` | read-only viewer on one site |

Re-running the seed replaces only the demo organization. It refuses to run when `NODE_ENV` or `VERCEL_ENV`
is `production`.

## Environment variables

All are server-only (no `NEXT_PUBLIC_` variables), so none reaches the browser. In production the server
checks them at start-up and refuses to run with a missing or unsafe value (`src/server/env.ts`).

| Variable | Needed for | Notes |
|---|---|---|
| `DATABASE_URL` | the app | Neon **pooled** connection string with `sslmode=require`. Only `src/db/index.ts` reads it. |
| `DIRECT_DATABASE_URL` | `db:migrate` | Neon **direct** (non-pooled) string. Falls back to `DATABASE_URL`. |
| `DATABASE_URL_TEST` | `npm test`, `npm run e2e` | A separate branch. **Its schema is dropped on every run.** |
| `BETTER_AUTH_SECRET` | auth | 32+ random characters: `openssl rand -base64 32`. |
| `BETTER_AUTH_URL` | auth | Public origin, e.g. `http://localhost:3000`. Must match the URL in the browser. |
| `STORAGE_DRIVER` | receipts | `s3` for S3-compatible storage (required on Vercel). Unset: local disk in `UPLOAD_DIR`. |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` | receipts | With `STORAGE_DRIVER=s3`. Private bucket. `S3_ENDPOINT` for R2/MinIO. Credentials from `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` or the runtime role. |
| `UPLOAD_DIR` | receipts (dev) | Local directory for the dev storage driver (default `.uploads`, gitignored). |
| `FILE_URL_SECRET` | receipts (dev) | Signs 5-minute local file links. Falls back to `BETTER_AUTH_SECRET`. |
| `SENTRY_DSN` | monitoring (optional) | Sends server and browser errors to Sentry. Without it, errors are still logged as JSON lines. |
| `ANTHROPIC_API_KEY` | voice, OCR (optional) | Lets Claude read voice transcripts (for users who accepted the notice) and suggest receipt details. |
| `VOICE_AI`, `VOICE_AI_MODEL` | voice (optional) | `VOICE_AI=off` uses only the rule-based reader. The model defaults to `claude-opus-5-5`. |
| `RECEIPT_OCR`, `RECEIPT_OCR_MODEL` | OCR (optional) | `RECEIPT_OCR=off` disables receipt reading. |
| `SEED_DEMO_PASSWORD` | `db:seed` | Development and preview only. The production server refuses to start with it set. |
| `RATE_LIMIT` | tests | `off` disables rate limits (set by the e2e config only). Never set it in production. |

## Scripts

```bash
npm run dev | build | start
npm run lint
npm run typecheck      # next typegen && tsc --noEmit
npm test               # vitest against DATABASE_URL_TEST: migrations, authorization, every rule and total
npm run e2e            # Playwright against a production build and the test branch
npm run db:generate    # new migration from src/db/schema/* (never hand-edit drizzle/)
npm run db:migrate
npm run db:seed
npm run db:studio
```

Tests run one file at a time against a real database, so a full run takes several minutes. Don't run two
test commands at once: they share the test schema.

## Roles

Org owners and admins are owners of every site in their organization. Everyone else has a role per site:

| | viewer | assistant | engineer | accountant | owner |
|---|---|---|---|---|---|
| See the site's totals, budgets and records | ✓ | | ✓ | ✓ | ✓ |
| Add expenses and receipts | | ✓ (needs approval) | ✓ | ✓ | ✓ |
| Attendance, material purchases and usage, labour payments | | | ✓ | ✓ | ✓ |
| Edit or delete anyone's expense | | | | ✓ | ✓ |
| Budgets, bills, payments, removing receipts | | | | ✓ | ✓ |
| Export reports (PDF, Excel, CSV), activity log | | | | ✓ | ✓ |
| Approve assistants' entries, site details, people on the site | | | | | ✓ |
| Grant site ownership, create or delete sites | | | | | org owner/admin |

Records on sites you can't see behave as "not found". On sites you can see, actions your role lacks are "forbidden".

## Security summary

- **Authorization** is checked in the data layer (`src/server/data/*`) on every read and write, never only in the UI.
- **Input** is validated with zod on the server. Money stays `numeric(14,2)` and is summed in SQL.
- **SQL** goes through Drizzle's parameterized builders and `sql` templates. No string-built queries.
- **XSS:** React escapes all output, there's no `dangerouslySetInnerHTML`, and uploaded files are served
  with `nosniff` and a sandboxing CSP. Spreadsheet exports neutralize formulas.
- **CSRF:** server actions are origin-checked by Next.js, and Better Auth checks the origin of its own endpoints.
- **Rate limits** on sign-in, password links, AI calls, report downloads and error reports, stored in Postgres.
- **Uploads:** 4 MB maximum, checked by content (PDFs with scripts refused, JPEG GPS data stripped), private
  storage, 5-minute signed links.
- **Audit:** every financial write appends to `audit_log` in the same transaction.

See [docs/deployment.md](docs/deployment.md#6-security-settings-this-deployment-relies-on) for the deployment side.
