import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { daysBetween, monthStart, weekStart } from "@/lib/dates";
import { CATEGORIES, type Category, type Expense } from "@/lib/types";
import { scopeSiteIds, type Actor } from "../authz";
import { ValidationError } from "../errors";
import { analyticsFilters } from "../validation";
import { billsQuery } from "./bills";
import { listExpenses } from "./expenses";
import { today } from "./shared";

/**
 * Dashboard analytics, aggregated in Postgres over the sites the actor can read.
 * Three kinds of money, never added into one another twice:
 *
 * - Spent: expenses. Every rupee that left, once. Bill payments, cash purchases,
 *   wages and advances are all expenses, so "spent" already includes them.
 * - Committed: owed but not yet paid, as of today. The unpaid part of supplier
 *   bills (credit purchases included) plus wages earned and not yet paid. The paid
 *   part of a bill is already in spent, so only the remainder counts here.
 * - Payments: the breakdown of spent by how it left (bill payments, cash purchases,
 *   wages, advances, other). The kinds are exclusive and add up to spent.
 *
 * Amounts are numeric strings from SQL; they're turned into numbers only for display.
 */

export type SpendKind = "bill_payments" | "purchases" | "wages" | "advances" | "other";

export type BudgetAlert = {
  siteId: string;
  site: string;
  category: Category | null;
  budget: string;
  spent: string;
  committed: string;
  utilisation: number;
  alertPercent: number;
  level: "warning" | "over";
};

export type SiteComparison = {
  siteId: string;
  name: string;
  status: "active" | "on_hold" | "completed";
  budget: string | null;
  alertPercent: number;
  /** All-time spend: what the budget is measured against. */
  spent: string;
  /** Spend inside the selected range. */
  rangeSpent: string;
  committed: string;
  remaining: string | null;
  remainingAfterCommitments: string | null;
  utilisation: number | null;
};

export type BudgetLineUsage = {
  siteId: string;
  site: string;
  category: Category | null;
  budget: string;
  alertPercent: number;
  spent: string;
  committed: string;
  remaining: string;
  utilisation: number;
  level: "ok" | "warning" | "over";
};

const n = (v: string | number | null | undefined) => Number(v ?? 0);

/** Range from the filters: default this month to today; the end can't be after today. */
function resolveRange(from: string | undefined, to: string | undefined, t: string) {
  const end = to ?? t;
  const start = from ?? monthStart(end > t ? t : end);
  if (end > t) throw new ValidationError("The end date can't be in the future.", { to: "Pick today or earlier." });
  if (start > end) throw new ValidationError("The start date is after the end date.", { from: "Pick a start on or before the end." });
  if (daysBetween(start, end) > 366 * 3) throw new ValidationError("Pick a range of three years or less.", { from: "Range too long." });
  return { from: start, to: end };
}

/** Spend per (site, category, kind) and the period sums, in one scan of expenses. */
function spendSql(siteIds: string[], from: string, to: string, t: string) {
  return sql`
    select
      coalesce(sum(e.total_amount) filter (where e.expense_date = ${t}::date), 0)::text as today,
      coalesce(sum(e.total_amount) filter (where e.expense_date between ${weekStart(t)}::date and ${t}::date), 0)::text as week,
      coalesce(sum(e.total_amount) filter (where e.expense_date between ${monthStart(t)}::date and ${t}::date), 0)::text as month,
      coalesce(sum(e.total_amount) filter (where e.expense_date between ${from}::date and ${to}::date), 0)::text as range,
      count(*) filter (where e.expense_date between ${from}::date and ${to}::date)::int as range_count
    from expenses e
    where e.site_id in ${siteIds} and e.deleted_at is null and e.status = 'approved'
  `;
}

