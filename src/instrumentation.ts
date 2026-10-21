import type { Instrumentation } from "next";

/** Refuses to start a production server with missing or unsafe configuration (src/server/env.ts). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production" || process.env.SKIP_ENV_CHECK === "1") return;
  const { productionEnvProblems } = await import("./server/env");
  const problems = productionEnvProblems();
  if (problems.length) throw new Error(`Configuration problems:\n- ${problems.join("\n- ")}`);
}

/**
 * Server errors Next.js catches while rendering pages, running route handlers, server
 * actions and the proxy go to src/server/monitoring.ts (JSON log line, plus Sentry when
 * SENTRY_DSN is set). Errors that actions turn into form messages are reported by `actionError`.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    console.error(JSON.stringify({ level: "error", source: context.routeType, path: request.path.split("?")[0], error: String(err) }));
    return;
  }
  const { reportError } = await import("./server/monitoring");
  await reportError(err, {
    source: context.routeType,
    path: request.path,
    method: request.method,
    digest: typeof err === "object" && err && "digest" in err ? String(err.digest) : undefined,
    extra: { route: context.routePath, renderSource: context.renderSource },
  });
};
