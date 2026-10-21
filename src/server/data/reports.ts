import "server-only";
import { and, count, desc, eq, sql, sum } from "drizzle-orm";
import { db } from "@/db";
import { constructionSites, expenseCategories, expenses, labourWorkers, suppliers } from "@/db/schema";
import { daysBetween } from "@/lib/dates";
import { CATEGORIES, type Category, type Expense } from "@/lib/types";
import { scopeSiteIds, type Actor } from "../authz";
import { ForbiddenError, ValidationError } from "../errors";
import { reportFilters } from "../validation";
import { expenseConditions, listExpenses, pageExpenses } from "./expenses";
import { num } from "./shared";

/** Filtered report: summary, category and site breakdowns, and one page of rows. */
export async function getReport(actor: Actor, raw: unknown) {
  const f = reportFilters.parse(raw);
  if (f.from > f.to) throw new ValidationError("Start date is after the end date.", { from: "Pick a start on or before the end." });
  const siteIds = await scopeSiteIds(actor, f.siteId);
  const days = daysBetween(f.from, f.to) + 1;
  if (siteIds.length === 0) {
    return {
      filters: f,
      summary: { total: 0, count: 0, avgPerDay: 0, topCategory: null as Category | null },
      byCategory: CATEGORIES.map((category) => ({ category, amount: 0 })),
      bySite: [] as { siteId: string; name: string; count: number; amount: number }[],
      page: { items: [] as Expense[], nextCursor: null as string | null },
    };
  }
  const where = and(...expenseConditions(siteIds, f));

  // Same joins as listExpenses so worker/supplier/category filters apply identically.
  const [[totals], catRows, siteRows, page] = await Promise.all([
    db
      .select({
        total: sql<string>`coalesce(sum(${expenses.totalAmount}), 0)`,
        count: count(),
        avg: sql<string>`round(coalesce(sum(${expenses.totalAmount}), 0) / ${days}, 2)`,
      })
      .from(expenses)
      .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
      .leftJoin(labourWorkers, eq(labourWorkers.id, expenses.labourWorkerId))
      .leftJoin(suppliers, eq(suppliers.id, expenses.supplierId))
      .where(where),
    db
      .select({ code: expenseCategories.code, amount: sum(expenses.totalAmount) })
      .from(expenses)
      .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
      .leftJoin(labourWorkers, eq(labourWorkers.id, expenses.labourWorkerId))
      .leftJoin(suppliers, eq(suppliers.id, expenses.supplierId))
      .where(where)
      .groupBy(expenseCategories.code),
    db
      .select({ siteId: expenses.siteId, name: constructionSites.name, count: count(), amount: sum(expenses.totalAmount) })
      .from(expenses)
      .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
      .innerJoin(constructionSites, eq(constructionSites.id, expenses.siteId))
      .leftJoin(labourWorkers, eq(labourWorkers.id, expenses.labourWorkerId))
      .leftJoin(suppliers, eq(suppliers.id, expenses.supplierId))
      .where(where)
      .groupBy(expenses.siteId, constructionSites.name)
      .orderBy(desc(sum(expenses.totalAmount))),
    listExpenses(actor, f),
  ]);

  const byCode = new Map(catRows.map((r) => [r.code as Category, num(r.amount)]));
  const byCategory = CATEGORIES.map((category) => ({ category, amount: byCode.get(category) ?? 0 }));
  const top = [...byCategory].sort((a, b) => b.amount - a.amount)[0];
  return {
    filters: f,
    summary: {
      total: num(totals.total),
      count: Number(totals.count),
      avgPerDay: num(totals.avg),
      topCategory: top && top.amount > 0 ? top.category : null,
    },
    byCategory,
    bySite: siteRows.map((r) => ({ siteId: r.siteId, name: r.name, count: Number(r.count), amount: num(r.amount) })),
    page,
  };
}

export type ReportData = Awaited<ReturnType<typeof getReport>>;

/**
 * Every matching row, page by page, for CSV export. Only sites where the actor
 * may export (owners and accountants) are included; asking for a site they can
 * see but not export is Forbidden, and having no exportable site at all is too.
 */
export async function* reportRows(actor: Actor, raw: unknown) {
  const f = reportFilters.parse(raw);
  if (f.from > f.to) throw new ValidationError("Start date is after the end date.", { from: "Pick a start on or before the end." });
  const exportable = await scopeSiteIds(actor, f.siteId, db, "report:export");
  if (exportable.length === 0) throw new ForbiddenError("Only site owners and accountants can export reports.");
  let cursor: string | undefined;
  do {
    const page = await pageExpenses(actor, { ...f, cursor, limit: 100 }, "report:export");
    yield* page.items;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}
