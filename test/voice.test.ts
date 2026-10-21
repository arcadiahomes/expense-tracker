import { and, eq, inArray } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { constructionSites, expenseItems, expenses, labourWorkers, siteMemberships, voiceBatches } from "@/db/schema";
import type { VoiceDraft } from "@/lib/voice";
import { createSite } from "@/server/data/sites";
import { getVoiceSetup, parseVoice, recordVoiceConsent, reviewVoice, saveVoice, withdrawVoiceConsent } from "@/server/data/voice";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { world } from "./fixtures";

// Claude is replaced by a controllable stub; the real grounding still runs on whatever it returns.
const ai = vi.hoisted(() => ({ available: false, extract: vi.fn() }));
vi.mock("@/server/voice-ai", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/voice-ai")>();
  return { ...real, aiExtractionAvailable: () => ai.available, extractWithClaude: ai.extract };
});

const EXAMPLE = "Site One, 20 bags cement, 8,000 rupees. Sand 5,000. Anu labour 1,000 and Akhil labour 800.";

let w: Awaited<ReturnType<typeof world>>;
let closedSite: string;
beforeAll(async () => {
  w = await world();
  const closed = await createSite(w.a.owner, { name: "Closed Site", location: "Thrissur", budget: "1000", startDate: "2026-01-01" });
  closedSite = closed.site.id;
  await db.update(constructionSites).set({ status: "completed" }).where(eq(constructionSites.id, closedSite));
  await db.insert(siteMemberships).values({ siteId: closedSite, userId: w.a.eng1.userId, role: "engineer" });
});
beforeEach(() => {
  ai.available = false;
  ai.extract.mockReset();
});

/** Parses the example on site 1 and fills in the one thing it never guesses: how it was paid. */
async function exampleDrafts(transcript = EXAMPLE) {
  const { entries } = await parseVoice(w.a.eng1, { siteId: w.site1, transcript, language: "en" });
  return entries.map((e) => ({ ...e, paymentMode: "cash" as const }));
}
const save = (entries: VoiceDraft[], over: Record<string, unknown> = {}) =>
  saveVoice(w.a.eng1, {
    transcript: EXAMPLE,
    language: "en",
    extractor: "rules",
    spoken: true,
    entries,
    clientKey: crypto.randomUUID(),
    ...over,
  });
const count = async (siteId: string) => (await db.select({ id: expenses.id }).from(expenses).where(eq(expenses.siteId, siteId))).length;

