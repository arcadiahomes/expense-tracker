import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { constructionSites, expenseCategories, expenseItems, expenses, labourAttendance, labourWorkers } from "@/db/schema";
import { formatINR } from "@/lib/format";
import { toPaise } from "@/lib/voice";
import { accessibleSites, can, isOrgAdmin, requireOrgAdmin, requireOrgReader, requireSitePermission, scopeSiteIds, type Actor } from "../authz";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { attendanceBatchInput, attendanceInput, isoDate, labourPaymentInput, uuid, workerInput, workerMergeInput, workerUpdateInput } from "../validation";
import { audit } from "./audit";
import { categoryId, enteredApproved, num, requireOpenSite, rethrowUnique, today, type Conn } from "./shared";

/**
 * The Labour page tracks payments only: each one is a labour expense naming the
 * worker, and `labourTotals` sums them per worker. Attendance (earned wages) is no
 * longer recorded from the page; older attendance still feeds balances, labour
 * invoices and reports.
 */

/** Org reference data may be written by org admins and anyone who records field work somewhere. */
export async function requireOrgWriter(actor: Actor) {
  if (isOrgAdmin(actor)) return;
  const roles = await accessibleSites(actor);
  if (![...roles.values()].some((r) => can(r, "field:record"))) {
    throw new ForbiddenError("Viewers can't change shared records.");
  }
}

// ---- Workers ------------------------------------------------------------------

export async function listWorkers(actor: Actor) {
  await requireOrgReader(actor);
  const rows = await db
    .select()
    .from(labourWorkers)
    .where(eq(labourWorkers.organizationId, actor.orgId))
    .orderBy(asc(labourWorkers.name));
  return rows.map((w) => ({ ...w, dailyWage: w.dailyWage == null ? null : num(w.dailyWage) }));
}

export async function createWorker(actor: Actor, raw: unknown) {
  await requireOrgWriter(actor);
  const input = workerInput.parse(raw);
  return db
    .transaction(async (tx) => {
      const [row] = await tx.insert(labourWorkers).values({ organizationId: actor.orgId, ...input }).returning();
      await audit(tx, actor, { action: "worker.create", entityType: "worker", entityId: row.id, summary: `Added worker ${row.name}`, data: input });
      return row;
    })
    .catch((err) => rethrowUnique(err, "name", "A worker with this name already exists."));
}

export async function updateWorker(actor: Actor, raw: unknown) {
  await requireOrgWriter(actor);
  const input = workerUpdateInput.parse(raw);
  return db
    .transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(labourWorkers)
        .where(and(eq(labourWorkers.id, input.id), eq(labourWorkers.organizationId, actor.orgId)))
        .for("update");
      if (!before) throw new NotFoundError("Worker");
      const [row] = await tx
        .update(labourWorkers)
        .set({
          name: input.name,
          trade: input.trade ?? null,
          phone: input.phone ?? null,
          dailyWage: input.dailyWage ?? null,
          ...(input.active !== undefined && { active: input.active }),
        })
        .where(eq(labourWorkers.id, input.id))
        .returning();
      await audit(tx, actor, {
        action: "worker.update",
        entityType: "worker",
        entityId: row.id,
        summary: `Updated worker ${row.name}`,
        data: { before: { name: before.name, trade: before.trade, dailyWage: before.dailyWage, active: before.active }, after: input },
      });
      return row;
    })
    .catch((err) => rethrowUnique(err, "name", "A worker with this name already exists."));
}

/**
 * Folds a duplicate worker into another: its labour expenses and attendance on every
 * site move to the kept worker, blank details are filled from it, and it is removed.
 * Org owners/admins only, since it rewrites records on sites others may not see.
 */
