import type { Category, PaymentMode } from "./types";

/**
 * Voice entry drafts. Shared by the browser (live clarification while the user
 * edits) and the server (which re-checks everything before saving). A field the
 * speaker didn't say stays null; nothing here fills in a guess.
 */

export type VoiceLanguage = "ml" | "en";

export const SPEECH_LANG: Record<VoiceLanguage, string> = { ml: "ml-IN", en: "en-IN" };

export type VoiceDraft = {
  key: string;
  siteId: string;
  date: string;
  /** False when no date was spoken and the entry is dated today. */
  dateSaid: boolean;
  category: Category | null;
  description: string;
  /** Rupees as a decimal string, e.g. "8000" or "1250.50". */
  amount: string | null;
  /** Several numbers were heard and none was clearly the amount. */
  amountChoices: string[];
  quantity: string | null;
  unit: string | null;
  worker: string | null;
  /** Labour paid to a worker: wages, or an advance ("advance" was said). */
  labourKind: "wage" | "advance" | null;
  supplier: string | null;
  paymentMode: PaymentMode | null;
  /**
   * Set on entries split from one amount said for several workers ("Anu and Akhil
   * 1,600"). Their amounts must add up to shareTotal; nothing splits it for them.
   */
  shareGroup: string | null;
  shareTotal: string | null;
  /** A site name was spoken that isn't one of the user's sites. */
  siteHeard: string | null;
  siteConfirmed: boolean;
  /** The words this entry came from, shown next to it for checking. */
  heard: string;
};

export type DraftField = "site" | "date" | "category" | "description" | "amount" | "quantity" | "worker" | "supplier" | "paymentMode";

export type DraftIssue = { field: DraftField; level: "error" | "warning"; message: string };

export type IssueContext = { today: string; siteIds: string[]; workers: string[]; suppliers: string[] };

const MONEY_RE = /^\d{1,12}(\.\d{1,2})?$/;
const QTY_RE = /^\d{1,9}(\.\d{1,3})?$/;

/** Rupee string → integer paise, or null when it isn't a valid positive amount. */
export function toPaise(amount: string | null | undefined): number | null {
  const v = amount?.trim().replace(/,/g, "");
  if (!v || !MONEY_RE.test(v)) return null;
  const [whole, frac = ""] = v.split(".");
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return paise > 0 ? paise : null;
}

export const paiseToRupees = (paise: number) => (paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2));

