import { describe, expect, it } from "vitest";
import { digitsFor, normalize, parseTranscript, type ParseContext } from "@/lib/voice-parser";
import { blankDraft, draftIssues, draftItem, draftsIssues, draftTotalPaise, hasErrors, type VoiceDraft } from "@/lib/voice";
import { groundEntries } from "@/server/voice-ai";

const ctx: ParseContext = {
  today: "2026-10-20",
  sites: [
    { id: "site-a", name: "Site A" },
    { id: "kakkanad", name: "Kakkanad Villa" },
  ],
  defaultSiteId: "site-a",
  workers: ["Anu"],
  suppliers: ["Sri Balaji Traders"],
};
const issueCtx = { today: ctx.today, siteIds: ["site-a", "kakkanad"], workers: ctx.workers, suppliers: ctx.suppliers };

const parse = (t: string, over: Partial<ParseContext> = {}) => parseTranscript(t, { ...ctx, ...over });
const pick = (d: VoiceDraft) => ({
  description: d.description,
  category: d.category,
  amount: d.amount,
  quantity: d.quantity,
  unit: d.unit,
  worker: d.worker,
});

describe("voice parser", () => {
  it("reads the example into four drafts totalling ₹14,800", () => {
    const drafts = parse("Site A, 20 bags cement, 8,000 rupees. Sand 5,000. Anu labour 1,000 and Akhil labour 800.");
    expect(drafts.map(pick)).toEqual([
      { description: "Cement", category: "materials", amount: "8000", quantity: "20", unit: "bags", worker: null },
      { description: "Sand", category: "materials", amount: "5000", quantity: null, unit: null, worker: null },
      { description: "Labour wages", category: "labour", amount: "1000", quantity: null, unit: null, worker: "Anu" },
      { description: "Labour wages", category: "labour", amount: "800", quantity: null, unit: null, worker: "Akhil" },
    ]);
    expect(draftTotalPaise(drafts)).toBe(14_800_00);
    expect(drafts.every((d) => d.siteId === "site-a" && d.siteHeard === null)).toBe(true);
  });

  it("never fills in a payment mode or date that wasn't said", () => {
    const drafts = parse("Sand 5,000");
    expect(drafts[0].paymentMode).toBeNull();
    expect(drafts[0].dateSaid).toBe(false);
    expect(draftIssues(drafts[0], issueCtx).find((i) => i.field === "paymentMode")?.level).toBe("error");
  });

  it("reads Malayalam script, Malayalam number words and an 'all cash' payment", () => {
    const drafts = parse("ഇന്നലെ 20 ചാക്ക് സിമന്റ് 8000 രൂപ, മണൽ അയ്യായിരം രൂപ, അനുവിന് കൂലി ആയിരം, എല്ലാം ക്യാഷ്");
    expect(drafts.map((d) => [d.category, d.amount, d.quantity, d.unit, d.paymentMode, d.date])).toEqual([
      ["materials", "8000", "20", "bags", "cash", "2026-10-19"],
      ["materials", "5000", null, null, "cash", "2026-10-19"],
      ["labour", "1000", null, null, "cash", "2026-10-19"],
    ]);
    expect(drafts[2].worker).toBe("അനു");
  });

  it("reads mixed Manglish", () => {
    const drafts = parse("innale Anu-nu kooli 900 gpay, manal 2 load 19000 kadam");
    expect(drafts.map((d) => [d.category, d.amount, d.worker, d.paymentMode, d.quantity, d.unit])).toEqual([
      ["labour", "900", "Anu", "upi", null, null],
      ["materials", "19000", null, "credit", "2", "loads"],
    ]);
  });

  it("asks which number is the amount instead of guessing", () => {
    const [d] = parse("cement 20 8000");
    expect(d.amount).toBeNull();
    expect(d.amountChoices).toEqual(["20", "8000"]);
    expect(draftIssues(d, issueCtx).find((i) => i.field === "amount")?.message).toMatch(/Several numbers/);
  });

  it("keeps an item with no amount and flags it", () => {
    const [d] = parse("mason wages paid");
    expect(d.amount).toBeNull();
    expect(hasErrors(draftIssues(d, issueCtx))).toBe(true);
  });

  it("leaves the category empty for unknown items", () => {
    const [d] = parse("Watchman 600 cash");
    expect(d.amount).toBe("600");
    expect(d.category).toBe("other");
    const [e] = parse("Ravi bonus 600 cash");
    expect(e.category).toBeNull();
    expect(e.description).toBe("Ravi bonus");
  });

  it("uses a spoken site for what follows, and flags it when it isn't the picked one", () => {
    const drafts = parse("Kakkanad villa JCB 4 hours 5600 by gpay and tea 450");
    expect(drafts.map((d) => [d.siteId, d.siteHeard, d.quantity, d.unit, d.paymentMode])).toEqual([
      ["kakkanad", "Kakkanad Villa", "4", "hrs", "upi"],
      ["kakkanad", "Kakkanad Villa", null, null, null],
    ]);
    expect(draftIssues(drafts[0], issueCtx).some((i) => i.field === "site" && i.level === "error")).toBe(true);
    expect(draftIssues({ ...drafts[0], siteConfirmed: true }, issueCtx).some((i) => i.field === "site")).toBe(false);
  });

  it("flags a site name that isn't one of the user's sites", () => {
    const [d] = parse("Site B cement 50 bags 21000 from Sri Balaji by UPI");
    expect(d.siteId).toBe("site-a");
    expect(d.siteHeard).toBe("Site B");
    expect(d.supplier).toBe("Sri Balaji Traders");
  });

  it("matches site names with number words", () => {
    const [d] = parse("site one sand 3000", { sites: [{ id: "s1", name: "Site One" }], defaultSiteId: "other" });
    expect([d.siteId, d.siteHeard, d.amount]).toEqual(["s1", "Site One", "3000"]);
  });

  it("converts spoken numbers", () => {
    expect(digitsFor(normalize("ആയിരത്തി അഞ്ഞൂറ് രൂപ"))).toBe("1500 രൂപ");
    expect(digitsFor(normalize("five thousand, twenty five bags, 8k, 1.5 lakh"))).toBe("5000, 25 bags, 8000, 150000");
    expect(digitsFor(normalize("1,00,000 and 20 8000"))).toBe("100000 and 20 8000");
    expect(parse("steel 1.5 lakh on credit")[0].amount).toBe("150000");
  });

  it("reads explicit dates and flags future ones", () => {
    expect(parse("diesel 1900 on 18/10")[0].date).toBe("2026-10-18");
    expect(parse("diesel 1900 on 5th oct")[0].date).toBe("2026-10-05");
    // A date after today is kept as heard and flagged, not quietly moved to last year.
    const [future] = parse("diesel 1900 on 25/10");
    expect(future.date).toBe("2026-10-25");
    expect(draftIssues(future, issueCtx).some((i) => i.field === "date" && i.level === "error")).toBe(true);
  });

  it("returns nothing for speech with no payments", () => {
    expect(parse("hello is this working")).toEqual([]);
  });
});