export async function mergeWorkers(actor: Actor, raw: unknown) {
  requireOrgAdmin(actor);
  const { fromId, intoId } = workerMergeInput.parse(raw);
  return db.transaction(async (tx) => {
    const both = await tx
      .select()
      .from(labourWorkers)
      .where(and(inArray(labourWorkers.id, [fromId, intoId]), eq(labourWorkers.organizationId, actor.orgId)))
      .orderBy(asc(labourWorkers.id))
      .for("update");
    const from = both.find((w) => w.id === fromId);
    const into = both.find((w) => w.id === intoId);
    if (!from || !into) throw new NotFoundError("Worker");
    // Attendance is one row per worker, site and day; two rows for the same day can't be combined.
    const [clash] = (await tx.execute(sql`
      select count(*)::int as days from labour_attendance a join labour_attendance b
        on b.site_id = a.site_id and b.work_date = a.work_date
      where a.worker_id = ${fromId} and b.worker_id = ${intoId}
    `)) as unknown as { days: number }[];
    if (clash.days > 0) {
      throw new ValidationError(`${from.name} and ${into.name} both have attendance on ${clash.days} of the same ${clash.days === 1 ? "day" : "days"}. Remove one of them first.`);
    }
    const moved = await tx.update(expenses).set({ labourWorkerId: intoId }).where(eq(expenses.labourWorkerId, fromId)).returning({ id: expenses.id });
    const days = await tx.update(labourAttendance).set({ workerId: intoId }).where(eq(labourAttendance.workerId, fromId)).returning({ id: labourAttendance.id });
    const [row] = await tx
      .update(labourWorkers)
      .set({
        trade: into.trade ?? from.trade,
        phone: into.phone ?? from.phone,
        dailyWage: into.dailyWage ?? from.dailyWage,
        active: into.active || from.active,
      })
      .where(eq(labourWorkers.id, intoId))
      .returning();
    await tx.delete(labourWorkers).where(eq(labourWorkers.id, fromId));
    await audit(tx, actor, {
      action: "worker.merge",
      entityType: "worker",
      entityId: intoId,
      summary: `Merged worker ${from.name} into ${into.name}`,
      data: { from: { id: from.id, name: from.name, trade: from.trade, phone: from.phone, dailyWage: from.dailyWage }, expenses: moved.length, attendance: days.length },
    });
    return { worker: row, expenses: moved.length, attendance: days.length };
  });
}

export async function setWorkerActive(actor: Actor, workerId: string, active: boolean) {
  await requireOrgWriter(actor);
  await db.transaction(async (tx) => {
    const rows = await tx
      .update(labourWorkers)
      .set({ active })
      .where(and(eq(labourWorkers.id, workerId), eq(labourWorkers.organizationId, actor.orgId)))
      .returning({ id: labourWorkers.id, name: labourWorkers.name });
    if (rows.length === 0) throw new NotFoundError("Worker");
    await audit(tx, actor, {
      action: active ? "worker.activate" : "worker.deactivate",
      entityType: "worker",
      entityId: workerId,
      summary: `${active ? "Reactivated" : "Deactivated"} worker ${rows[0].name}`,
    });
  });
}

// ---- Attendance ------------------------------------------------------------------

const FACTOR = { present: 1, half_day: 0.5, absent: 0 } as const;

type DayEntry = Omit<ReturnType<typeof attendanceInput.parse>, "siteId" | "workDate">;

/**
 * Marks workers for one day on one site; re-marking a day replaces it. The wage is
 * the day rate × 1, ½ or 0, worked out here in paise, never taken from the client.
 */
