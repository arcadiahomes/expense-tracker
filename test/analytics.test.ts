import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getAnalytics } from "@/server/data/analytics";
import { createBill, recordPayment } from "@/server/data/bills";
import { removeBudget, upsertBudget } from "@/server/data/budgets";
import { createExpense, deleteExpense } from "@/server/data/expenses";
import { createWorker, recordAttendance, recordLabourPayment } from "@/server/data/labour";
import { createMaterial, recordPurchase, recordUsage } from "@/server/data/materials";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { expense, world } from "./fixtures";

/**
 * Sample records with known amounts (APP_TODAY is 2026-10-20, a Tuesday; the week starts Monday the 19th).
 * Every dashboard figure below is checked against a sum worked out by hand from these.
 *
 * Site 1 (budget 100000):
 *   2026-10-20  other      manual     1000   "Tea and snacks"
 *   2026-10-19  materials  purchase   8000   cement 20 bags × 400, paid by UPI
 *   2026-10-05  transport  manual     2500   lorry
 *   2026-09-28  equipment  manual     3000   JCB (last month)
 *   2026-10-20  materials  bill pay   6000   against a 15000 credit purchase (9000 still owed)
 *   2026-10-20  labour     wage        900   Anu (earned 900 + 900 = 1800, so 900 owed)
 *   2026-10-20  labour     advance     500   Ravi (earned 0, so 500 advance outstanding)
 *   deleted     other      manual    99999   must never count
 *   usage of 12 bags: moves stock only, never money
 * Site 2 (budget 50000):
 *   2026-10-20  transport  manual     4000   Pune lorry
 *   bill 2500 from the same supplier, unpaid
 */
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => {
  w = await world();
  const s1 = w.site1;
  const exp = (date: string, categoryCode: string, amount: string, description: string, siteId = s1) =>
    createExpense(w.a.owner, expense(siteId, { expenseDate: date, categoryCode, description, items: [{ description, unitPrice: amount }] }));

  await exp("2026-10-20", "other", "1000", "Tea and snacks");
  await exp("2026-10-05", "transport", "2500", "Lorry hire");
  await exp("2026-09-28", "equipment", "3000", "JCB hire");
  await exp("2026-10-20", "transport", "4000", "Pune lorry", w.site2);
  const gone = await exp("2026-10-20", "other", "99999", "Mistake");
  await deleteExpense(w.a.owner, gone.id);

  const cement = await createMaterial(w.a.owner, { name: "Cement", unit: "bags" });
  await recordPurchase(w.a.owner, { siteId: s1, purchaseDate: "2026-10-19", paymentMethod: "upi", items: [{ materialId: cement.id, quantity: "20", unitPrice: "400" }] });
  await recordUsage(w.a.owner, { siteId: s1, materialId: cement.id, usedOn: "2026-10-20", quantity: "12" });
  const credit = await recordPurchase(w.a.owner, {
    siteId: s1,
    supplierName: "Kerala Steels",
    invoiceNumber: "KS-1",
    purchaseDate: "2026-10-01",
    dueDate: "2026-10-15",
    paymentMethod: "credit",
    items: [{ materialId: cement.id, quantity: "30", unitPrice: "500" }],
  });
  await recordPayment(w.a.owner, { billId: credit.bill!.id, amount: "6000", paidOn: "2026-10-20", method: "bank" });
  await createBill(w.a.owner, { siteId: w.site2, supplierName: "Kerala Steels", billNumber: "KS-2", billDate: "2026-10-18", dueDate: "2026-11-18", amount: "2500" });

  const anu = await createWorker(w.a.owner, { name: "Anu", dailyWage: "900" });
  const ravi = await createWorker(w.a.owner, { name: "Ravi", dailyWage: "700" });
  await recordAttendance(w.a.owner, { siteId: s1, workerId: anu.id, workDate: "2026-10-19", status: "present" });
  await recordAttendance(w.a.owner, { siteId: s1, workerId: anu.id, workDate: "2026-10-20", status: "present" });
  await recordLabourPayment(w.a.owner, { siteId: s1, workerId: anu.id, kind: "wage", amount: "900", paidOn: "2026-10-20", method: "cash" });
  await recordLabourPayment(w.a.owner, { siteId: s1, workerId: ravi.id, kind: "advance", amount: "500", paidOn: "2026-10-20", method: "cash" });

  await upsertBudget(w.a.owner, { siteId: s1, categoryCode: "materials", amount: "15000", alertPercent: 75 });
  await upsertBudget(w.a.owner, { siteId: s1, categoryCode: "transport", amount: "10000", alertPercent: 50 });
  await upsertBudget(w.a.owner, { siteId: s1, categoryCode: "labour", amount: "5000" });
}, 600_000); // many sequential round trips to the remote test database

