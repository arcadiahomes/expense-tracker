import { getReceipt } from "@/server/data/client-payments";
import { NotFoundError } from "@/server/errors";
import { hit, LIMITS } from "@/server/rate-limit";
import { renderReceiptPdf } from "@/server/reports/invoice-pdf";
import { fileSlug } from "@/server/reports/safe";
import { getActor } from "@/server/session";

/**
 * GET /api/invoices/receipts/:id: a payment receipt (or refund/reversal record) as a PDF,
 * for people who manage finance on its site. `?inline=1` opens it in the browser to view
 * or print instead of downloading. Read-only: it only renders what the ledger holds.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/invoices/receipts/[id]">) {
  const actor = await getActor();
  if (!actor) return new Response("Sign in to download receipts.", { status: 401 });
  const limit = await hit(`report:${actor.userId}`, LIMITS.reportDownload);
  if (!limit.allowed) return new Response("Too many downloads. Try again in a few minutes.", { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });
  const { id } = await ctx.params;
  let receipt;
  try {
    receipt = await getReceipt(actor, id);
  } catch (err) {
    if (err instanceof NotFoundError) return new Response("Receipt not found.", { status: 404 });
    throw err;
  }
  const body = await renderReceiptPdf(receipt, actor.name);
  const inline = new URL(req.url).searchParams.get("inline") === "1";
  const name = fileSlug("receipt", receipt.receipt.receiptNo, receipt.receipt.client);
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name}.pdf"`,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
