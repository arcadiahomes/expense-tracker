import { beforeAll, describe, expect, it } from "vitest";
import { getDashboard } from "@/server/data/dashboard";
import { getReport } from "@/server/data/reports";
import { addExpense, world } from "./fixtures";

// APP_TODAY is 2026-10-20 (a Tuesday): week starts Mon 19 Oct, month starts 1 Oct.
let w: Awaited<ReturnType<typeof world>>;

const at = (date: string, amount: string, categoryCode = "materials") => ({
  expenseDate: date,
  categoryCode,
  items: [{ description: "x", quantity: "1", unit: "nos", unitPrice: amount }],
});

beforeAll(async () => {
  w = await world();
  const add = (date: string, amount: string, cat?: string) => addExpense(w.a.owner, w.site2, at(date, amount, cat));
  await add("2026-10-20", "100.10");
  await add("2026-10-20", "200.20", "labour");
  await add("2026-10-19", "50.00");
  await add("2026-10-13", "70.00", "transport"); // last week, same weekday-or-earlier as today
  await add("2026-10-02", "1000.00", "equipment");
  await add("2026-09-15", "500.00");
  await add("2026-09-25", "999.00"); // last month, after the same day of month
});

describe("dashboard totals", () => {
  it("period totals match hand-computed sums", async () => {
    const d = await getDashboard(w.a.owner);
    expect(d.today).toBe("2026-10-20");
    expect(d.totals.today).toBeCloseTo(300.3, 2);
    expect(d.totals.yesterday).toBe(50);
    expect(d.totals.week).toBeCloseTo(350.3, 2);
    expect(d.totals.lastWeekToDate).toBe(70);
    expect(d.totals.month).toBeCloseTo(1420.3, 2);
    expect(d.totals.lastMonthToDate).toBe(500);
  });

  it("daily, weekly and monthly trends bucket by category", async () => {
    const d = await getDashboard(w.a.owner);
    const todayBucket = d.trends.daily.at(-1)!;
    expect(todayBucket.key).toBe("2026-10-20");
    expect(todayBucket.materials).toBeCloseTo(100.1, 2);
    expect(todayBucket.labour).toBeCloseTo(200.2, 2);
    expect(d.trends.daily).toHaveLength(14);
    expect(d.trends.weekly.at(-1)!.key).toBe("2026-10-19");
    expect(d.trends.weekly.at(-1)!.total).toBeCloseTo(350.3, 2);
    expect(d.trends.monthly.at(-1)!.key).toBe("2026-10");
    expect(d.trends.monthly.at(-2)!.total).toBe(1499);
  });

  it("category split and site summary come from stored records", async () => {
    const d = await getDashboard(w.a.owner);
    const cat = Object.fromEntries(d.categories.map((c) => [c.category, c.amount]));
    expect(cat.equipment).toBe(1000);
    expect(cat.transport).toBe(70);
    const site2 = d.sites.find((s) => s.site.id === w.site2)!;
    expect(site2.spent).toBeCloseTo(2919.3, 2);
    expect(site2.balance).toBeCloseTo(50000 - 2919.3, 2);
  });

  it("reports summarise the same records", async () => {
    const r = await getReport(w.a.owner, { from: "2026-10-01", to: "2026-10-20", siteId: w.site2 });
    expect(r.summary.total).toBeCloseTo(1420.3, 2);
    expect(r.summary.count).toBe(5);
    expect(r.summary.topCategory).toBe("equipment");
    expect(r.summary.avgPerDay).toBeCloseTo(71.02, 2);
  });
});
