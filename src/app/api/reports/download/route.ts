import { ZodError } from "zod";
import { buildReport } from "@/server/reports/build";
import { renderPdf } from "@/server/reports/pdf";
import { fileSlug } from "@/server/reports/safe";
import { renderXlsx } from "@/server/reports/xlsx";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { hit, LIMITS } from "@/server/rate-limit";
import { getActor } from "@/server/session";

/**
 * GET /api/reports/download?kind=expenses&format=pdf|xlsx&from=…&to=…[&site&category&worker&supplier&method]
 * Builds the report on the server for the sites the caller may export, then renders it.
 */
export async function GET(req: Request) {
  const actor = await getActor();
  if (!actor) return new Response("Sign in to download reports.", { status: 401 });
  const limit = await hit(`report:${actor.userId}`, LIMITS.reportDownload);
  if (!limit.allowed) return new Response("Too many downloads. Try again in a few minutes.", { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });
  const p = new URL(req.url).searchParams;
  const get = (k: string) => p.get(k) || undefined;

  let report;
  try {
    report = await buildReport(actor, {
      kind: get("kind"),
      format: get("format"),
      from: get("from"),
      to: get("to"),
      siteId: get("site"),
      categoryCode: get("category"),
      workerName: get("worker"),
      supplierName: get("supplier"),
      paymentMethod: get("method"),
    });
  } catch (err) {
    if (err instanceof ZodError) return new Response(err.issues[0]?.message ?? "Invalid report filters.", { status: 400 });
    if (err instanceof ValidationError) return new Response(err.message, { status: 400 });
    if (err instanceof NotFoundError) return new Response("Site not found.", { status: 404 });
    if (err instanceof ForbiddenError) return new Response(err.message, { status: 403 });
    throw err;
  }

  const format = get("format") === "pdf" ? "pdf" : "xlsx";
  const body = format === "pdf" ? await renderPdf(report) : await renderXlsx(report);
  const scope = report.consolidated ? "all-sites" : report.sites[0].name;
  const name = `${fileSlug(report.kind, scope, report.period.from, "to", report.period.to)}.${format}`;
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
