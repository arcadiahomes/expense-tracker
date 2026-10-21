import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { advanceIn, dateIn, normalize, numbersIn, paymentIn, siteIn, type ParseContext } from "@/lib/voice-parser";
import { draftKey, paiseToRupees, toPaise, type VoiceDraft } from "@/lib/voice";
import { CATEGORY_CODES, PAYMENT_METHODS } from "./validation";

/**
 * Optional AI reading of a voice transcript with Claude. Only text is sent (the
 * browser's speech service already turned audio into text), the API key never
 * leaves the server, and everything the model returns is checked against the
 * transcript by groundEntries: a number, name or payment mode that wasn't said is
 * dropped and left for the user to fill in.
 */

const MODEL = process.env.VOICE_AI_MODEL || "claude-opus-5-5";

export function aiExtractionAvailable() {
  return !!process.env.ANTHROPIC_API_KEY && process.env.VOICE_AI !== "off";
}

const extraction = z.object({
  entries: z.array(
    z.object({
      heard: z.string().describe("The exact words from the transcript this entry comes from, copied verbatim."),
      description: z.string().describe("Short English description of what was paid for, e.g. 'Cement', 'Labour wages'."),
      category: z.enum(CATEGORY_CODES).nullable(),
      amount: z.string().nullable().describe("Amount paid in rupees as digits only, e.g. '8000'. Null if not said."),
      quantity: z.string().nullable().describe("Quantity as digits, e.g. '20'. Null if not said."),
      unit: z.string().nullable().describe("Unit in English, e.g. 'bags', 'loads', 'hrs'. Null if not said."),
      worker: z.string().nullable().describe("Person paid, for labour entries, as spoken. Null if not said."),
      labour_kind: z.enum(["wage", "advance"]).nullable().describe("For a worker: 'advance' only if an advance was said, else 'wage'."),
      shared_total: z
        .string()
        .nullable()
        .describe("When one amount was said for several workers together, that total on each of their entries (and amount null)."),
      supplier: z.string().nullable().describe("Shop or supplier, for purchases, as spoken. Null if not said."),
      payment_mode: z.enum(PAYMENT_METHODS).nullable(),
      date: z.string().nullable().describe("yyyy-mm-dd, only if a date or day was spoken. Null otherwise."),
      site: z.string().nullable().describe("Site name as spoken. Null if not said."),
    }),
  ),
});
export type Extracted = z.infer<typeof extraction>;

const SYSTEM = `You read short spoken notes from construction site engineers in Kerala and list the expenses in them.
The notes may be in Malayalam (in Malayalam script or romanized), English, or a mix, and come from speech recognition, so expect odd spellings.

Rules:
- One entry per payment. "Anu labour 1000 and Akhil labour 800" is two entries.
- One entry per worker. "Anu and Akhil 800 each" is two entries of 800. "Anu and Akhil 1600" is two entries with amount null and shared_total 1600: never split a shared amount yourself.
- Copy only what was said. When a value was not said, return null. Never guess an amount, quantity, worker, supplier, payment mode, date or site.
- If you can't tell which number is the amount, return amount null.
- Amounts are rupees, written as digits ("അയ്യായിരം" is 5000, "1.5 lakh" is 150000).
- Categories: materials (cement, sand, steel, bricks, tiles, paint, wood...), labour (wages, kooli/കൂലി, mason, helper...), transport (lorry, tipper, auto, loading...), equipment (JCB, mixer, diesel, hire...), other. Null if unclear.
- payment_mode: cash, upi (GPay, PhonePe, Paytm), bank (NEFT, transfer), cheque, credit (kadam/കടം, pay later). A mode said for "all" applies to every entry.
- Keep people's and shops' names as spoken; don't translate or complete them.`;

let client: Anthropic | null = null;

/** Raw model output for a transcript. Throws on API failure; the caller falls back to the rule-based reader. */
export async function extractWithClaude(transcript: string, ctx: ParseContext): Promise<Extracted> {
  client ??= new Anthropic({ timeout: 20_000, maxRetries: 1 });
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: zodOutputFormat(extraction) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          `Today is ${ctx.today}.`,
          `Sites: ${ctx.sites.map((s) => s.name).join("; ") || "none"}.`,
          `Known workers: ${ctx.workers.join("; ") || "none"}.`,
          `Known suppliers: ${ctx.suppliers.join("; ") || "none"}.`,
          "",
          "<transcript>",
          transcript,
          "</transcript>",
        ].join("\n"),
      },
    ],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) throw new Error(`No extraction (${response.stop_reason})`);
  return response.parsed_output;
}

const said = (text: string, phrase: string) => normalize(text).includes(normalize(phrase));

/** Model output → drafts, keeping only values that can be found in what was said. */
export function groundEntries(out: Extracted, transcript: string, ctx: ParseContext): VoiceDraft[] {
  const spoken = new Set(numbersIn(transcript).map((n) => toPaise(n)).filter((p): p is number => p !== null));
  const isSpoken = (n: string | null) => {
    const p = toPaise(n?.replace(/[^\d.]/g, ""));
    return p !== null && spoken.has(p) ? paiseToRupees(p) : null;
  };
  const spokenDate = dateIn(transcript, ctx.today);
  const anyPayment = paymentIn(transcript);
  const known = (names: string[], name: string | null) => {
    if (!name) return null;
    const match = names.find((n) => normalize(n) === normalize(name));
    return said(transcript, name) || (match && said(transcript, match.split(/\s+/)[0])) ? (match ?? name.trim()) : null;
  };

  // Entries that share one spoken total form a group the user splits.
  const groups = new Map<string, string>();
  return out.entries.slice(0, 25).map((e) => {
    const shareTotal = e.category === "labour" ? isSpoken(e.shared_total) : null;
    const groupKey = shareTotal ? `${shareTotal}|${normalize(e.heard)}` : null;
    if (groupKey && !groups.has(groupKey)) groups.set(groupKey, draftKey());
    const amount = isSpoken(e.amount);
    const quantity = isSpoken(e.quantity);
    const site = e.site && said(transcript, e.site) ? (siteIn(e.site, ctx.sites) ?? { id: undefined, heard: e.site.trim() }) : null;
    const dateOk = !!e.date && !!spokenDate && e.date === (dateIn(e.heard, ctx.today) ?? spokenDate).date;
    return {
      key: draftKey(),
      siteId: site?.id ?? ctx.defaultSiteId,
      siteHeard: site && site.id !== ctx.defaultSiteId ? site.heard : null,
      siteConfirmed: false,
      date: dateOk ? e.date! : (spokenDate?.date ?? ctx.today),
      dateSaid: !!spokenDate,
      category: e.category,
      description: e.description.trim().slice(0, 200),
      amount: shareTotal ? null : amount,
      amountChoices: amount || shareTotal ? [] : [...new Set(numbersIn(e.heard))].filter((n) => toPaise(n)).slice(0, 10),
      shareGroup: groupKey ? groups.get(groupKey)! : null,
      shareTotal,
      quantity,
      unit: quantity && e.unit ? e.unit.trim().slice(0, 20) : null,
      worker: e.category === "labour" ? known(ctx.workers, e.worker) : null,
      labourKind: e.category === "labour" && e.worker ? (e.labour_kind === "advance" && advanceIn(transcript) ? "advance" : "wage") : null,
      supplier: e.category !== "labour" ? known(ctx.suppliers, e.supplier) : null,
      // A payment mode is kept only if one was said somewhere.
      paymentMode: anyPayment ? e.payment_mode : null,
      heard: e.heard.slice(0, 4000),
    };
  });
}
