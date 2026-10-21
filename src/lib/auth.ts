import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/db";

/**
 * Whether the user may hold a session: not deactivated and a member of an organization.
 * Checked when a session is created; `loadActor` checks the same on every request, so
 * deactivation also ends sessions still held in the 5-minute cookie cache.
 */
async function mayHaveSession(userId: string) {
  const [row] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.organizationMembers, eq(schema.organizationMembers.userId, schema.users.id))
    .where(and(eq(schema.users.id, userId), isNull(schema.users.deactivatedAt)))
    .limit(1);
  return !!row;
}

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined),
  // Vercel preview deployments are reached on their own and their branch URL.
  trustedOrigins: process.env.VERCEL_ENV === "preview" ? [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL].filter(Boolean).map((h) => `https://${h}`) : [],
  database: drizzleAdapter(db, { provider: "pg", schema, usePlural: true }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    // There is no public registration: the admin creates accounts (src/server/data/accounts.ts)
    // and people set their password through a one-time link. This also refuses auth.api.signUpEmail.
    disableSignUp: true,
  },
  // Not served at all: sign-up, and Better Auth's emailed password reset (resets are admin-issued links).
  disabledPaths: ["/sign-up/email", "/request-password-reset", "/reset-password"],
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          if (!(await mayHaveSession(session.userId))) {
            throw new APIError("FORBIDDEN", { code: "ACCOUNT_INACTIVE", message: "This account is deactivated." });
          }
        },
      },
    },
  },
  user: {
    additionalFields: {
      phone: { type: "string", required: false },
      jobTitle: { type: "string", required: false },
      language: { type: "string", required: false, defaultValue: "en", input: false },
      dateFormat: { type: "string", required: false, defaultValue: "d MMM yyyy", input: false },
      numberStyle: { type: "string", required: false, defaultValue: "full", input: false },
    },
  },
  // Limits for /api/auth/* (stored in Postgres so every instance shares them). The app's
  // sign-in and password-link server actions call auth.api directly and are limited in src/server/rate-limit.ts.
  rateLimit: {
    enabled: process.env.NODE_ENV === "production" && process.env.RATE_LIMIT !== "off",
    storage: "database",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/*": { window: 15 * 60, max: 20 },
    },
  },
  session: {
    // Cache the session in a signed cookie for 5 minutes to avoid a DB hit per request.
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  // Must stay last: lets server actions set the auth cookies.
  plugins: [nextCookies()],
});

export type AuthSession = typeof auth.$Infer.Session;