async function markDay(actor: Actor, siteId: string, workDate: string, entries: DayEntry[], conn: Conn) {
  await requireSitePermission(actor, siteId, "field:record", conn);
  await requireOpenSite(siteId, conn);
  if (workDate > today()) throw new ValidationError("Attendance can't be marked for a future date.", { workDate: "Pick today or earlier." });
  const workers = await conn
    .select({ id: labourWorkers.id, name: labourWorkers.name, dailyWage: labourWorkers.dailyWage, trade: labourWorkers.trade })
    .from(labourWorkers)
    .where(and(inArray(labourWorkers.id, entries.map((e) => e.workerId)), eq(labourWorkers.organizationId, actor.orgId)));
  const byId = new Map(workers.map((w) => [w.id, w]));
  if (byId.size !== entries.length) throw new NotFoundError("Worker");

  const previous = await conn
    .select()
    .from(labourAttendance)
    .where(and(eq(labourAttendance.siteId, siteId), eq(labourAttendance.workDate, workDate), inArray(labourAttendance.workerId, entries.map((e) => e.workerId))));
  const prevBy = new Map(previous.map((p) => [p.workerId, p]));

  const rows = entries.map((e, i) => {
    const w = byId.get(e.workerId)!;
    const rate = e.dayRate ?? w.dailyWage ?? null;
    if (e.status !== "absent" && toPaise(rate) === null) {
      const message = `Set a day rate for ${w.name}, or a daily wage on their profile.`;
      throw new ValidationError(message, { [`entries.${i}.dayRate`]: message });
    }
    const wagePaise = Math.round((toPaise(rate) ?? 0) * FACTOR[e.status]);
    return {
      siteId,
      workerId: e.workerId,
      workDate,
      status: e.status,
      workType: e.workType ?? w.trade ?? null,
      dayRate: rate,
      hours: e.hours,
      wageAmount: (wagePaise / 100).toFixed(2),
      recordedBy: actor.userId,
    };
  });

  const saved = await conn
    .insert(labourAttendance)
    .values(rows)
    .onConflictDoUpdate({
      target: [labourAttendance.siteId, labourAttendance.workerId, labourAttendance.workDate],
      set: {
        status: sql`excluded.status`,
        workType: sql`excluded.work_type`,
        dayRate: sql`excluded.day_rate`,
        hours: sql`excluded.hours`,
        wageAmount: sql`excluded.wage_amount`,
        recordedBy: sql`excluded.recorded_by`,
      },
    })
    .returning();

  await audit(
    conn,
    actor,
    rows
      .filter((r) => {
        const p = prevBy.get(r.workerId);
        return !p || p.status !== r.status || p.wageAmount !== r.wageAmount || p.workType !== r.workType;
      })
      .map((r) => {
        const p = prevBy.get(r.workerId);
        const name = byId.get(r.workerId)!.name;
        return {
          siteId,
          action: p ? "attendance.update" : "attendance.create",
          entityType: "attendance",
          entityId: saved.find((s) => s.workerId === r.workerId)!.id,
          summary: `${name}: ${r.status.replace("_", " ")} on ${workDate}${r.workType ? ` (${r.workType})` : ""}, ${formatINR(num(r.wageAmount))}`,
          data: { before: p ? { status: p.status, wageAmount: p.wageAmount, workType: p.workType } : null, after: r },
        };
      }),
  );
  return saved;
}

export async function recordAttendance(actor: Actor, raw: unknown) {
  const input = attendanceInput.parse(raw);
  const [row] = await db.transaction((tx) => markDay(actor, input.siteId, input.workDate, [input], tx));
  return row;
}

/** The daily roll call: several workers marked in one transaction. */
export async function recordAttendanceBatch(actor: Actor, raw: unknown) {
  const input = attendanceBatchInput.parse(raw);
  return db.transaction((tx) => markDay(actor, input.siteId, input.workDate, input.entries, tx));
}

export async function listAttendance(actor: Actor, siteId: string, from: string, to: string) {
  await requireSitePermission(actor, siteId, "site:read");
  isoDate.parse(from);
  isoDate.parse(to);
  return db
    .select({
      id: labourAttendance.id,
      workDate: labourAttendance.workDate,
      status: labourAttendance.status,
      workType: labourAttendance.workType,
      dayRate: labourAttendance.dayRate,
      hours: labourAttendance.hours,
      wageAmount: labourAttendance.wageAmount,
      workerId: labourWorkers.id,
      workerName: labourWorkers.name,
    })
    .from(labourAttendance)
    .innerJoin(labourWorkers, eq(labourWorkers.id, labourAttendance.workerId))
    .where(and(eq(labourAttendance.siteId, siteId), gte(labourAttendance.workDate, from), lte(labourAttendance.workDate, to)))
    .orderBy(asc(labourAttendance.workDate), asc(labourWorkers.name));
}

// ---- Balances ------------------------------------------------------------------

export type WorkerBalance = {
  workerId: string;
  name: string;
  trade: string | null;
  dailyWage: string | null;
  active: boolean;
  days: string;
  earned: string;
  wagesPaid: string;
  advances: string;
  /** earned − (wages + advances). */
  balance: string;
  /** What the site owes the worker now: max(balance, 0). */
  unpaid: string;
  /** Advance not yet worked off: max(−balance, 0). */
  advanceOutstanding: string;
};

type BalanceRow = {
  id: string; name: string; trade: string | null; daily_wage: string | null; active: boolean;
  days: string; earned: string; wages: string; advances: string; balance: string;
};

