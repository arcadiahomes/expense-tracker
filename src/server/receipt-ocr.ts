import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { ReceiptType } from "./files";
import { isoDate, positiveMoney } from "./validation";

/**
 * Optional reading of a receipt or bill: supplier, date, bill number and total. The
 * result is only ever a suggestion shown next to the form; a person confirms or fixes
 * every value before it's saved anywhere. Runs on the server with the key from the
 * environment; the file goes to Anthropic only when this is enabled.
 */

const MODEL = process.env.RECEIPT_OCR_MODEL || "claude-opus-5-5";

export function ocrAvailable() {
  return !!process.env.ANTHROPIC_API_KEY && process.env.RECEIPT_OCR !== "off";
}

export const OCR_TYPES: ReceiptType[] = ["application/pdf", "image/jpeg", "image/png", "image/webp"];

const reading = z.object({
  supplier: z.string().nullable().describe("Seller or supplier name as printed. Null if not printed."),
  bill_number: z.string().nullable().describe("Invoice, bill or receipt number as printed. Null if none."),
  date: z.string().nullable().describe("Bill date as yyyy-mm-dd. Null if not printed or unreadable."),
  total: z.string().nullable().describe("Grand total payable in rupees, digits only with optional 2 decimals, e.g. '18250.00'. Null if unclear."),
  legible: z.boolean().describe("False if the document is too blurred, cut off or not a bill/receipt."),
  notes: z.string().nullable().describe("One short sentence on anything uncertain, else null."),
});

export type OcrSuggestion = {
  supplier: string | null;
  billNumber: string | null;
  date: string | null;
  amount: string | null;
  legible: boolean;
  notes: string | null;
  model: string;
};

const SYSTEM = `You read photos and PDFs of shop receipts and supplier bills from construction sites in India and report what is printed on them.
Copy values exactly as printed. If a value isn't printed or you can't read it with confidence, return null. Never guess or calculate a value that isn't printed.
For the total, use the final amount payable (including tax), not a subtotal. Don't report tax breakdowns.`;

let client: Anthropic | null = null;

/** Reads the file; values that don't parse as a date or amount are dropped (null), never "fixed". */
export async function readReceipt(bytes: Uint8Array, type: ReceiptType, today: string): Promise<OcrSuggestion> {
  if (!OCR_TYPES.includes(type)) throw new Error("unsupported");
  client ??= new Anthropic({ timeout: 45_000, maxRetries: 1 });
  const data = Buffer.from(bytes).toString("base64");
  const file =
    type === "application/pdf"
      ? ({ type: "document", source: { type: "base64", media_type: "application/pdf", data } } as const)
      : ({ type: "image", source: { type: "base64", media_type: type as "image/jpeg" | "image/png" | "image/webp", data } } as const);
  const res = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: zodOutputFormat(reading) },
    system: SYSTEM,
    messages: [{ role: "user", content: [file, { type: "text", text: "Read this document." }] }],
  });
  if (res.stop_reason === "refusal" || !res.parsed_output) throw new Error(`No reading (${res.stop_reason})`);
  const r = res.parsed_output;
  const date = r.date && isoDate.safeParse(r.date).success && r.date <= today ? r.date : null;
  const amount = r.total && positiveMoney.safeParse(r.total.replace(/[₹,\s]/g, "")).success ? positiveMoney.parse(r.total.replace(/[₹,\s]/g, "")) : null;
  const text = (v: string | null, max: number) => (v?.trim() ? v.trim().slice(0, max) : null);
  return {
    supplier: text(r.supplier, 120),
    billNumber: text(r.bill_number, 60),
    date,
    amount,
    legible: r.legible,
    notes: text(r.notes, 300),
    model: MODEL,
  };
}
