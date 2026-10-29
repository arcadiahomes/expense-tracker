import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { auditLog, labourAttendance } from "@/db/schema";
import { createExpense, deleteExpense } from "@/server/data/expenses";
import {
  createWorker,
  labourBalances,
  labourTotals,
  recordAttendance,
  recordAttendanceBatch,
  recordLabourPayment,
  updateWorker,
  workerLedger,
  workerPayments,
  workerSiteTotals,
} from "@/server/data/labour";
import { createSite } from "@/server/data/sites";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { expense, world } from "./fixtures";

let w: Awaited<ReturnType<typeof world>>;
let site: string;
let anu: string;
let akhil: string;
beforeAll(async () => {
  w = await world();
  // A fresh site so balances start at zero.
  site = (await createSite(w.a.owner, { name: "Labour Site", location: "Kochi", budget: "500000", startDate: "2026-01-01" })).site.id;
  anu = (await createWorker(w.a.owner, { name: "Anu", trade: "Mason", dailyWage: "900" })).id;
  akhil = (await createWorker(w.a.owner, { name: "Akhil", trade: "Helper", dailyWage: "800" })).id;
});

const balance = async (workerId: string, siteId = site) =>
  (await labourBalances(w.a.owner, siteId)).workers.find((b) => b.workerId === workerId)!;
const labourSpend = async (siteId: string) =>
  (
    (await db.execute(sql`
      select coalesce(sum(e.total_amount), 0)::text as t from expenses e join expense_categories c on c.id = e.category_id
      where e.site_id = ${siteId} and e.deleted_at is null and c.code = 'labour'
    `)) as unknown as { t: string }[]
  )[0].t;

