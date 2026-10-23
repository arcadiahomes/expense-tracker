import { ZodError } from "zod";
import { labourInvoice } from "@/server/data/invoices";
import { organizationProfile } from "@/server/data/organizations";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { hit, LIMITS } from "@/server/rate-limit";
import { renderLabourInvoicePdf } from "@/server/reports/invoice-pdf";
import { fileSlug } from "@/server/reports/safe";
import { getActor } from "@/server/session";

/** GET /api/invoices/labour?site=…&worker=…&from=…&to=…: a worker's wage invoice for the period as a PDF. */
export async function GET(req: Request) {
  const actor = await getActor();
  if (!actor) return new Response("Sign in to download invoices.", { status: 401 });
  const limit = await hit(`report:${actor.userId}`, LIMITS.reportDownload);
  if (!limit.allowed) return new Response("Too many downloads. Try again in a few minutes.", { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });
  const p = new URL(req.url).searchParams;
  let invoice;
  try {
    invoice = await labourInvoice(actor, { siteId: p.get("site"), workerId: p.get("worker"), from: p.get("from"), to: p.get("to") });
  } catch (err) {
    if (err instanceof ZodError) return new Response(err.issues[0]?.message ?? "Invalid invoice filters.", { status: 400 });
    if (err instanceof ValidationError) return new Response(err.message, { status: 400 });
    if (err instanceof NotFoundError) return new Response(err.message, { status: 404 });
    if (err instanceof ForbiddenError) return new Response(err.message, { status: 403 });
    throw err;
  }
  const body = await renderLabourInvoicePdf(invoice, await organizationProfile(actor), actor.name);
  const name = fileSlug("labour-invoice", invoice.worker.name, invoice.from, "to", invoice.to);
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${name}.pdf"`,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