/** Sum of valid amounts in exact integer paise. */
export function draftTotalPaise(drafts: Pick<VoiceDraft, "amount">[]) {
  return drafts.reduce((t, d) => t + (toPaise(d.amount) ?? 0), 0);
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** What must be fixed (errors) or noticed (warnings) before this draft can be saved. */
export function draftIssues(d: VoiceDraft, ctx: IssueContext): DraftIssue[] {
  const out: DraftIssue[] = [];
  const err = (field: DraftField, message: string) => out.push({ field, level: "error", message });
  const warn = (field: DraftField, message: string) => out.push({ field, level: "warning", message });

  if (!d.siteId || !ctx.siteIds.includes(d.siteId)) err("site", "Pick the site this was paid for.");
  else if (d.siteHeard && !d.siteConfirmed) err("site", `You said “${d.siteHeard}”, which isn't one of your sites. Confirm the site.`);

  if (toPaise(d.amount) === null) {
    if (d.amount?.trim()) err("amount", "Enter the amount in rupees, with at most 2 decimals.");
    else if (d.amountChoices.length > 1) err("amount", "Several numbers were heard. Pick the amount paid.");
    else err("amount", "No amount was heard. Enter it.");
  }
  if (!d.category) err("category", "Pick a category.");
  if (!d.description.trim()) err("description", "Add a short description.");
  if (!d.paymentMode) err("paymentMode", "How was this paid? It wasn't said.");
  if (d.date > ctx.today) err("date", "The date can't be in the future.");

  if (d.quantity && !QTY_RE.test(d.quantity.trim())) err("quantity", "Quantity must be a number, like 20 or 1.5.");
  else if (d.quantity && Number(d.quantity) <= 0) err("quantity", "Quantity must be above 0.");
  else if (d.quantity && !d.unit?.trim()) err("quantity", "Add a unit, like bags or loads.");

  if (d.worker && !ctx.workers.some((w) => sameName(w, d.worker!)))
    warn("worker", `${d.worker} isn't in your workers yet. Saving adds them.`);
  if (d.supplier && !ctx.suppliers.some((s) => sameName(s, d.supplier!)))
    warn("supplier", `${d.supplier} isn't in your suppliers yet. Saving adds them.`);
  return out;
}

export const hasErrors = (issues: DraftIssue[]) => issues.some((i) => i.level === "error");

/** draftIssues for a whole list, plus the rule across entries: shared amounts must add up. */
export function draftsIssues(drafts: VoiceDraft[], ctx: IssueContext): DraftIssue[][] {
  const out = drafts.map((d) => draftIssues(d, ctx));
  const groups = new Map<string, number[]>();
  drafts.forEach((d, i) => d.shareGroup && groups.set(d.shareGroup, [...(groups.get(d.shareGroup) ?? []), i]));
  for (const members of groups.values()) {
    const total = toPaise(drafts[members[0]].shareTotal);
    if (total === null) continue;
    const sum = members.reduce((t, i) => t + (toPaise(drafts[i].amount) ?? 0), 0);
    if (sum === total) continue;
    const names = members.map((i) => drafts[i].worker ?? `entry ${i + 1}`).join(", ");
    const message = `₹${paiseToRupees(total)} was said for ${names} together. Enter each share; they add up to ₹${paiseToRupees(sum)} now.`;
    for (const i of members) out[i].push({ field: "amount", level: "error", message });
  }
  return out;
}

/**
 * The single line item saved for a draft. "20 bags … 8,000" becomes 20 × ₹400 when
 * the amount divides exactly into paise; otherwise one lot, so the total the user
 * confirmed is never changed by rounding.
 */
export function draftItem(d: Pick<VoiceDraft, "description" | "amount" | "quantity" | "unit">) {
  const paise = toPaise(d.amount) ?? 0;
  const description = d.description.trim();
  const qty = d.quantity?.trim();
  const unit = d.unit?.trim().slice(0, 20);
  if (qty && unit && QTY_RE.test(qty) && Number(qty) > 0) {
    // Work in thousandths so 1.5 bags is exact: unit price (paise) × qty×1000 must equal paise×1000.
    const milli = Math.round(Number(qty) * 1000);
    const perUnit = Math.round((paise * 1000) / milli);
    if (perUnit * milli === paise * 1000) {
      return { description, quantity: qty, unit, unitPrice: (perUnit / 100).toFixed(2) };
    }
  }
  return {
    description: qty && unit ? `${description}, ${qty} ${unit}` : description,
    quantity: "1",
    unit: "lot",
    unitPrice: (paise / 100).toFixed(2),
  };
}

let counter = 0;
export const draftKey = () => `d${Date.now().toString(36)}${(++counter).toString(36)}`;

export function blankDraft(siteId: string, today: string): VoiceDraft {
  return {
    key: draftKey(),
    siteId,
    date: today,
    dateSaid: true,
    category: null,
    description: "",
    amount: null,
    amountChoices: [],
    quantity: null,
    unit: null,
    worker: null,
    labourKind: null,
    supplier: null,
    paymentMode: null,
    shareGroup: null,
    shareTotal: null,
    siteHeard: null,
    siteConfirmed: false,
    heard: "",
  };
}

export const EXAMPLE_TRANSCRIPT = "Site A, 20 bags cement, 8,000 rupees. Sand 5,000. Anu labour 1,000 and Akhil labour 800.";
