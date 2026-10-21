import { NotFoundError } from "@/server/errors";
import { receiptLink } from "@/server/data/receipts";
import { getActor } from "@/server/session";

/**
 * Checks the caller can see the receipt's site, then redirects to a signed URL that
 * expires in minutes. `?download=1` saves the file instead of previewing it.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/receipts/[id]">) {
  const actor = await getActor();
  if (!actor) return new Response("Sign in to view receipts.", { status: 401 });
  const { id } = await ctx.params;
  const download = new URL(req.url).searchParams.get("download") === "1";
  try {
    const { url } = await receiptLink(actor, id, download ? "download" : "preview");
    return new Response(null, {
      status: 302,
      headers: { Location: url, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
    });
  } catch (err) {
    if (err instanceof NotFoundError) return new Response("Receipt not found.", { status: 404 });
    throw err;
  }
}