describe("attendance", () => {
  it("prices each day on the server from the rate, ignoring any wage sent", async () => {
    const rows = await recordAttendanceBatch(w.a.owner, {
      siteId: site,
      workDate: "2026-10-19",
      entries: [
        { workerId: anu, status: "present", wageAmount: "99999" },
        { workerId: akhil, status: "half_day", workType: "Shuttering" },
      ],
    });
    expect(rows.map((r) => [r.status, r.dayRate, r.wageAmount, r.workType])).toEqual([
      ["present", "900.00", "900.00", "Mason"],
      ["half_day", "800.00", "400.00", "Shuttering"],
    ]);
  });

  it("replaces a day when it's marked again, and records the change", async () => {
    await recordAttendance(w.a.owner, { siteId: site, workerId: akhil, workDate: "2026-10-19", status: "present", dayRate: "850" });
    const rows = await db.select().from(labourAttendance).where(and(eq(labourAttendance.siteId, site), eq(labourAttendance.workerId, akhil)));
    expect(rows.map((r) => r.wageAmount)).toEqual(["850.00"]);
    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, rows[0].id));
    expect(audit.map((a) => a.action).sort()).toEqual(["attendance.create", "attendance.update"]);
  });

  it("needs a rate for paid days, refuses future dates and duplicate workers", async () => {
    const noRate = await createWorker(w.a.owner, { name: "Ravi" });
    await expect(recordAttendance(w.a.owner, { siteId: site, workerId: noRate.id, workDate: "2026-10-19", status: "present" })).rejects.toBeInstanceOf(ValidationError);
    await recordAttendance(w.a.owner, { siteId: site, workerId: noRate.id, workDate: "2026-10-19", status: "absent" });
    await expect(recordAttendance(w.a.owner, { siteId: site, workerId: anu, workDate: "2026-10-21", status: "present" })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      recordAttendanceBatch(w.a.owner, { siteId: site, workDate: "2026-10-19", entries: [{ workerId: anu }, { workerId: anu }] }),
    ).rejects.toThrow();
  });

  it("is limited by site role and organization", async () => {
    const day = { siteId: w.site1, workerId: anu, workDate: "2026-10-19", status: "present" };
    await expect(recordAttendance(w.a.viewer, day)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordAttendance(w.a.eng2, day)).rejects.toBeInstanceOf(NotFoundError);
    expect((await recordAttendance(w.a.eng1, day)).wageAmount).toBe("900.00");
    const outsider = await createWorker(w.b.owner, { name: "Outsider", dailyWage: "500" });
    await expect(recordAttendance(w.a.eng1, { ...day, workerId: outsider.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(labourBalances(w.a.eng2, w.site1)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("wages, advances and balances", () => {
  it("start as earned with nothing paid", async () => {
    const a = await balance(anu);
    expect([a.days, a.earned, a.wagesPaid, a.advances, a.unpaid]).toEqual(["1", "900.00", "0.00", "0.00", "900.00"]);
  });

  it("pays wages without needing attendance; credit isn't a payment method", async () => {
    const pay = { siteId: site, workerId: anu, paidOn: "2026-10-20", method: "cash" };
    expect((await recordLabourPayment(w.a.owner, { ...pay, kind: "wage", amount: "900" })).unpaid).toBe("0.00");
    const after = await recordLabourPayment(w.a.owner, { ...pay, kind: "advance", amount: "500" });
    expect([after.balance, after.unpaid, after.advanceOutstanding]).toEqual(["-500.00", "0.00", "500.00"]);
    await expect(recordLabourPayment(w.a.owner, { ...pay, kind: "advance", amount: "1", method: "credit" })).rejects.toThrow();
  });

  it("an advance is worked off by later attendance", async () => {
    await recordAttendance(w.a.owner, { siteId: site, workerId: anu, workDate: "2026-10-20", status: "present" });
    const a = await balance(anu);
    expect([a.earned, a.wagesPaid, a.advances, a.balance, a.unpaid]).toEqual(["1800.00", "900.00", "500.00", "400.00", "400.00"]);
  });

  it("counts every rupee once: only payments are spending, attendance never is", async () => {
    // A labour expense naming the worker (e.g. from voice entry) is a wage payment too.
    await createExpense(w.a.owner, expense(site, { categoryCode: "labour", description: "Labour", workerName: "Akhil", items: [{ description: "Akhil", unitPrice: "300" }] }));
    expect((await balance(akhil)).wagesPaid).toBe("300.00");
    expect(await labourSpend(site)).toBe("1700.00"); // 900 wages + 500 advance + 300
    const { totals } = await labourBalances(w.a.owner, site);
    expect(totals).toMatchObject({ earned: "2650.00", paid: "1700.00", unpaid: "950.00" });
    expect(Number(totals.advances)).toBe(0);
  });

  it("deleting a payment puts the amount back on the balance", async () => {
    const before = await balance(akhil);
    const res = await recordLabourPayment(w.a.owner, { siteId: site, workerId: akhil, kind: "wage", amount: "100", paidOn: "2026-10-20", method: "upi" });
    expect(Number(before.balance) - Number(res.balance)).toBe(100);
    await deleteExpense(w.a.owner, res.expenseId);
    expect((await balance(akhil)).balance).toBe(before.balance);
  });

  it("payments need the site permission", async () => {
    const pay = { siteId: w.site1, workerId: anu, kind: "advance", amount: "100", paidOn: "2026-10-20", method: "cash" };
    await expect(recordLabourPayment(w.a.viewer, pay)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordLabourPayment(w.a.eng2, pay)).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordLabourPayment(w.a.eng1, { ...pay, paidOn: "2026-10-21" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("the statement runs from attendance and payments to the balance", async () => {
    const { lines, worker } = await workerLedger(w.a.owner, site, anu);
    // Newest first; within a day, work is counted before the payments made that day.
    expect(lines.map((l) => l.kind)).toEqual([expect.any(String), expect.any(String), "attendance", "attendance"]);
    expect(lines.slice(0, 2).map((l) => [l.kind, l.amount]).sort()).toEqual([["advance", "-500.00"], ["wage", "-900.00"]]);
    expect(lines[0].balance).toBe("400.00");
    expect(lines.slice(2).map((l) => [l.date, l.amount, l.balance])).toEqual([
      ["2026-10-20", "900.00", "1800.00"],
      ["2026-10-19", "900.00", "900.00"],
    ]);
    expect(worker.balance).toBe("400.00");
  });
});

describe("workers", () => {
  it("are updated with an audit entry and unique names", async () => {
    await expect(updateWorker(w.a.owner, { id: anu, name: "Akhil" })).rejects.toBeInstanceOf(ValidationError);
    const updated = await updateWorker(w.a.owner, { id: anu, name: "Anu", trade: "Mason", dailyWage: "950" });
    expect(updated.dailyWage).toBe("950.00");
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.entityId, anu), eq(auditLog.action, "worker.update")));
    expect(audit).toHaveLength(1);
    await expect(updateWorker(w.a.viewer, { id: anu, name: "Anu" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateWorker(w.b.owner, { id: anu, name: "Anu" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("worker totals", () => {
  it("sum each worker's payments on the site, with no attendance needed", async () => {
    const s = (await createSite(w.a.owner, { name: "Totals Site", location: "Kochi", budget: "100000", startDate: "2026-01-01" })).site.id;
    const pay = { siteId: s, kind: "wage", method: "cash" };
    await recordLabourPayment(w.a.owner, { ...pay, workerId: anu, amount: "1500", paidOn: "2026-09-28" });
    await recordLabourPayment(w.a.owner, { ...pay, workerId: anu, amount: "700", paidOn: "2026-10-05" });
    await recordLabourPayment(w.a.owner, { ...pay, workerId: akhil, amount: "400", paidOn: "2026-10-06", note: "Shuttering" });
    const gone = await recordLabourPayment(w.a.owner, { ...pay, workerId: akhil, amount: "999", paidOn: "2026-10-06" });
    await deleteExpense(w.a.owner, gone.expenseId);

    const t = await labourTotals(w.a.owner, s);
    expect(t.totals).toEqual({ total: "2600.00", thisMonth: "1100.00", workers: 2 });
    const paid = t.workers.filter((x) => x.payments > 0).map((x) => [x.name, x.payments, x.total, x.thisMonth, x.lastPaid]);
    expect(paid).toEqual([
      ["Anu", 2, "2200.00", "700.00", "2026-10-05"],
      ["Akhil", 1, "400.00", "400.00", "2026-10-06"],
    ]);
    expect((await workerPayments(w.a.owner, s, akhil)).map((p) => [p.date, p.amount, p.note])).toEqual([["2026-10-06", "400.00", "Shuttering"]]);
    await expect(labourTotals(w.a.eng2, s)).rejects.toBeInstanceOf(NotFoundError);
    await expect(workerPayments(w.a.eng2, s, anu)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("count labour expenses with no worker in the site total, apart from the workers", async () => {
    const s = (await createSite(w.a.owner, { name: "Unnamed Labour Site", location: "Kochi", budget: "100000", startDate: "2026-01-01" })).site.id;
    await recordLabourPayment(w.a.owner, { siteId: s, kind: "wage", method: "cash", workerId: anu, amount: "500", paidOn: "2026-10-05" });
    await createExpense(w.a.owner, expense(s, { categoryCode: "labour", description: "Gang wages", expenseDate: "2026-10-07", items: [{ description: "Gang", unitPrice: "1200" }] }));
    await createExpense(w.a.owner, expense(s, { categoryCode: "labour", description: "Helpers", expenseDate: "2026-09-30", items: [{ description: "Helpers", unitPrice: "300" }] }));
    await createExpense(w.a.owner, expense(s, { expenseDate: "2026-10-07" }));

    const t = await labourTotals(w.a.owner, s);
    expect(t.totals).toEqual({ total: "2000.00", thisMonth: "1700.00", workers: 1 });
    expect(t.unassigned).toEqual({ payments: 2, total: "1500.00", thisMonth: "1200.00" });
    expect(t.workers.filter((x) => x.payments > 0).map((x) => [x.name, x.total])).toEqual([["Anu", "500.00"]]);
  });

  it("count an expense naming a worker in other case or spacing toward that worker", async () => {
    const s = (await createSite(w.a.owner, { name: "Name Match Site", location: "Kochi", budget: "100000", startDate: "2026-01-01" })).site.id;
    await recordLabourPayment(w.a.owner, { siteId: s, kind: "wage", method: "cash", workerId: anu, amount: "500", paidOn: "2026-10-05" });
    await createExpense(w.a.owner, expense(s, { categoryCode: "labour", description: "Wages", workerName: "  anu", items: [{ description: "Wages", unitPrice: "800" }] }));

    const t = await labourTotals(w.a.owner, s);
    expect(t.workers.filter((x) => x.payments > 0).map((x) => [x.name, x.payments, x.total])).toEqual([["Anu", 2, "1300.00"]]);
    expect(t.unassigned.payments).toBe(0);
  });

  it("add up one worker's payments on every readable site", async () => {
    const s1 = (await createSite(w.a.owner, { name: "Spread One", location: "Kochi", budget: "100000", startDate: "2026-01-01" })).site.id;
    const s2 = (await createSite(w.a.owner, { name: "Spread Two", location: "Kochi", budget: "100000", startDate: "2026-01-01" })).site.id;
    const pay = { kind: "wage", method: "cash", workerId: akhil };
    await recordLabourPayment(w.a.owner, { ...pay, siteId: s1, amount: "300", paidOn: "2026-10-01" });
    await recordLabourPayment(w.a.owner, { ...pay, siteId: s2, amount: "800", paidOn: "2026-10-02" });
    await recordLabourPayment(w.a.owner, { ...pay, siteId: s2, amount: "200", paidOn: "2026-10-03" });

    const bySite = (await workerSiteTotals(w.a.owner, akhil)).filter((r) => r.siteId === s1 || r.siteId === s2);
    expect(bySite.map((r) => [r.siteName, r.payments, r.total, r.lastPaid])).toEqual([
      ["Spread Two", 2, "1000.00", "2026-10-03"],
      ["Spread One", 1, "300.00", "2026-10-01"],
    ]);
    expect(await workerSiteTotals(w.b.owner, akhil)).toEqual([]);
  });
});