const site1 = () => getAnalytics(w.a.owner, { siteId: w.site1 });

describe("period totals", () => {
  it("match the sample records for today, this week and this month", async () => {
    const a = await site1();
    // Today: 1000 + 6000 + 900 + 500. Week adds the 8000 purchase on Monday. Month adds the 2500 lorry.
    expect(a.totals).toMatchObject({ today: "8400.00", week: "16400.00", month: "18900.00", range: "18900.00", rangeCount: 6 });
  });

  it("follow a custom range and include every site the user can see", async () => {
    const sept = await getAnalytics(w.a.owner, { from: "2026-09-01", to: "2026-09-30" });
    expect([sept.totals.range, sept.totals.rangeCount]).toEqual(["3000.00", 1]);
    const all = await getAnalytics(w.a.owner, { from: "2026-09-01", to: "2026-10-20" });
    expect(all.totals.range).toBe("25900.00"); // 18900 + 3000 on site 1, 4000 on site 2
  });

  it("reject impossible ranges", async () => {
    await expect(getAnalytics(w.a.owner, { from: "2026-10-10", to: "2026-10-01" })).rejects.toBeInstanceOf(ZodError);
    await expect(getAnalytics(w.a.owner, { to: "2026-10-21" })).rejects.toBeInstanceOf(ValidationError);
    await expect(getAnalytics(w.a.owner, { from: "2020-01-01", to: "2026-10-20" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("spent, committed and payments", () => {
  it("split this month's spending into kinds that add up to the total", async () => {
    const a = await site1();
    expect(Object.fromEntries(a.spendKinds.map((k) => [k.kind, k.amount]))).toEqual({
      bill_payments: "6000.00",
      purchases: "8000.00",
      wages: "900.00",
      advances: "500.00",
      other: "3500.00", // tea 1000 + lorry 2500
    });
    const sum = a.spendKinds.reduce((t, k) => t + Number(k.amount), 0);
    expect(sum).toBe(Number(a.totals.range));
  });

  it("count only the unpaid part of bills and wages as committed", async () => {
    const a = await site1();
    // Bill 15000 − 6000 paid = 9000 owed; Anu earned 1800 − 900 paid = 900 owed; Ravi's 500 advance isn't owed.
    expect(a.commitments).toEqual({ supplierOutstanding: "9000.00", supplierOverdue: "9000.00", unpaidWages: "900.00", total: "9900.00", advancesOutstanding: "500.00" });
    const all = await getAnalytics(w.a.owner);
    expect(all.commitments.supplierOutstanding).toBe("11500.00");
    expect(all.suppliersOwed).toEqual([{ supplierId: expect.any(String), supplier: "Kerala Steels", amount: "11500.00", overdue: "9000.00", openBills: 2 }]);
    expect(all.workersOwed.map((x) => [x.worker, x.amount])).toEqual([["Anu", "900.00"]]);
  });
});

describe("breakdowns and comparisons", () => {
  it("rank categories by spend with their share", async () => {
    const a = await site1();
    expect(a.topCategories.map((c) => [c.category, c.amount])).toEqual([
      ["materials", "14000.00"],
      ["transport", "2500.00"],
      ["labour", "1400.00"],
      ["other", "1000.00"],
    ]);
    expect(a.topCategories[0].share).toBeCloseTo(14000 / 18900, 6);
    expect(a.byCategory.find((c) => c.category === "equipment")?.amount).toBe("0");
  });

  it("compare sites on spend, commitments, budget and remaining balance", async () => {
    const { sites } = await getAnalytics(w.a.owner);
    const one = sites.find((s) => s.siteId === w.site1)!;
    // All-time spend on site 1: 18900 this month + 3000 in September.
    expect(one).toMatchObject({ budget: "100000.00", spent: "21900.00", rangeSpent: "18900.00", committed: "9900.00", remaining: "78100.00", remainingAfterCommitments: "68200.00" });
    expect(one.utilisation).toBeCloseTo(0.219, 6);
    const two = sites.find((s) => s.siteId === w.site2)!;
    expect(two).toMatchObject({ spent: "4000.00", committed: "2500.00", remaining: "46000.00" });
  });
});

describe("budgets and alerts", () => {
  it("measure each line and alert at its own threshold", async () => {
    const a = await site1();
    const line = (c: string | null) => a.budgetLines.find((l) => l.category === c)!;
    expect(line(null)).toMatchObject({ budget: "100000.00", spent: "21900.00", remaining: "78100.00", level: "ok", alertPercent: 80 });
    // Materials 14000 of 15000 = 93%, past its 75% alert, with the 9000 bill still committed.
    expect(line("materials")).toMatchObject({ spent: "14000.00", committed: "9000.00", remaining: "1000.00", level: "warning" });
    // Transport 2500 of 10000 = 25%, under its 50% alert.
    expect(line("transport").level).toBe("ok");
    // Labour 1400 of 5000, with Anu's 900 wages committed.
    expect(line("labour")).toMatchObject({ spent: "1400.00", committed: "900.00", level: "ok" });
    expect(a.alerts.map((x) => [x.category, x.level])).toEqual([["materials", "warning"]]);
  });

  it("raise an over-budget alert first, and stop alerting when a line is removed", async () => {
    await upsertBudget(w.a.owner, { siteId: w.site1, categoryCode: "other", amount: "500", alertPercent: 90 });
    let a = await site1();
    expect(a.alerts.map((x) => [x.category, x.level])).toEqual([
      ["other", "over"],
      ["materials", "warning"],
    ]);
    await removeBudget(w.a.owner, { siteId: w.site1, categoryCode: "other" });
    a = await site1();
    expect(a.alerts.map((x) => x.category)).toEqual(["materials"]);
  });

  it("are set only by owners and accountants, with a valid threshold", async () => {
    await expect(upsertBudget(w.a.eng1, { siteId: w.site1, categoryCode: "other", amount: "1" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(upsertBudget(w.a.accountant, { siteId: w.site1, categoryCode: "other", amount: "1", alertPercent: 0 })).rejects.toBeInstanceOf(ZodError);
    await expect(upsertBudget(w.a.accountant, { siteId: w.site1, categoryCode: "other", amount: "1", alertPercent: 101 })).rejects.toBeInstanceOf(ZodError);
    await expect(upsertBudget(w.b.owner, { siteId: w.site1, amount: "1" })).rejects.toBeInstanceOf(NotFoundError);
    const lines = await upsertBudget(w.a.accountant, { siteId: w.site1, amount: "120000", alertPercent: 90 });
    expect(lines.find((l) => l.category === null)).toMatchObject({ amount: 120000, alertPercent: 90 });
    // The total line is the site's headline budget, so comparisons follow it.
    const one = (await getAnalytics(w.a.owner)).sites.find((s) => s.siteId === w.site1)!;
    expect([one.budget, one.alertPercent]).toEqual(["120000.00", 90]);
  });
});

describe("access", () => {
  it("only aggregates sites the user can see", async () => {
    // eng2 is only on site 2: none of site 1's money is visible.
    const eng2 = await getAnalytics(w.a.eng2);
    expect([eng2.totals.month, eng2.commitments.supplierOutstanding, Number(eng2.commitments.unpaidWages)]).toEqual(["4000.00", "2500.00", 0]);
    expect(eng2.sites.map((s) => s.siteId)).toEqual([w.site2]);
    expect(eng2.recent.every((e) => e.siteId === w.site2)).toBe(true);
    await expect(getAnalytics(w.a.eng2, { siteId: w.site1 })).rejects.toBeInstanceOf(NotFoundError);
    // Another organization sees nothing of this one.
    const other = await getAnalytics(w.b.owner);
    expect([Number(other.totals.month), Number(other.commitments.total), other.sites.some((s) => s.siteId === w.site1)]).toEqual([0, 0, false]);
  });

  it("returns zeros and empty lists for someone with no sites", async () => {
    const { newUser } = await import("./fixtures");
    const { createOrganization } = await import("@/server/data/organizations");
    const { loadActor } = await import("@/server/authz");
    const u = await newUser("Lonely Owner");
    await createOrganization(u.id, `Empty ${crypto.randomUUID().slice(0, 4)}`);
    const a = await getAnalytics(await loadActor(u.id));
    expect([Number(a.totals.range), Number(a.commitments.total), a.sites, a.alerts, a.recent, a.topCategories]).toEqual([0, 0, [], [], [], []]);
  });
});

describe("search and recent transactions", () => {
  it("lists this period's latest entries, newest first", async () => {
    const a = await site1();
    expect(a.recent.every((e) => e.date >= "2026-10-01")).toBe(true);
    expect(a.recent.some((e) => e.description === "Mistake")).toBe(false);
  });

  it("searches descriptions, suppliers and workers across all dates", async () => {
    const byDescription = await getAnalytics(w.a.owner, { q: "jcb" });
    expect(byDescription.recent.map((e) => e.description)).toEqual(["JCB hire"]);
    const bySupplier = await getAnalytics(w.a.owner, { q: "kerala" });
    expect(bySupplier.recent.map((e) => e.amount)).toEqual([6000]);
    const byWorker = await getAnalytics(w.a.owner, { q: "ravi" });
    expect(byWorker.recent.map((e) => [e.worker, e.amount])).toEqual([["Ravi", 500]]);
    // Search can't reach sites the user can't see.
    expect((await getAnalytics(w.a.eng2, { q: "jcb" })).recent).toEqual([]);
  });
});
