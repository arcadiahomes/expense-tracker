import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { db } from "@/db";
import { expenses } from "@/db/schema";
import {
  createExpense,
  createExpenses,
  deleteExpense,
  getExpense,
  listExpenses,
  restoreExpense,
  updateExpense,
} from "@/server/data/expenses";
import { getSite } from "@/server/data/sites";
import { ValidationError } from "@/server/errors";
import { addExpense, expense, world } from "./fixtures";

let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => {
  w = await world();
});

const storedTotal = async (id: string) =>
  (await db.select({ t: expenses.totalAmount }).from(expenses).where(eq(expenses.id, id)))[0].t;

describe("expense totals", () => {
  it("sum line items exactly in the database", async () => {
    const e = await createExpense(
      w.a.eng1,
      expense(w.site1, {
        items: [
          { description: "A", quantity: "1", unit: "nos", unitPrice: "0.10" },
          { description: "B", quantity: "1", unit: "nos", unitPrice: "0.20" },
        ],
      }),
    );
    expect(await storedTotal(e.id)).toBe("0.30");
    expect(e.items.map((i) => i.amount)).toEqual(["0.10", "0.20"]);
  });

  it("round quantity × unit price to paise", async () => {
    const e = await addExpense(w.a.eng1, w.site1, {
      items: [{ description: "Sand", quantity: "1.333", unit: "loads", unitPrice: "3.00" }],
    });
    expect(await storedTotal(e.id)).toBe("4.00");
    expect(e.quantity).toBe("1.333 loads");
  });

  it("ignore any total sent by the client", async () => {
    const e = await createExpense(w.a.eng1, { ...expense(w.site1), totalAmount: "999999" } as never);
    expect(await storedTotal(e.id)).toBe("100.00");
  });
});

