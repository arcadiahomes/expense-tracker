import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { CategoryTotal, Granularity, PeriodTotals, TrendPoint } from "@/lib/analytics";
import { monthStart, shiftDate, weekStart } from "@/lib/dates";
import { monthLabel, shortDate } from "@/lib/format";
import { CATEGORIES, type Category } from "@/lib/types";
import { scopeSiteIds, type Actor } from "../authz";
import { listExpenses } from "./expenses";
import { getSite, listSites } from "./sites";
import { num, today } from "./shared";

const ZERO_TOTALS: PeriodTotals = { today: 0, yesterday: 0, week: 0, lastWeekToDate: 0, month: 0, lastMonthToDate: 0 };

/** Today / week / month and the same point in the previous period, summed in SQL. */
export async function periodTotals(siteIds: string[], t = today()): Promise<PeriodTotals> {
  if (siteIds.length === 0) return ZERO_TOTALS;
  const ws = weekStart(t);
  const ms = monthStart(t);
  const lms = monthStart(shiftDate(ms, -1));
  const lmEnd = shiftDate(lms, Number(t.slice(8)) - 1);
  const [r] = (await db.execute(sql`
    select
      coalesce(sum(total_amount) filter (where expense_date = ${t}::date), 0) as today,
      coalesce(sum(total_amount) filter (where expense_date = ${shiftDate(t, -1)}::date), 0) as yesterday,
      coalesce(sum(total_amount) filter (where expense_date between ${ws}::date and ${t}::date), 0) as week,
      coalesce(sum(total_amount) filter (where expense_date between ${shiftDate(ws, -7)}::date and ${shiftDate(t, -7)}::date), 0) as last_week,
      coalesce(sum(total_amount) filter (where expense_date between ${ms}::date and ${t}::date), 0) as month,
      coalesce(sum(total_amount) filter (where expense_date between ${lms}::date and ${lmEnd}::date), 0) as last_month
    from expenses
    where site_id in ${siteIds} and deleted_at is null and status = 'approved' and expense_date >= ${lms}::date
  `)) as unknown as Record<string, string>[];
  return {
    today: num(r.today),
    yesterday: num(r.yesterday),
    week: num(r.week),
    lastWeekToDate: num(r.last_week),
    month: num(r.month),
    lastMonthToDate: num(r.last_month),
  };
}

function emptyPoint(key: string, label: string): TrendPoint {
  return { key, label, total: 0, materials: 0, labour: 0, transport: 0, equipment: 0, other: 0 };
}

/** Spend per day (14), week (12) or month (8), stacked by category. */
export async function trend(siteIds: string[], granularity: Granularity, t = today()): Promise<TrendPoint[]> {
  const buckets: TrendPoint[] = [];
  let from: string;
  let bucketExpr;
  if (granularity === "daily") {
    for (let i = 13; i >= 0; i--) {
      const d = shiftDate(t, -i);
      buckets.push(emptyPoint(d, shortDate(d)));
    }
    from = buckets[0].key;
    bucketExpr = sql`e.expense_date::text`;
  } else if (granularity === "weekly") {
    const ws = weekStart(t);
    for (let i = 11; i >= 0; i--) {
      const d = shiftDate(ws, -7 * i);
      buckets.push(emptyPoint(d, shortDate(d)));
    }
    from = buckets[0].key;
    // ISO weeks start on Monday, matching weekStart().
    bucketExpr = sql`date_trunc('week', e.expense_date)::date::text`;
  } else {
    let m = monthStart(t);
    const months: string[] = [];
    for (let i = 0; i < 8; i++) {
      months.unshift(m.slice(0, 7));
      m = monthStart(shiftDate(m, -1));
    }
    for (const k of months) buckets.push(emptyPoint(k, monthLabel(k)));
    from = `${months[0]}-01`;
    bucketExpr = sql`to_char(e.expense_date, 'YYYY-MM')`;
  }
  if (siteIds.length === 0) return buckets;

  const rows = (await db.execute(sql`
    select ${bucketExpr} as bucket, c.code, sum(e.total_amount) as amount
    from expenses e join expense_categories c on c.id = e.category_id
    where e.site_id in ${siteIds} and e.deleted_at is null and e.status = 'approved'
      and e.expense_date between ${from}::date and ${t}::date
    group by 1, 2
  `)) as unknown as { bucket: string; code: Category; amount: string }[];

  const index = new Map(buckets.map((b) => [b.key, b]));
  for (const r of rows) {
    const b = index.get(r.bucket);
    if (!b) continue;
    b[r.code] = num(r.amount);
  }
  for (const b of buckets) b.total = CATEGORIES.reduce((s, c) => s + b[c], 0);
  return buckets;
}

export async function categoryTotals(siteIds: string[], from: string, to: string): Promise<CategoryTotal[]> {
  const rows = siteIds.length
    ? ((await db.execute(sql`
        select c.code, sum(e.total_amount) as amount
        from expenses e join expense_categories c on c.id = e.category_id
        where e.site_id in ${siteIds} and e.deleted_at is null and e.status = 'approved'
          and e.expense_date between ${from}::date and ${to}::date
        group by c.code
      `)) as unknown as { code: Category; amount: string }[])
    : [];
  const by = new Map(rows.map((r) => [r.code, num(r.amount)]));
  return CATEGORIES.map((category) => ({ category, amount: by.get(category) ?? 0 }));
}

/** Everything the dashboard renders, computed from stored records for the actor's sites. */
export async function getDashboard(actor: Actor) {
  const t = today();
  // Sites whose records the actor reads; an assistant engineer's sites never feed the dashboard.
  const siteIds = await scopeSiteIds(actor);
  const [totals, daily, weekly, monthly, categories, sites, recent] = await Promise.all([
    periodTotals(siteIds, t),
    trend(siteIds, "daily", t),
    trend(siteIds, "weekly", t),
    trend(siteIds, "monthly", t),
    categoryTotals(siteIds, monthStart(t), t),
    listSites(actor),
    listExpenses(actor, { limit: 7 }),
  ]);
  return {
    today: t,
    totals,
    trends: { daily, weekly, monthly } satisfies Record<Granularity, TrendPoint[]>,
    categories,
    sites,
    recent: recent.items,
  };
}

export type DashboardData = Awaited<ReturnType<typeof getDashboard>>;

/** One site's page: summary, category split, weekly trend, burn rate and first history page. */
export async function getSiteDetail(actor: Actor, siteId: string, category?: Category) {
  const t = today();
  const { summary, categories } = await getSite(actor, siteId);
  const [weekly, history, [burn]] = await Promise.all([
    trend([siteId], "weekly", t),
    listExpenses(actor, { siteId, categoryCode: category, limit: 25 }),
    db.execute(sql`
      select coalesce(sum(total_amount), 0) as last30
      from expenses
      where site_id = ${siteId} and deleted_at is null and status = 'approved'
        and expense_date between ${shiftDate(t, -29)}::date and ${t}::date
    `) as unknown as Promise<{ last30: string }[]>,
  ]);
  return { today: t, summary, categories, weekly, history, last30: num(burn.last30), category: category ?? null };
}

export type SiteDetailData = Awaited<ReturnType<typeof getSiteDetail>>;