/** Earned and paid per worker on one site, each summed once in its own subquery so joins can't multiply them. */
function balancesQuery(siteId: string, orgId: string, workerId?: string) {
  return sql`
    with earned as (
      select worker_id,
             sum(case status when 'present' then 1 when 'half_day' then 0.5 else 0 end) as days,
             sum(wage_amount) as earned
      from labour_attendance where site_id = ${siteId} group by worker_id
    ), paid as (
      select e.labour_worker_id as worker_id,
             sum(e.total_amount) filter (where coalesce(e.labour_kind, 'wage') = 'wage') as wages,
             sum(e.total_amount) filter (where e.labour_kind = 'advance') as advances
      from expenses e join expense_categories c on c.id = e.category_id
      where e.site_id = ${siteId} and e.deleted_at is null and e.status = 'approved' and e.labour_worker_id is not null and c.code = 'labour'
      group by e.labour_worker_id
    )
    select w.id, w.name, w.trade, w.daily_wage::text, w.active,
           coalesce(ea.days, 0)::text as days,
           -- numeric(14,2) so "nothing yet" reads 0.00 like every other amount.
           coalesce(ea.earned, 0)::numeric(14, 2)::text as earned,
           coalesce(p.wages, 0)::numeric(14, 2)::text as wages,
           coalesce(p.advances, 0)::numeric(14, 2)::text as advances,
           (coalesce(ea.earned, 0) - coalesce(p.wages, 0) - coalesce(p.advances, 0))::numeric(14, 2)::text as balance
    from labour_workers w
    left join earned ea on ea.worker_id = w.id
    left join paid p on p.worker_id = w.id
    where w.organization_id = ${orgId}
      and (${workerId ?? null}::uuid is null or w.id = ${workerId ?? null}::uuid)
      and (ea.worker_id is not null or p.worker_id is not null or w.active or w.id = ${workerId ?? null}::uuid)
    order by w.name
  `;
}

const toBalance = (r: BalanceRow): WorkerBalance => {
  const b = Number(r.balance);
  return {
    workerId: r.id,
    name: r.name,
    trade: r.trade,
    dailyWage: r.daily_wage,
    active: r.active,
    days: (r.days.includes(".") ? r.days.replace(/\.?0+$/, "") : r.days) || "0",
    earned: r.earned,
    wagesPaid: r.wages,
    advances: r.advances,
    balance: r.balance,
    unpaid: b > 0 ? r.balance : "0.00",
    advanceOutstanding: b < 0 ? r.balance.replace("-", "") : "0.00",
  };
};

/** Every worker with activity on the site, plus active workers ready to be marked. */
export async function labourBalances(actor: Actor, siteId: string) {
  await requireSitePermission(actor, siteId, "site:read");
  const rows = (await db.execute(balancesQuery(siteId, actor.orgId))) as unknown as BalanceRow[];
  const list = rows.map(toBalance);
  const [totals] = (await db.execute(sql`
    with b as (${balancesQuery(siteId, actor.orgId)})
    select coalesce(sum(earned::numeric), 0)::text as earned,
           coalesce(sum(wages::numeric + advances::numeric), 0)::text as paid,
           coalesce(sum(greatest(balance::numeric, 0)), 0)::text as unpaid,
           coalesce(sum(greatest(-balance::numeric, 0)), 0)::text as advances
    from b
  `)) as unknown as { earned: string; paid: string; unpaid: string; advances: string }[];
  return { workers: list, totals };
}

export type WorkerTotal = {
  workerId: string;
  name: string;
  trade: string | null;
  active: boolean;
  payments: number;
  total: string;
  thisMonth: string;
  lastPaid: string | null;
};

/** One site's approved labour expenses, with or without a worker named. */
const labourSpend = (siteId: string) => sql`
  select e.id, e.labour_worker_id as worker_id, e.expense_date, e.total_amount, e.labour_kind, e.payment_method, e.notes
  from expenses e join expense_categories c on c.id = e.category_id
  where e.site_id = ${siteId} and e.deleted_at is null and e.status = 'approved' and c.code = 'labour'
`;

/** One site's approved labour expenses that name a worker. */
const paidLabour = (siteId: string) => sql`select * from (${labourSpend(siteId)}) l where l.worker_id is not null`;

/**
 * What each worker has been paid on one site, all time and this month, summed in SQL.
 * Labour is tracked by payments only: every payment is a labour expense naming the worker.
 * The site totals count every labour expense (as the dashboard's Labour category does);
 * `unassigned` is the part entered without a worker.
 */