describe("expense validation", () => {
  it("rejects future dates", async () => {
    await expect(addExpense(w.a.eng1, w.site1, { expenseDate: "2026-10-21" })).rejects.toBeInstanceOf(ValidationError);
  });
  it("rejects negative prices and more than 2 decimals", async () => {
    await expect(
      addExpense(w.a.eng1, w.site1, { items: [{ description: "x", quantity: "1", unitPrice: "-5" }] }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      addExpense(w.a.eng1, w.site1, { items: [{ description: "x", quantity: "1", unitPrice: "1.005" }] }),
    ).rejects.toBeInstanceOf(ZodError);
  });
  it("rejects a zero total and unknown categories", async () => {
    await expect(
      addExpense(w.a.eng1, w.site1, { items: [{ description: "x", quantity: "1", unitPrice: "0" }] }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(addExpense(w.a.eng1, w.site1, { categoryCode: "snacks" })).rejects.toBeInstanceOf(ZodError);
  });
});

describe("expense CRUD", () => {
  it("updates replace items and recompute the total", async () => {
    const e = await addExpense(w.a.eng1, w.site1);
    const updated = await updateExpense(w.a.eng1, {
      ...expense(w.site1, { description: "Steel" }),
      id: e.id,
      items: [
        { description: "TMT 12mm", quantity: "2", unit: "t", unitPrice: "61000" },
        { description: "Binding wire", quantity: "5", unit: "kg", unitPrice: "80.50" },
      ],
    });
    expect(updated.description).toBe("Steel");
    expect(updated.items).toHaveLength(2);
    expect(await storedTotal(e.id)).toBe("122402.50");
  });

  it("soft delete hides the expense from lists and totals, restore brings it back", async () => {
    const before = (await getSite(w.a.owner, w.site2)).summary.spent;
    const e = await addExpense(w.a.eng2, w.site2, {
      items: [{ description: "Diesel", quantity: "20", unit: "L", unitPrice: "95" }],
    });
    expect((await getSite(w.a.owner, w.site2)).summary.spent).toBe(before + 1900);

    await deleteExpense(w.a.eng2, e.id);
    await expect(getExpense(w.a.eng2, e.id)).rejects.toThrow();
    const listed = await listExpenses(w.a.eng2, { siteId: w.site2, limit: 100 });
    expect(listed.items.some((x) => x.id === e.id)).toBe(false);
    expect((await getSite(w.a.owner, w.site2)).summary.spent).toBe(before);

    await restoreExpense(w.a.eng2, e.id);
    expect((await getSite(w.a.owner, w.site2)).summary.spent).toBe(before + 1900);
  });

  it("voice batches save all entries or none", async () => {
    const good = expense(w.site1, { source: "voice", voiceTranscript: "cement 100" });
    const bad = expense(w.site1, { expenseDate: "2030-01-01" });
    const countBefore = (await listExpenses(w.a.owner, { siteId: w.site1, limit: 100 })).items.length;
    await expect(createExpenses(w.a.eng1, { expenses: [good, bad] })).rejects.toThrow();
    expect((await listExpenses(w.a.owner, { siteId: w.site1, limit: 100 })).items.length).toBe(countBefore);

    const saved = await createExpenses(w.a.eng1, { expenses: [good, good] });
    expect(saved).toHaveLength(2);
    expect(saved.every((e) => e.source === "voice" && e.viaVoice)).toBe(true);
  });
});

describe("listing", () => {
  it("keyset pagination returns every row once, in order", async () => {
    // One batch keeps round trips to a remote test database low; many rows share a date
    // and a created_at, which is exactly what the keyset tiebreakers must handle.
    const batch = await createExpenses(w.a.owner, {
      expenses: Array.from({ length: 23 }, (_, i) =>
        expense(w.site2, { expenseDate: i % 2 ? "2026-09-01" : "2026-09-02", description: `Page test ${i}` }),
      ),
    });
    const created = new Set(batch.map((e) => e.id));
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listExpenses(w.a.owner, { siteId: w.site2, q: "Page test", limit: 5, cursor });
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    expect(pages).toBe(5);
    expect(seen).toHaveLength(23);
    expect(new Set(seen)).toEqual(created);
  });

  it("amount sort pages correctly", async () => {
    const all: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await listExpenses(w.a.owner, { siteId: w.site2, sort: "amount_desc", limit: 4, cursor });
      all.push(...page.items.map((e) => e.amount));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(all).toEqual([...all].sort((x, y) => y - x));
  });

  it("filters by category, dates, supplier, worker, payment method and text", async () => {
    await addExpense(w.a.eng1, w.site1, {
      categoryCode: "labour",
      description: "Mason gang wage",
      workerName: "Raju (mason)",
      expenseDate: "2026-10-05",
    });
    await addExpense(w.a.eng1, w.site1, {
      categoryCode: "transport",
      description: "Tipper lorry",
      supplierName: "Anand Transport",
      paymentMethod: "upi",
      expenseDate: "2026-10-06",
    });
    const q = (f: Record<string, unknown>) => listExpenses(w.a.eng1, { siteId: w.site1, limit: 100, ...f });

    expect((await q({ categoryCode: "labour" })).items.every((e) => e.category === "labour")).toBe(true);
    expect((await q({ workerName: "Raju (mason)" })).items.map((e) => e.description)).toEqual(["Mason gang wage"]);
    expect((await q({ supplierName: "Anand Transport" })).items.map((e) => e.description)).toEqual(["Tipper lorry"]);
    expect((await q({ paymentMethod: "upi" })).items.every((e) => e.paymentMode === "upi")).toBe(true);
    expect((await q({ from: "2026-10-06", to: "2026-10-06" })).items.map((e) => e.description)).toEqual(["Tipper lorry"]);
    expect((await q({ q: "lorry" })).items).toHaveLength(1);
    // LIKE wildcards in search text are treated literally.
    expect((await q({ q: "%" })).items).toHaveLength(0);
  });
});
