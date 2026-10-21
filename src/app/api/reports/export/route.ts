import { CATEGORY_META } from "@/lib/categories";
import type { Expense } from "@/lib/types";
import { reportRows } from "@/server/data/reports";
import { listSites } from "@/server/data/sites";
import { hit, LIMITS } from "@/server/rate-limit";
import { getActor } from "@/server/session";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { ZodError } from "zod";

const PAYMENT_LABEL = { cash: "Cash", upi: "UPI", bank: "Bank", cheque: "Cheque", credit: "Credit" } as const;
const SOURCE_LABEL = { manual: "Manual", voice: "Voice", bill_payment: "Bill payment", import: "Import", purchase: "Material purchase" } as const;

/**
 * Quotes a CSV cell. Text starting with = + - @ (or tab/CR) is prefixed with an
 * apostrophe so spreadsheets show it instead of running it as a formula.
 */
const esc = (v: string | number | undefined) => {
  let s = String(v ?? "");
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

/** CSV of every row matching the report filters (query string), streamed page by page. */
export async function GET(req: Request) {
  const actor = await getActor();
  if (!actor) return new Response("Sign in to export reports.", { status: 401 });
  const limit = await hit(`report:${actor.userId}`, LIMITS.reportDownload);
  if (!limit.allowed) return new Response("Too many downloads. Try again in a few minutes.", { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const filters = {
    from: params.from,
    to: params.to,
    siteId: params.site || undefined,
    categoryCode: params.category || undefined,
    workerName: params.worker || undefined,
    supplierName: params.supplier || undefined,
    paymentMethod: params.method || undefined,
    sort: params.sort || undefined,
  };

  const rows = reportRows(actor, filters);
  // Pull the first row before responding so validation/authorization errors return a status code.
  let first: IteratorResult<Expense, void>;
  try {
    first = await rows.next();
  } catch (err) {
    if (err instanceof ZodError || err instanceof ValidationError) return new Response("Invalid report filters.", { status: 400 });
    if (err instanceof NotFoundError) return new Response("Site not found.", { status: 404 });
    if (err instanceof ForbiddenError) return new Response(err.message, { status: 403 });
    throw err;
  }

  const siteNames = new Map((await listSites(actor)).map((s) => [s.site.id, s.site.name]));
  const head = ["Date", "Site", "Category", "Description", "Quantity", "Worker", "Supplier", "Payment", "Source", "Amount (INR)", "Entered by"];
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode("﻿" + head.map(esc).join(",") + "\r\n"));
      let next = first;
      while (!next.done) {
        const e = next.value;
        const line = [
          e.date,
          siteNames.get(e.siteId),
          CATEGORY_META[e.category].label,
          e.description,
          e.quantity,
          e.worker,
          e.supplier,
          PAYMENT_LABEL[e.paymentMode],
          SOURCE_LABEL[e.source],
          e.amount.toFixed(2),
          e.enteredBy,
        ];
        controller.enqueue(encoder.encode(line.map(esc).join(",") + "\r\n"));
        next = await rows.next();
      }
      controller.close();
    },
  });

  const name = `arcadia-home-report-${filters.from ?? ""}-to-${filters.to ?? ""}.csv`;
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