export async function labourTotals(actor: Actor, siteId: string) {
  await requireSitePermission(actor, siteId, "site:read");
  const month = `${today().slice(0, 7)}-01`;
  const rows = (await db.execute(sql`
    with p as (${paidLabour(siteId)})
    select w.id, w.name, w.trade, w.active,
           count(p.id)::int as payments,
           coalesce(sum(p.total_amount), 0)::numeric(14, 2)::text as total,
           coalesce(sum(p.total_amount) filter (where p.expense_date >= ${month}::date), 0)::numeric(14, 2)::text as this_month,
           max(p.expense_date)::text as last_paid
    from labour_workers w left join p on p.worker_id = w.id
    where w.organization_id = ${actor.orgId}
    group by w.id
    having count(p.id) > 0 or w.active
    order by coalesce(sum(p.total_amount), 0) desc, w.name
  `)) as unknown as { id: string; name: string; trade: string | null; active: boolean; payments: number; total: string; this_month: string; last_paid: string | null }[];
  const [totals] = (await db.execute(sql`
    with p as (${labourSpend(siteId)})
    select coalesce(sum(total_amount), 0)::numeric(14, 2)::text as total,
           coalesce(sum(total_amount) filter (where expense_date >= ${month}::date), 0)::numeric(14, 2)::text as this_month,
           count(distinct worker_id)::int as workers,
           count(*) filter (where worker_id is null)::int as unassigned_count,
           coalesce(sum(total_amount) filter (where worker_id is null), 0)::numeric(14, 2)::text as unassigned,
           coalesce(sum(total_amount) filter (where worker_id is null and expense_date >= ${month}::date), 0)::numeric(14, 2)::text as unassigned_this_month
    from p
  `)) as unknown as { total: string; this_month: string; workers: number; unassigned_count: number; unassigned: string; unassigned_this_month: string }[];
  return {
    workers: rows.map((r): WorkerTotal => ({ workerId: r.id, name: r.name, trade: r.trade, active: r.active, payments: r.payments, total: r.total, thisMonth: r.this_month, lastPaid: r.last_paid })),
    totals: { total: totals.total, thisMonth: totals.this_month, workers: totals.workers },
    unassigned: { payments: totals.unassigned_count, total: totals.unassigned, thisMonth: totals.unassigned_this_month },
  };
}

export type WorkerPayment = { id: string; date: string; kind: "wage" | "advance"; amount: string; method: string; note: string | null };

/** One worker's payments on one site, newest first. */
export async function workerPayments(actor: Actor, siteId: string, workerId: string) {
  await requireSitePermission(actor, siteId, "site:read");
  if (!uuid.safeParse(workerId).success) throw new NotFoundError("Worker");
  const rows = (await db.execute(sql`
    with p as (${paidLabour(siteId)})
    select p.id::text, p.expense_date::text as date, coalesce(p.labour_kind::text, 'wage') as kind, p.total_amount::text as amount, p.payment_method::text as method, p.notes as note
    from p join labour_workers w on w.id = p.worker_id
    where p.worker_id = ${workerId} and w.organization_id = ${actor.orgId}
    order by p.expense_date desc, p.id desc
  `)) as unknown as WorkerPayment[];
  return rows;
}

export type WorkerSiteTotal = { siteId: string; siteName: string; payments: number; total: string; lastPaid: string | null };

/** What one worker has been paid on each site the actor can read, largest first. Same definition as `paidLabour`. */
export async function workerSiteTotals(actor: Actor, workerId: string) {
  await requireOrgReader(actor);
  if (!uuid.safeParse(workerId).success) throw new NotFoundError("Worker");
  const siteIds = await scopeSiteIds(actor);
  if (siteIds.length === 0) return [];
  const total = sql<string>`sum(${expenses.totalAmount})::numeric(14, 2)::text`;
  const rows = await db
    .select({
      siteId: constructionSites.id,
      siteName: constructionSites.name,
      payments: sql<number>`count(*)::int`,
      total,
      lastPaid: sql<string | null>`max(${expenses.expenseDate})::text`,
    })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
    .innerJoin(constructionSites, eq(constructionSites.id, expenses.siteId))
    .innerJoin(labourWorkers, eq(labourWorkers.id, expenses.labourWorkerId))
    .where(
      and(
        inArray(expenses.siteId, siteIds),
        isNull(expenses.deletedAt),
        eq(expenses.status, "approved"),
        eq(expenses.labourWorkerId, workerId),
        eq(labourWorkers.organizationId, actor.orgId),
        eq(expenseCategories.code, "labour"),
      ),
    )
    .groupBy(constructionSites.id)
    .orderBy(desc(sql`sum(${expenses.totalAmount})`), asc(constructionSites.name));
  return rows satisfies WorkerSiteTotal[];
}

