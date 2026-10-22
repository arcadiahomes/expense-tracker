import { getClientInvoice } from "@/server/data/invoices";
import { NotFoundError } from "@/server/errors";
import { hit, LIMITS } from "@/server/rate-limit";
import { renderClientInvoicePdf } from "@/server/reports/invoice-pdf";
import { fileSlug } from "@/server/reports/safe";
import { getActor } from "@/server/session";

/** GET /api/invoices/client/:id: the invoice as a PDF, for people who manage finance on its site. */
export async function GET(_req: Request, ctx: RouteContext<"/api/invoices/client/[id]">) {
  const actor = await getActor();
  if (!actor) return new Response("Sign in to download invoices.", { status: 401 });
  const limit = await hit(`report:${actor.userId}`, LIMITS.reportDownload);
  if (!limit.allowed) return new Response("Too many downloads. Try again in a few minutes.", { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });
  const { id } = await ctx.params;
  let invoice;
  try {
    invoice = await getClientInvoice(actor, id);
  } catch (err) {
    if (err instanceof NotFoundError) return new Response("Invoice not found.", { status: 404 });
    throw err;
  }
  const body = await renderClientInvoicePdf(invoice, actor.orgName);
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${fileSlug("invoice", invoice.invoiceNo, invoice.client)}.pdf"`,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