describe("draft issues", () => {
  it("require a site the user can write to", () => {
    const d = { ...blankDraft("elsewhere", ctx.today), category: "materials" as const, description: "x", amount: "10", paymentMode: "cash" as const };
    expect(draftIssues(d, issueCtx).map((i) => i.field)).toEqual(["site"]);
    expect(draftIssues({ ...d, siteId: "site-a" }, issueCtx)).toEqual([]);
  });

  it("warn about new workers and suppliers", () => {
    const d = { ...blankDraft("site-a", ctx.today), category: "labour" as const, description: "Wages", amount: "800", paymentMode: "cash" as const, worker: "Akhil" };
    expect(draftIssues(d, issueCtx)).toEqual([{ field: "worker", level: "warning", message: expect.stringMatching(/Akhil isn't in your workers/) }]);
  });

  it("reject malformed amounts", () => {
    const d = { ...blankDraft("site-a", ctx.today), category: "other" as const, description: "x", paymentMode: "cash" as const };
    for (const amount of ["0", "1.005", "abc", "-5"]) expect(draftIssues({ ...d, amount }, issueCtx).some((i) => i.field === "amount")).toBe(true);
  });
});

describe("draft items", () => {
  it("split an amount into an exact unit price, or keep one lot", () => {
    expect(draftItem({ description: "Cement", amount: "8000", quantity: "20", unit: "bags" })).toEqual({
      description: "Cement",
      quantity: "20",
      unit: "bags",
      unitPrice: "400.00",
    });
    expect(draftItem({ description: "Sand", amount: "1000", quantity: "3", unit: "loads" })).toEqual({
      description: "Sand, 3 loads",
      quantity: "1",
      unit: "lot",
      unitPrice: "1000.00",
    });
    expect(draftItem({ description: "Steel", amount: "150000", quantity: "1.5", unit: "tons" }).unitPrice).toBe("100000.00");
  });
});

describe("AI output grounding", () => {
  const transcript = "Site A, 20 bags cement, 8,000 rupees. Anu labour 1,000";
  const entry = {
    heard: "20 bags cement, 8,000 rupees",
    description: "Cement",
    category: "materials" as const,
    amount: "8000",
    quantity: "20",
    unit: "bags",
    worker: null,
    labour_kind: null,
    shared_total: null,
    supplier: null,
    payment_mode: null,
    date: null,
    site: "Site A",
  };

  it("keeps values that were said", () => {
    const [d] = groundEntries({ entries: [entry] }, transcript, ctx);
    expect([d.amount, d.quantity, d.unit, d.siteId, d.siteHeard, d.paymentMode]).toEqual(["8000", "20", "bags", "site-a", null, null]);
  });

  it("drops amounts, names, payment modes, dates and sites that weren't said", () => {
    const [d, w] = groundEntries(
      {
        entries: [
          { ...entry, amount: "9000", payment_mode: "cash", date: "2026-10-19", supplier: "Sri Balaji Traders", site: "Kakkanad Villa" },
          { ...entry, heard: "Anu labour 1,000", category: "labour", amount: "1000", quantity: null, worker: "Akhil" },
        ],
      },
      transcript,
      ctx,
    );
    expect(d.amount).toBeNull();
    expect(d.amountChoices).toEqual(["20", "8000"]);
    expect([d.paymentMode, d.date, d.dateSaid, d.supplier, d.siteId, d.siteHeard]).toEqual([null, "2026-10-20", false, null, "site-a", null]);
    expect([w.amount, w.worker]).toEqual(["1000", null]);
  });
});

describe("several workers in one entry", () => {
  it("repeats an amount said 'each'", () => {
    const drafts = parse("Anu and Akhil labour 800 each");
    expect(drafts.map((d) => [d.worker, d.amount, d.labourKind, d.shareGroup])).toEqual([
      ["Anu", "800", "wage", null],
      ["Akhil", "800", "wage", null],
    ]);
  });

  it("leaves a shared total for the user to split, and checks the shares add up", () => {
    const drafts = parse("Anu, Akhil and Ravi labour 2400 cash");
    expect(drafts.map((d) => [d.worker, d.amount, d.shareTotal, d.paymentMode])).toEqual([
      ["Anu", null, "2400", "cash"],
      ["Akhil", null, "2400", "cash"],
      ["Ravi", null, "2400", "cash"],
    ]);
    expect(new Set(drafts.map((d) => d.shareGroup)).size).toBe(1);
    const filled = drafts.map((d, i) => ({ ...d, amount: ["1000", "800", "500"][i] }));
    const issues = draftsIssues(filled, { ...issueCtx, workers: ["Anu", "Akhil", "Ravi"] });
    expect(issues[0].find((i) => i.field === "amount")?.message).toMatch(/₹2400 was said for Anu, Akhil, Ravi together.*₹2300/);
    const fixed = filled.map((d, i) => ({ ...d, amount: ["1000", "800", "600"][i] }));
    expect(draftsIssues(fixed, { ...issueCtx, workers: ["Anu", "Akhil", "Ravi"] }).every((l) => !hasErrors(l))).toBe(true);
  });

  it("reads several workers in Malayalam with 'each'", () => {
    const drafts = parse("അനു, അഖില് കൂലി 900 ഓരോരുത്തര്ക്കും");
    expect(drafts.map((d) => [d.worker, d.amount])).toEqual([
      ["അനു", "900"],
      ["അഖില്", "900"],
    ]);
  });

  it("marks advances", () => {
    const [d] = parse("Anu advance 500 gpay");
    expect([d.category, d.worker, d.amount, d.labourKind, d.paymentMode]).toEqual(["labour", "Anu", "500", "advance", "upi"]);
  });

  it("keeps separately priced workers separate", () => {
    const drafts = parse("Anu labour 1,000 and Akhil labour 800");
    expect(drafts.map((d) => [d.worker, d.amount, d.shareGroup])).toEqual([
      ["Anu", "1000", null],
      ["Akhil", "800", null],
    ]);
  });
});