describe("voice parsing", () => {
  it("returns drafts and saves nothing", async () => {
    const before = await count(w.site1);
    const res = await parseVoice(w.a.eng1, { siteId: w.site1, transcript: EXAMPLE, language: "en" });
    expect(res.extractor).toBe("rules");
    expect(res.entries.map((e) => [e.description, e.amount, e.worker, e.paymentMode])).toEqual([
      ["Cement", "8000", null, null],
      ["Sand", "5000", null, null],
      ["Labour wages", "1000", "Anu", null],
      ["Labour wages", "800", "Akhil", null],
    ]);
    expect(await count(w.site1)).toBe(before);
  });

  it("is limited to people who can add expenses to the site", async () => {
    const input = { siteId: w.site1, transcript: "sand 5000", language: "en" };
    await expect(parseVoice(w.a.viewer, input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(parseVoice(w.a.eng2, input)).rejects.toBeInstanceOf(NotFoundError);
    await expect(parseVoice(w.b.owner, input)).rejects.toBeInstanceOf(NotFoundError);
    await expect(parseVoice(w.a.eng1, { ...input, siteId: closedSite })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("validates the transcript", async () => {
    await expect(parseVoice(w.a.eng1, { siteId: w.site1, transcript: "  ", language: "en" })).rejects.toThrow();
    await expect(parseVoice(w.a.eng1, { siteId: w.site1, transcript: "x".repeat(4001), language: "en" })).rejects.toThrow();
  });

  it("uses Claude only after consent, and grounds what it returns", async () => {
    ai.available = true;
    ai.extract.mockResolvedValue({
      entries: [
        { heard: "sand 5000", description: "Sand", category: "materials", amount: "5000", quantity: null, unit: null, worker: null, supplier: null, payment_mode: "upi", date: null, site: null },
        { heard: "sand 5000", description: "Bricks", category: "materials", amount: "7777", quantity: null, unit: null, worker: null, supplier: "Made Up Traders", payment_mode: null, date: null, site: null },
      ],
    });
    const input = { siteId: w.site1, transcript: "sand 5000", language: "en" };
    expect((await parseVoice(w.a.eng1, input)).extractor).toBe("rules");
    expect(ai.extract).not.toHaveBeenCalled();

    await recordVoiceConsent(w.a.eng1);
    try {
      const res = await parseVoice(w.a.eng1, input);
      expect(res.extractor).toBe("claude");
      expect(res.entries.map((e) => [e.amount, e.paymentMode, e.supplier])).toEqual([
        ["5000", null, null],
        [null, null, null],
      ]);
    } finally {
      await withdrawVoiceConsent(w.a.eng1);
    }
  });

  it("falls back to the basic reader when Claude fails", async () => {
    ai.available = true;
    ai.extract.mockRejectedValue(new Error("network down"));
    await recordVoiceConsent(w.a.eng1);
    try {
      const res = await parseVoice(w.a.eng1, { siteId: w.site1, transcript: "sand 5000", language: "en" });
      expect(res.extractor).toBe("rules");
      expect(res.notice).toMatch(/unavailable/);
      expect(res.entries[0].amount).toBe("5000");
    } finally {
      await withdrawVoiceConsent(w.a.eng1);
    }
  });
});

describe("voice consent", () => {
  it("is recorded and withdrawn for the actor only", async () => {
    expect((await getVoiceSetup(w.a.eng2)).consentedAt).toBeNull();
    expect((await recordVoiceConsent(w.a.eng2)).consentedAt).not.toBeNull();
    expect((await getVoiceSetup(w.a.eng1)).consentedAt).toBeNull();
    expect((await withdrawVoiceConsent(w.a.eng2)).consentedAt).toBeNull();
  });
});

describe("voice review", () => {
  it("lists open questions and computes the total on the server", async () => {
    const { entries } = await parseVoice(w.a.eng1, { siteId: w.site1, transcript: EXAMPLE, language: "en" });
    const res = await reviewVoice(w.a.eng1, { language: "en", extractor: "rules", spoken: true, entries });
    expect(res.total).toBe("14800");
    expect(res.ready).toBe(false);
    expect(res.issues.map((list) => list.filter((i) => i.level === "error").map((i) => i.field))).toEqual([
      ["paymentMode"],
      ["paymentMode"],
      ["paymentMode"],
      ["paymentMode"],
    ]);
  });

  it("flags repeats inside one list", async () => {
    const [cement] = await exampleDrafts();
    const res = await reviewVoice(w.a.eng1, { language: "en", extractor: "rules", spoken: true, entries: [cement, { ...cement, key: "again" }] });
    expect(res.duplicates).toEqual([{ index: 1, kind: "batch", otherIndex: 0 }]);
  });
});

describe("voice save", () => {
  it("refuses entries with open questions and saves nothing", async () => {
    const { entries } = await parseVoice(w.a.eng1, { siteId: w.site1, transcript: EXAMPLE, language: "en" });
    const before = await count(w.site1);
    const key = crypto.randomUUID();
    const err = await save(entries, { clientKey: key }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.fieldErrors["entries.0.paymentMode"]).toMatch(/How was this paid/);
    expect(await count(w.site1)).toBe(before);
    // The failed attempt leaves no batch behind, so the same review can be fixed and saved.
    expect(await db.select().from(voiceBatches).where(eq(voiceBatches.clientKey, key))).toEqual([]);
  });

  it("saves confirmed entries together, with totals from the server", async () => {
    const entries = await exampleDrafts("Site One, 20 bags cement, 8,000 rupees. Sand 5,000. Anu labour 1,000 and Akhil labour 800 on 19/10.");
    const res = await save(entries);
    expect(res.replayed).toBe(false);
    expect(res.total).toBe("14800");
    expect(res.expenses.map((e) => [e.description, e.amount, e.worker ?? null, e.paymentMode, e.source])).toEqual([
      ["Cement", 8000, null, "cash", "voice"],
      ["Sand", 5000, null, "cash", "voice"],
      ["Labour wages", 1000, "Anu", "cash", "voice"],
      ["Labour wages", 800, "Akhil", "cash", "voice"],
    ]);
    expect(res.expenses[0].items).toEqual([{ description: "Cement", quantity: "20.000", unit: "bags", unitPrice: "400.00", amount: "8000.00" }]);
    expect(res.expenses[3].date).toBe("2026-10-19");
    const [row] = await db.select({ t: expenses.voiceTranscript }).from(expenses).where(eq(expenses.id, res.expenses[0].id));
    expect(row.t).toBe(EXAMPLE);
    expect(await db.select().from(labourWorkers).where(and(eq(labourWorkers.organizationId, w.a.eng1.orgId), eq(labourWorkers.name, "Akhil")))).toHaveLength(1);
  });

  it("saves typed entries as manual, without a voice transcript", async () => {
    const [tiles] = await exampleDrafts("tiles 4321 for the bathroom");
    const res = await save([tiles], { spoken: false });
    expect(res.expenses[0].source).toBe("manual");
    const [row] = await db.select({ t: expenses.voiceTranscript }).from(expenses).where(eq(expenses.id, res.expenses[0].id));
    expect(row.t).toBeNull();
  });

  it("never saves the same review twice", async () => {
    const entries = await exampleDrafts("paint 3456");
    const clientKey = crypto.randomUUID();
    const before = await count(w.site1);
    // A double tap: both requests race.
    const [a, b] = await Promise.all([save(entries, { clientKey }), save(entries, { clientKey })]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(b.expenses.map((e) => e.id)).toEqual(a.expenses.map((e) => e.id));
    // A retry after a dropped connection.
    const c = await save(entries, { clientKey });
    expect(c.replayed).toBe(true);
    expect(c.total).toBe("3456");
    expect(await count(w.site1)).toBe(before + 1);
    // The same key can't be reused for different entries.
    await expect(save([{ ...entries[0], amount: "999" }], { clientKey })).rejects.toBeInstanceOf(ValidationError);
  });

  it("asks before saving a likely duplicate of a saved expense", async () => {
    const entries = await exampleDrafts("diesel 1950");
    await save(entries);
    const again = await exampleDrafts("diesel 1950");
    const review = await reviewVoice(w.a.eng1, { language: "en", extractor: "rules", spoken: true, entries: again });
    expect(review.duplicates).toEqual([expect.objectContaining({ index: 0, kind: "saved", description: "Diesel", amount: "1950", enteredBy: "Engineer One" })]);

    const before = await count(w.site1);
    await expect(save(again)).rejects.toBeInstanceOf(ValidationError);
    expect(await count(w.site1)).toBe(before);
    const res = await save(again, { acknowledgedDuplicates: [0] });
    expect(res.expenses).toHaveLength(1);
    expect(await count(w.site1)).toBe(before + 1);
  });

  it("is all or nothing when one entry can't be saved", async () => {
    const [cement, sand] = await exampleDrafts("cement 1111, sand 2222");
    const before = await count(w.site1);
    // eng1 isn't on site 2, and can't add to a completed site.
    for (const siteId of [w.site2, closedSite, w.siteB]) {
      await expect(save([cement, { ...sand, siteId, siteConfirmed: true }])).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await count(w.site1)).toBe(before);
  });

  it("is refused for viewers and other organizations", async () => {
    const [sand] = await exampleDrafts("sand 2468");
    const body = { language: "en", extractor: "rules", spoken: true, entries: [sand], clientKey: crypto.randomUUID() };
    await expect(saveVoice(w.a.viewer, body)).rejects.toBeInstanceOf(ValidationError);
    await expect(saveVoice(w.b.owner, body)).rejects.toBeInstanceOf(ValidationError);
    expect(await db.select().from(voiceBatches).where(eq(voiceBatches.clientKey, body.clientKey))).toEqual([]);
  });

  it("rejects future dates, bad amounts and unconfirmed sites on the server", async () => {
    const [d] = await exampleDrafts("cement 1357");
    for (const bad of [{ date: "2026-10-21" }, { amount: "12.345" }, { amount: "0" }, { siteHeard: "Site Nine", siteConfirmed: false }, { category: null }]) {
      await expect(save([{ ...d, ...bad } as VoiceDraft])).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(save([{ ...d, category: "snacks" } as unknown as VoiceDraft])).rejects.toThrow();
  });

  it("stores the items so the database total matches what was confirmed", async () => {
    const [d] = await exampleDrafts("sand 3 loads 1000");
    const res = await save([d]);
    const items = await db.select().from(expenseItems).where(inArray(expenseItems.expenseId, [res.expenses[0].id]));
    // 1000 doesn't divide into 3 loads exactly, so it's one lot and the total stays ₹1,000.
    expect(items.map((i) => [i.description, i.quantity, i.unit, i.amount])).toEqual([["Sand, 3 loads", "1.000", "lot", "1000.00"]]);
    expect(res.total).toBe("1000");
  });
});

describe("voice entries for several workers", () => {
  it("save one labour payment per worker, refusing shares that don't add up", async () => {
    const { entries } = await parseVoice(w.a.eng1, { siteId: w.site1, transcript: "Anu and Akhil labour 1600 cash", language: "en" });
    expect(entries.map((e) => [e.worker, e.amount, e.shareTotal])).toEqual([
      ["Anu", null, "1600"],
      ["Akhil", null, "1600"],
    ]);
    const uneven = entries.map((e, i) => ({ ...e, amount: ["1100", "400"][i] }));
    await expect(save(uneven)).rejects.toBeInstanceOf(ValidationError);
    // (Not 1000 for Anu: an earlier test saved exactly that today, and it would be flagged as a duplicate.)
    const res = await save(entries.map((e, i) => ({ ...e, amount: ["1100", "500"][i] })));
    expect(res.total).toBe("1600");
    expect(res.expenses.map((e) => [e.worker, e.amount])).toEqual([
      ["Anu", 1100],
      ["Akhil", 500],
    ]);
  });

  it("save advances as advances", async () => {
    const [adv] = await exampleDrafts("Ravi advance 300");
    const res = await save([adv]);
    const [row] = await db.select({ kind: expenses.labourKind }).from(expenses).where(eq(expenses.id, res.expenses[0].id));
    expect(row.kind).toBe("advance");
  });
});
