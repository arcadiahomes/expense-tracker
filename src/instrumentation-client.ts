/**
 * Reports uncaught browser errors to /api/client-errors (signed-in users only; the server
 * rate-limits and forwards them to monitoring). Only the message, stack and path are sent:
 * never form values, query strings or page content.
 */
const seen = new Set<string>();

function send(message: string, stack?: string) {
  if (seen.has(message) || seen.size >= 10) return;
  seen.add(message);
  const body = JSON.stringify({ message: message.slice(0, 1000), stack: stack?.slice(0, 8000), path: location.pathname });
  try {
    if (!navigator.sendBeacon?.("/api/client-errors", new Blob([body], { type: "application/json" }))) {
      void fetch("/api/client-errors", { method: "POST", body, keepalive: true, headers: { "Content-Type": "application/json" } }).catch(() => {});
    }
  } catch {
    // Never let error reporting cause another error.
  }
}

window.addEventListener("error", (e) => {
  // Resource load failures (images, scripts offline) have no error object; skip them.
  if (e.error instanceof Error) send(e.error.message, e.error.stack);
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  if (r instanceof Error) send(r.message, r.stack);
  else if (typeof r === "string") send(r);
});
