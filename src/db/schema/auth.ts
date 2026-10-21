import { bigint, boolean, index, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Better Auth tables. Property names must match Better Auth's field names
 * (emailVerified, expiresAt, ...); `casing: "snake_case"` maps them to columns.
 * Keys are plural because the adapter runs with `usePlural: true`.
 */

const timestamps = {
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const users = pgTable("users", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  // Profile and display preferences (Better Auth additionalFields).
  phone: text(),
  jobTitle: text(),
  language: text().notNull().default("en"),
  dateFormat: text().notNull().default("d MMM yyyy"),
  numberStyle: text().notNull().default("full"),
  // When the user agreed to the voice entry notice (speech goes to the browser's speech service). Null: not agreed.
  voiceConsentAt: timestamp({ withTimezone: true }),
  /** Set by the admin to block sign-in. Sessions are deleted at the same time; `loadActor` also refuses. */
  deactivatedAt: timestamp({ withTimezone: true }),
  deactivatedBy: text(),
  ...timestamps,
});

export const sessions = pgTable(
  "sessions",
  {
    id: text().primaryKey(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    token: text().notNull().unique(),
    ipAddress: text(),
    userAgent: text(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [index().on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text().primaryKey(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true }),
    scope: text(),
    password: text(),
    ...timestamps,
  },
  (t) => [index().on(t.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index().on(t.identifier)],
);

/** Better Auth's rate limiter for /api/auth/* (`rateLimit.storage: "database"`), shared by every server instance. */
export const rateLimits = pgTable("rate_limits", {
  id: text().primaryKey(),
  key: text().notNull().unique(),
  count: integer().notNull(),
  lastRequest: bigint({ mode: "number" }).notNull(),
});

/**
 * The app's own fixed-window limits (sign-in and password-link server actions, AI reads, report
 * downloads; `src/server/rate-limit.ts`). Server actions call Better Auth directly, which
 * skips its HTTP rate limiter, so they are limited here.
 */
export const requestLimits = pgTable("request_limits", {
  key: text().primaryKey(),
  count: integer().notNull(),
  windowStart: timestamp({ withTimezone: true }).notNull(),
});

export const passwordLinkPurpose = pgEnum("password_link_purpose", ["setup", "reset"]);

/**
 * One-time links for setting a password, issued by the admin (new accounts and resets) or by
 * `npm run admin:*` on the server. Only the SHA-256 of the token is stored. Issuing a new link
 * revokes the user's earlier unused ones.
 */
export const passwordLinks = pgTable(
  "password_links",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text().notNull().unique(),
    purpose: passwordLinkPurpose().notNull(),
    createdBy: text().references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId)],
);
