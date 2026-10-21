import { beforeAll, describe, expect, it } from "vitest";
import { getDashboard } from "@/server/data/dashboard";
import { deleteExpense, getExpense, listExpenses, updateExpense } from "@/server/data/expenses";
import { getReport } from "@/server/data/reports";
import { createSite, deleteSite, getSite, listSites, updateSite } from "@/server/data/sites";
import { upsertBudget } from "@/server/data/budgets";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { addExpense, expense, world } from "./fixtures";

let w: Awaited<ReturnType<typeof world>>;
let ownerExpenseOnSite1: string;
let eng1Expense: string;

beforeAll(async () => {
  w = await world();
  ownerExpenseOnSite1 = (await addExpense(w.a.owner, w.site1, { description: "Owner entry" })).id;
  eng1Expense = (await addExpense(w.a.eng1, w.site1, { description: "Eng1 entry" })).id;
  await addExpense(w.a.eng2, w.site2, { description: "Eng2 entry", items: [{ description: "x", quantity: "1", unitPrice: "777" }] });
  await addExpense(w.b.owner, w.siteB, { description: "Other org entry" });
});

describe("tenant isolation", () => {
  it("another organization can't read, list or write", async () => {
    await expect(getSite(w.b.owner, w.site1)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getExpense(w.b.owner, eng1Expense)).rejects.toBeInstanceOf(NotFoundError);
    await expect(addExpense(w.b.owner, w.site1)).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteExpense(w.b.owner, eng1Expense)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listExpenses(w.b.owner, { siteId: w.site1 })).rejects.toBeInstanceOf(NotFoundError);
    const own = await listExpenses(w.b.owner, { limit: 100 });
    expect(own.items.every((e) => e.siteId === w.siteB)).toBe(true);
    expect((await listSites(w.b.owner)).map((s) => s.site.id)).toEqual([w.siteB]);
  });

  it("aggregates never include sites the user can't see", async () => {
    const eng2Dash = await getDashboard(w.a.eng2);
    expect(eng2Dash.sites.map((s) => s.site.id)).toEqual([w.site2]);
    expect(eng2Dash.totals.today).toBe(777);
    expect(eng2Dash.recent.every((e) => e.siteId === w.site2)).toBe(true);

    const report = await getReport(w.a.eng2, { from: "2026-10-01", to: "2026-10-20" });
    expect(report.bySite.map((s) => s.siteId)).toEqual([w.site2]);
    expect(report.summary.total).toBe(777);
  });
});

describe("site roles", () => {
  it("viewers can read but not write", async () => {
    await expect(getSite(w.a.viewer, w.site1)).resolves.toBeTruthy();
    expect((await listExpenses(w.a.viewer, { siteId: w.site1 })).items.length).toBeGreaterThan(0);
    await expect(addExpense(w.a.viewer, w.site1)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteExpense(w.a.viewer, eng1Expense)).rejects.toBeInstanceOf(ForbiddenError);
    const listed = await listExpenses(w.a.viewer, { siteId: w.site1 });
    expect(listed.items.every((e) => !e.canEdit)).toBe(true);
  });

  it("engineers only see their own sites", async () => {
    await expect(getSite(w.a.eng2, w.site1)).rejects.toBeInstanceOf(NotFoundError);
    await expect(addExpense(w.a.eng2, w.site1)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("engineers can edit their own expenses but not someone else's", async () => {
    await expect(
      updateExpense(w.a.eng1, { ...expense(w.site1, { description: "Changed" }), id: eng1Expense }),
    ).resolves.toMatchObject({ description: "Changed" });
    await expect(
      updateExpense(w.a.eng1, { ...expense(w.site1), id: ownerExpenseOnSite1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteExpense(w.a.eng1, ownerExpenseOnSite1)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("engineers can't move an expense to a site they don't belong to", async () => {
    await expect(
      updateExpense(w.a.eng1, { ...expense(w.site2), id: eng1Expense }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("only owners change budgets and site details", async () => {
    await expect(upsertBudget(w.a.eng1, { siteId: w.site1, amount: "1" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      updateSite(w.a.eng1, { id: w.site1, name: "x", location: "y", budget: "1", startDate: "2026-01-01" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(upsertBudget(w.a.owner, { siteId: w.site1, amount: "250000" })).resolves.toBeTruthy();
    expect((await getSite(w.a.owner, w.site1)).summary.site.budget).toBe(250000);
  });

  it("only org owners and admins create or delete sites", async () => {
    await expect(
      createSite(w.a.eng1, { name: "Rogue", location: "x", budget: "1", startDate: "2026-01-01" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteSite(w.a.eng1, w.site1)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteSite(w.b.owner, w.site1)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("org owners see and manage every site in their org", async () => {
    const ids = (await listSites(w.a.owner)).map((s) => s.site.id).sort();
    expect(ids).toEqual([w.site1, w.site2].sort());
    expect((await listSites(w.a.owner)).every((s) => s.site.role === "owner")).toBe(true);
  });

  it("each site keeps an independent budget", async () => {
    await upsertBudget(w.a.owner, { siteId: w.site2, amount: "12345.67" });
    expect((await getSite(w.a.owner, w.site2)).summary.site.budget).toBe(12345.67);
    expect((await getSite(w.a.owner, w.site1)).summary.site.budget).toBe(250000);
  });
});