/** Wages earned minus paid, per site and worker. Positive balances are wages owed. */
function labourBalanceSql(siteIds: string[]) {
  return sql`
    with earned as (
      select site_id, worker_id, sum(wage_amount) as earned
      from labour_attendance where site_id in ${siteIds} group by 1, 2
    ), paid as (
      select e.site_id, e.labour_worker_id as worker_id, sum(e.total_amount) as paid
      from expenses e join expense_categories c on c.id = e.category_id
      where e.site_id in ${siteIds} and e.deleted_at is null and e.status = 'approved' and e.labour_worker_id is not null and c.code = 'labour'
      group by 1, 2
    )
    select coalesce(earned.site_id, paid.site_id) as site_id,
           coalesce(earned.worker_id, paid.worker_id) as worker_id,
           coalesce(earned.earned, 0) - coalesce(paid.paid, 0) as balance
    from earned full join paid on paid.site_id = earned.site_id and paid.worker_id = earned.worker_id
  `;
}

export async function getAnalytics(actor: Actor, raw: unknown = {}) {
  const f = analyticsFilters.parse(raw);
  const t = today();
  const range = resolveRange(f.from, f.to, t);
  const siteIds = await scopeSiteIds(actor, f.siteId);
  const empty = siteIds.length === 0;
  const scope = empty ? ["00000000-0000-0000-0000-000000000000"] : siteIds;

  const [[periods], kinds, categories, sites, lines, labour, suppliers, [owed], recent] = await Promise.all([
    db.execute(spendSql(scope, range.from, range.to, t)) as unknown as Promise<
      { today: string; week: string; month: string; range: string; range_count: number }[]
    >,
    // How the money in the range left. Exclusive, in this order: bill payment, cash purchase, wage, advance, other.
    db.execute(sql`
      select case
               when e.source = 'bill_payment' then 'bill_payments'
               when e.source = 'purchase' then 'purchases'
               when e.labour_worker_id is not null and c.code = 'labour' and e.labour_kind = 'advance' then 'advances'
               when e.labour_worker_id is not null and c.code = 'labour' then 'wages'
               else 'other'
             end as kind,
             sum(e.total_amount)::text as amount, count(*)::int as n
      from expenses e join expense_categories c on c.id = e.category_id
      where e.site_id in ${scope} and e.deleted_at is null and e.status = 'approved' and e.expense_date between ${range.from}::date and ${range.to}::date
      group by 1
    `) as unknown as Promise<{ kind: SpendKind; amount: string; n: number }[]>,
    db.execute(sql`
      select c.code, sum(e.total_amount)::text as amount, count(*)::int as n
      from expenses e join expense_categories c on c.id = e.category_id
      where e.site_id in ${scope} and e.deleted_at is null and e.status = 'approved' and e.expense_date between ${range.from}::date and ${range.to}::date
      group by c.code
    `) as unknown as Promise<{ code: Category; amount: string; n: number }[]>,
    // One row per site: budget, all-time and range spend, and what's committed on it.
    db.execute(sql`
      with spend as (
        select site_id, sum(total_amount) as spent,
               sum(total_amount) filter (where expense_date between ${range.from}::date and ${range.to}::date) as range_spent
        from expenses where site_id in ${scope} and deleted_at is null and status = 'approved' group by site_id
      ), bills as (
        select site_id, sum(amount - paid) as owed from (${billsQuery(scope, t)}) b group by site_id
      ), wages as (
        select site_id, sum(greatest(balance, 0)) as owed from (${labourBalanceSql(scope)}) l group by site_id
      )
      select s.id, s.name, s.status, b.amount::text as budget, coalesce(b.alert_percent, 80) as alert_percent,
             coalesce(spend.spent, 0)::text as spent,
             coalesce(spend.range_spent, 0)::text as range_spent,
             (coalesce(bills.owed, 0) + coalesce(wages.owed, 0))::text as committed,
             (b.amount - coalesce(spend.spent, 0))::text as remaining,
             (b.amount - coalesce(spend.spent, 0) - coalesce(bills.owed, 0) - coalesce(wages.owed, 0))::text as remaining_after
      from construction_sites s
      left join site_budgets b on b.site_id = s.id and b.category_id is null
      left join spend on spend.site_id = s.id
      left join bills on bills.site_id = s.id
      left join wages on wages.site_id = s.id
      where s.id in ${scope}
      order by coalesce(spend.range_spent, 0) desc, s.name
    `) as unknown as Promise<
      { id: string; name: string; status: SiteComparison["status"]; budget: string | null; alert_percent: number; spent: string; range_spent: string; committed: string; remaining: string | null; remaining_after: string | null }[]
    >,
    // Every budget line (total and per category) against all-time spend and commitments in that category.
    db.execute(sql`
      with spend as (
        select e.site_id, c.code, sum(e.total_amount) as spent
        from expenses e join expense_categories c on c.id = e.category_id
        where e.site_id in ${scope} and e.deleted_at is null and e.status = 'approved' group by 1, 2
      ), bills as (
        select site_id, category as code, sum(amount - paid) as owed from (${billsQuery(scope, t)}) b group by 1, 2
      ), wages as (
        select site_id, 'labour'::text as code, sum(greatest(balance, 0)) as owed from (${labourBalanceSql(scope)}) l group by 1
      )
      select x.*, (x.budget::numeric - x.spent::numeric)::text as remaining from (
      select b.site_id, s.name as site, c.code as category, b.amount::text as budget, b.alert_percent, c.sort_order,
             coalesce((select sum(spent) from spend where spend.site_id = b.site_id and (c.code is null or spend.code = c.code)), 0)::text as spent,
             (coalesce((select sum(owed) from bills where bills.site_id = b.site_id and (c.code is null or bills.code = c.code)), 0)
              + coalesce((select sum(owed) from wages where wages.site_id = b.site_id and (c.code is null or wages.code = c.code)), 0))::text as committed
      from site_budgets b
      join construction_sites s on s.id = b.site_id
      left join expense_categories c on c.id = b.category_id
      where b.site_id in ${scope}
      ) x order by x.site, x.sort_order nulls first
    `) as unknown as Promise<{ site_id: string; site: string; category: Category | null; budget: string; alert_percent: number; spent: string; committed: string; remaining: string }[]>,
    // Wages owed, per worker and site (largest first), plus the totals.
    db.execute(sql`
      select l.site_id, s.name as site, l.worker_id, w.name as worker, l.balance::text as balance
      from (${labourBalanceSql(scope)}) l
      join labour_workers w on w.id = l.worker_id
      join construction_sites s on s.id = l.site_id
      where l.balance <> 0
      order by l.balance desc
    `) as unknown as Promise<{ site_id: string; site: string; worker_id: string; worker: string; balance: string }[]>,
    db.execute(sql`
      select supplier_id, supplier, sum(amount - paid)::text as owed,
             coalesce(sum(amount - paid) filter (where status = 'overdue'), 0)::text as overdue,
             count(*) filter (where status <> 'paid')::int as open_bills
      from (${billsQuery(scope, t)}) b
      group by supplier_id, supplier
      having sum(amount - paid) > 0
      order by sum(amount - paid) desc
    `) as unknown as Promise<{ supplier_id: string; supplier: string; owed: string; overdue: string; open_bills: number }[]>,
    db.execute(sql`
      select (select coalesce(sum(amount - paid), 0) from (${billsQuery(scope, t)}) b)::text as supplier_outstanding,
             (select coalesce(sum(amount - paid) filter (where status = 'overdue'), 0) from (${billsQuery(scope, t)}) b)::text as supplier_overdue,
             (select coalesce(sum(greatest(balance, 0)), 0) from (${labourBalanceSql(scope)}) l)::text as unpaid_wages,
             (select coalesce(sum(greatest(-balance, 0)), 0) from (${labourBalanceSql(scope)}) l)::text as advances,
             ((select coalesce(sum(amount - paid), 0) from (${billsQuery(scope, t)}) b)
              + (select coalesce(sum(greatest(balance, 0)), 0) from (${labourBalanceSql(scope)}) l))::text as total
    `) as unknown as Promise<{ supplier_outstanding: string; supplier_overdue: string; unpaid_wages: string; advances: string; total: string }[]>,
    empty ? Promise.resolve({ items: [] as Expense[], nextCursor: null }) : listExpenses(actor, { siteId: f.siteId, q: f.q, from: f.q ? undefined : range.from, to: f.q ? undefined : range.to, limit: 10 }),
  ]);

  // ---- Shape for display ---------------------------------------------------------
  const kindAmount = new Map(kinds.map((k) => [k.kind, k]));
  const spendKinds = (["bill_payments", "purchases", "wages", "advances", "other"] as SpendKind[]).map((kind) => ({
    kind,
    amount: kindAmount.get(kind)?.amount ?? "0",
    count: kindAmount.get(kind)?.n ?? 0,
  }));

  const catAmount = new Map(categories.map((c) => [c.code, c]));
  const rangeTotal = n(periods.range);
  const byCategory = CATEGORIES.map((category) => ({
    category,
    amount: catAmount.get(category)?.amount ?? "0",
    count: catAmount.get(category)?.n ?? 0,
    share: rangeTotal > 0 ? n(catAmount.get(category)?.amount) / rangeTotal : 0,
  }));
  const topCategories = [...byCategory].filter((c) => n(c.amount) > 0).sort((a, b) => n(b.amount) - n(a.amount));

  const siteRows: SiteComparison[] = (empty ? [] : sites).map((s) => ({
    siteId: s.id,
    name: s.name,
    status: s.status,
    budget: s.budget,
    alertPercent: s.alert_percent,
    spent: s.spent,
    rangeSpent: s.range_spent,
    committed: s.committed,
    remaining: s.remaining,
    remainingAfterCommitments: s.remaining_after,
    utilisation: s.budget && n(s.budget) > 0 ? n(s.spent) / n(s.budget) : null,
  }));

  const budgetLines: BudgetLineUsage[] = (empty ? [] : lines).map((l) => {
    // A zero budget with any spend is simply over; there's no meaningful percentage.
    const utilisation = n(l.budget) > 0 ? n(l.spent) / n(l.budget) : n(l.spent) > 0 ? 1.01 : 0;
    return {
      siteId: l.site_id,
      site: l.site,
      category: l.category,
      budget: l.budget,
      alertPercent: l.alert_percent,
      spent: l.spent,
      committed: l.committed,
      remaining: l.remaining,
      utilisation,
      level: utilisation > 1 ? "over" : utilisation >= l.alert_percent / 100 ? "warning" : "ok",
    };
  });
  const alerts: BudgetAlert[] = budgetLines
    .filter((l) => l.level !== "ok")
    .map((l) => ({ siteId: l.siteId, site: l.site, category: l.category, budget: l.budget, spent: l.spent, committed: l.committed, utilisation: l.utilisation, alertPercent: l.alertPercent, level: l.level as BudgetAlert["level"] }))
    .sort((a, b) => (a.level === b.level ? b.utilisation - a.utilisation : a.level === "over" ? -1 : 1));

  const owedWorkers = (empty ? [] : labour).filter((l) => n(l.balance) > 0);
  const supplierRows = empty ? [] : suppliers;
  const zero = empty;
  return {
    today: t,
    range: { ...range, days: daysBetween(range.from, range.to) + 1 },
    siteId: f.siteId ?? null,
    q: f.q ?? null,
    totals: {
      today: periods.today,
      week: periods.week,
      month: periods.month,
      range: periods.range,
      rangeCount: Number(periods.range_count),
    },
    spendKinds,
    byCategory,
    topCategories,
    commitments: {
      supplierOutstanding: zero ? "0" : owed.supplier_outstanding,
      supplierOverdue: zero ? "0" : owed.supplier_overdue,
      unpaidWages: zero ? "0" : owed.unpaid_wages,
      total: zero ? "0" : owed.total,
      /** Paid out ahead of work; already in spent, shown for context only. */
      advancesOutstanding: zero ? "0" : owed.advances,
    },
    sites: siteRows,
    budgetLines,
    alerts,
    workersOwed: owedWorkers.slice(0, 8).map((l) => ({ siteId: l.site_id, site: l.site, workerId: l.worker_id, worker: l.worker, amount: l.balance })),
    suppliersOwed: supplierRows.slice(0, 8).map((s) => ({ supplierId: s.supplier_id, supplier: s.supplier, amount: s.owed, overdue: s.overdue, openBills: s.open_bills })),
    recent: recent.items,
  };
}

export type AnalyticsData = Awaited<ReturnType<typeof getAnalytics>>;
