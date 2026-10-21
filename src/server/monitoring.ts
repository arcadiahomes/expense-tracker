import "server-only";
import { randomUUID } from "node:crypto";

/**
 * Error reporting without an SDK. Every report is one JSON line on stderr (Vercel keeps
 * these in its logs and log drains). With SENTRY_DSN set, it is also sent to Sentry's
 * envelope API. Reports carry the error, route and request id only: never request bodies,
 * cookies, query strings or amounts, so no financial or personal data leaves the app.
 */

export type ErrorContext = {
  /** Where it happened: "action", "route", "render", "client", or a module tag like "voice". */
  source: string;
  /** Path without the query string. */
  path?: string;
  method?: string;
  digest?: string;
  userId?: string;
  extra?: Record<string, string | number | boolean | undefined>;
};

const scrubPath = (p?: string) => p?.split("?")[0].slice(0, 200);

function describe(err: unknown) {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { type: err.name, message: err.message.slice(0, 1000), stack: err.stack?.slice(0, 8000), code: typeof code === "string" ? code : undefined };
  }
  return { type: "NonError", message: String(err).slice(0, 1000), stack: undefined, code: undefined };
}

export async function reportError(err: unknown, ctx: ErrorContext) {
  const e = describe(err);
  const event = {
    level: "error",
    time: new Date().toISOString(),
    env: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    release: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12),
    ...ctx,
    path: scrubPath(ctx.path),
    error: e,
  };
  console.error(JSON.stringify(event));
  if (process.env.SENTRY_DSN) {
    try {
      await sendToSentry(process.env.SENTRY_DSN, event, e);
    } catch {
      // Monitoring must never break the request it reports on.
    }
  }
}

async function sendToSentry(dsn: string, event: Record<string, unknown> & ErrorContext, e: ReturnType<typeof describe>) {
  const url = new URL(dsn);
  const projectId = url.pathname.replace(/^\//, "");
  const endpoint = `${url.protocol}//${url.host}/api/${projectId}/envelope/`;
  const eventId = randomUUID().replace(/-/g, "");
  const payload = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: "node",
    level: "error",
    environment: event.env,
    release: event.release,
    transaction: event.path,
    tags: { source: event.source, method: event.method, digest: event.digest, code: e.code },
    user: event.userId ? { id: event.userId } : undefined,
    exception: { values: [{ type: e.type, value: e.message, stacktrace: e.stack ? { frames: frames(e.stack) } : undefined }] },
    extra: event.extra,
  };
  const body = [JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn }), JSON.stringify({ type: "event" }), JSON.stringify(payload)].join("\n");
  await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-sentry-envelope",
      "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=arcadia-home/1.0, sentry_key=${url.username}`,
    },
    body,
    signal: AbortSignal.timeout(3000),
  });
}

/** V8 stack lines → Sentry frames (oldest first, as Sentry expects). */
function frames(stack: string) {
  return stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim().match(/^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ function: m[1] ?? "?", filename: m[2], lineno: Number(m[3]), colno: Number(m[4]), in_app: !m[2].includes("node_modules") }))
    .reverse();
}