export type LedgerLine = {
  date: string;
  kind: "attendance" | "wage" | "advance";
  description: string;
  /** Positive for wages earned, negative for money paid. */
  amount: string;
  balance: string;
  id: string;
};

/** A worker's day-by-day statement on one site with a running balance. */
export async function workerLedger(actor: Actor, siteId: string, workerId: string) {
  await requireSitePermission(actor, siteId, "site:read");
  if (!uuid.safeParse(workerId).success) throw new NotFoundError("Worker");
  const [row] = (await db.execute(balancesQuery(siteId, actor.orgId, workerId))) as unknown as BalanceRow[];
  if (!row) throw new NotFoundError("Worker");
  const lines = (await db.execute(sql`
    select * , sum(amount) over (order by date, sort, id) as running from (
      select a.id::text, a.work_date::text as date, 0 as sort, 'attendance' as kind,
             initcap(replace(a.status::text, '_', ' ')) || coalesce(', ' || a.work_type, '') as description,
             a.wage_amount as amount
      from labour_attendance a where a.site_id = ${siteId} and a.worker_id = ${workerId} and a.status <> 'absent'
      union all
      select e.id::text, e.expense_date::text, 1, coalesce(e.labour_kind::text, 'wage'), e.description, -e.total_amount
      from expenses e join expense_categories c on c.id = e.category_id
      where e.site_id = ${siteId} and e.labour_worker_id = ${workerId} and e.deleted_at is null and e.status = 'approved' and c.code = 'labour'
    ) x order by date desc, sort desc, id desc
  `)) as unknown as { id: string; date: string; kind: LedgerLine["kind"]; description: string; amount: string; running: string }[];
  return {
    worker: toBalance(row),
    lines: lines.map((l): LedgerLine => ({ id: l.id, date: l.date, kind: l.kind, description: l.description, amount: l.amount, balance: l.running })),
  };
}

// ---- Payments -------------------------------------------------------------------

/**
 * Pays a worker: a labour expense that names them. There's no attendance to check it
 * against; the payment itself is the record of what the worker was paid.
 */
export async function recordLabourPayment(actor: Actor, raw: unknown) {
  const input = labourPaymentInput.parse(raw);
  await requireSitePermission(actor, input.siteId, "field:record");
  await requireOpenSite(input.siteId);
  if (input.paidOn > today()) throw new ValidationError("The payment date can't be in the future.", { paidOn: "Pick today or earlier." });

  const id = await db.transaction(async (tx) => {
    const [worker] = await tx
      .select({ id: labourWorkers.id, name: labourWorkers.name })
      .from(labourWorkers)
      .where(and(eq(labourWorkers.id, input.workerId), eq(labourWorkers.organizationId, actor.orgId)))
      .limit(1);
    if (!worker) throw new NotFoundError("Worker");

    const label = input.kind === "advance" ? "Advance" : "Wages";
    const [exp] = await tx
      .insert(expenses)
      .values({
        siteId: input.siteId,
        categoryId: await categoryId(actor, "labour", tx),
        expenseDate: input.paidOn,
        description: `${label}, ${worker.name}`,
        paymentMethod: input.method,
        source: "manual",
        labourWorkerId: worker.id,
        labourKind: input.kind,
        notes: input.note,
        createdBy: actor.userId,
        ...enteredApproved(actor),
      })
      .returning({ id: expenses.id });
    await tx.insert(expenseItems).values({ expenseId: exp.id, description: `${label}, ${worker.name}`, quantity: "1", unit: "lot", unitPrice: input.amount });
    await tx.update(expenses).set({ totalAmount: input.amount }).where(eq(expenses.id, exp.id));
    await audit(tx, actor, {
      siteId: input.siteId,
      action: input.kind === "advance" ? "labour.advance" : "labour.wage",
      entityType: "expense",
      entityId: exp.id,
      summary: `${label} of ${formatINR(num(input.amount))} to ${worker.name}`,
      data: input,
    });
    return exp.id;
  });
  return { expenseId: id, ...(await workerLedger(actor, input.siteId, input.workerId)).worker };
}
