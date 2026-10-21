import { storage } from "@/server/storage";
import { verifyFileToken } from "@/server/storage/local";

/**
 * Serves a file from the local storage driver for a valid, unexpired signed token
 * (issued by /api/receipts/[id] after an access check). With S3 storage, signed URLs
 * point at the bucket instead and this route isn't used.
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/files/[token]">) {
  const { token } = await ctx.params;
  const t = verifyFileToken(token);
  if (!t) return new Response("This link has expired. Open the receipt again from the app.", { status: 403 });
  const bytes = await storage.get(t.key);
  if (!bytes) return new Response("File not found.", { status: 404 });
  const name = t.n.replace(/[^\w.\- ]/g, "_");
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": t.t,
      "Content-Disposition": `${t.d}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(t.n)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // Images are sandboxed. Chrome won't render PDFs under a CSP sandbox, so PDFs rely on the
      // upload check, which refuses PDFs with scripts, launch actions or embedded files.
      ...(t.t === "application/pdf" ? {} : { "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" }),
      "Referrer-Policy": "no-referrer",
    },
  });
}
