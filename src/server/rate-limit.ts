import "server-only";
import { sql } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/db";
import { ValidationError } from "./errors";

export type Limit = { max: number; windowSec: number };

/** The limits in one place, so they're easy to review. */
export const LIMITS = {
  /** Per client IP and, separately, per email: slows password guessing from one place or against one account. */
  signInIp: { max: 30, windowSec: 15 * 60 },
  signInEmail: { max: 10, windowSec: 15 * 60 },
  /** Setting a password with a one-time link, per client IP. */
  passwordLinkIp: { max: 20, windowSec: 15 * 60 },
  /** Calls to Claude (voice reading, receipt OCR) per user: they cost money. */
  aiRead: { max: 120, windowSec: 60 * 60 },
  /** PDF/Excel/CSV builds per user: each is a few heavy queries. */
  reportDownload: { max: 60, windowSec: 10 * 60 },
  /** Browser error reports per IP. */
  clientError: { max: 30, windowSec: 60 },
} satisfies Record<string, Limit>;

export class RateLimitError extends ValidationError {
  constructor(readonly retryAfter: number) {
    super(`Too many attempts. Try again in ${retryAfter < 90 ? `${retryAfter} seconds` : `${Math.ceil(retryAfter / 60)} minutes`}.`);
    this.name = "RateLimitError";
  }
}

/**
 * Counts one request against `key` in a fixed window, atomically in Postgres so every
 * server instance shares the count. Returns whether it is allowed and, if not, how many
 * seconds until the window resets. Off in tests unless RATE_LIMIT=on.
 */
export async function hit(key: string, limit: Limit): Promise<{ allowed: boolean; retryAfter: number }> {
  if (process.env.RATE_LIMIT === "off" || (process.env.NODE_ENV === "test" && process.env.RATE_LIMIT !== "on")) return { allowed: true, retryAfter: 0 };
  const rows = (await db.execute(sql`
    insert into request_limits (key, count, window_start) values (${key}, 1, now())
    on conflict (key) do update set
      count = case when request_limits.window_start <= now() - make_interval(secs => ${limit.windowSec}) then 1 else request_limits.count + 1 end,
      window_start = case when request_limits.window_start <= now() - make_interval(secs => ${limit.windowSec}) then now() else request_limits.window_start end
    returning count, greatest(1, ceil(extract(epoch from (window_start + make_interval(secs => ${limit.windowSec}) - now()))))::int as retry_after
  `)) as unknown as { count: number; retry_after: number }[];
  // Now and then, drop windows that ended long ago so the table stays small.
  if (Math.random() < 0.01) await db.execute(sql`delete from request_limits where window_start < now() - interval '1 day'`);
  const { count, retry_after } = rows[0];
  return { allowed: count <= limit.max, retryAfter: retry_after };
}

/** Like `hit`, but throws RateLimitError (a ValidationError, so forms show its message) when over the limit. */
export async function enforce(key: string, limit: Limit) {
  const r = await hit(key, limit);
  if (!r.allowed) throw new RateLimitError(r.retryAfter);
}

/**
 * The caller's IP for rate-limit keys. On Vercel `x-real-ip` and the first `x-forwarded-for`
 * entry are set by the platform, not the client. Elsewhere, run behind a proxy that does the same.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-real-ip")?.trim() || h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
