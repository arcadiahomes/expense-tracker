import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { CATEGORY_META } from "@/lib/categories";
import { daysBetween } from "@/lib/dates";
import type { Category, PaymentMode } from "@/lib/types";
import { scopeSiteIds, type Actor } from "../authz";
import { ForbiddenError, ValidationError } from "../errors";
import { exportFilters, type ExportFilters } from "../validation";
import { today } from "../data/shared";

/**
 * Builds downloadable reports as plain data: header details, then sections of
 * grouped line items with subtotals and a total. Every amount, subtotal and total
 * is computed by Postgres from stored records; the renderers (xlsx.ts, pdf.ts)
 * only lay it out. Only sites where the actor may export are ever included.
 */

export type ColumnType = "text" | "date" | "money" | "qty" | "int" | "percent";
export type Column = { key: string; label: string; type: ColumnType; width: number };
export type Cell = string | number | null;
export type Row = Record<string, Cell>;
export type Group = { label: string | null; rows: Row[]; subtotal: Row | null };
export type Section = { title: string; note?: string; columns: Column[]; groups: Group[]; total: Row | null; empty: string };

export type ReportKind = ExportFilters["kind"];

export type Report = {
  kind: ReportKind;
  title: string;
  organization: string;
  /** One site's details, or every exported site for a consolidated report. */
  sites: { name: string; location: string; client: string | null; status: string; startDate: string; budget: string | null }[];
  consolidated: boolean;
  period: { from: string; to: string; days: number };
  filters: string[];
  /** Filters that were set but don't apply to this report. */
  ignored: string[];
  generatedAt: string;
  generatedBy: string;
  sections: Section[];
  notes: string[];
};

export const REPORT_TITLES: Record<ReportKind, string> = {
  expenses: "Site expenses",
  categories: "Category totals",
  purchases: "Material purchases",
  labour: "Labour attendance and wages",
  suppliers: "Supplier bills and outstanding balances",
  budget: "Budget versus actual",
  payments: "Payment history",
};

/** What every report says about itself, so nobody mistakes it for a tax document. */
export const STATEMENT_NOTE =
  "Internal statement for project accounting. This is not a tax invoice. Amounts are as recorded and include any tax charged; GST is not calculated or shown separately. Supplier GSTINs appear only where they were recorded.";

/** A report larger than this is refused with a request to narrow it, rather than producing an unusable file. */
export const MAX_ROWS = 20_000;

const PAYMENT_LABEL: Record<PaymentMode, string> = { cash: "Cash", upi: "UPI", bank: "Bank transfer", cheque: "Cheque", credit: "On credit" };
const STATUS_LABEL: Record<string, string> = { present: "Present", half_day: "Half day", absent: "Absent", active: "Active", on_hold: "On hold", completed: "Completed" };
const KIND_LABEL: Record<string, string> = { bill_payments: "Supplier bill payment", purchases: "Material purchase", wages: "Wages", advances: "Advance", other: "Other expense" };

/** Which filters each report can apply. */
const APPLIES: Record<ReportKind, (keyof ExportFilters)[]> = {
  expenses: ["siteId", "categoryCode", "workerName", "supplierName", "paymentMethod"],
  categories: ["siteId", "categoryCode", "workerName", "supplierName", "paymentMethod"],
  purchases: ["siteId", "supplierName", "paymentMethod"],
  labour: ["siteId", "workerName"],
  suppliers: ["siteId", "categoryCode", "supplierName"],
  budget: ["siteId", "categoryCode"],
  payments: ["siteId", "categoryCode", "workerName", "supplierName", "paymentMethod"],
};

const FILTER_LABEL: Partial<Record<keyof ExportFilters, string>> = {
  categoryCode: "Category",
  workerName: "Worker",
  supplierName: "Supplier",
  paymentMethod: "Payment method",
};

const label = (k: keyof ExportFilters, v: string) =>
  `${FILTER_LABEL[k]}: ${k === "categoryCode" ? CATEGORY_META[v as Category].label : k === "paymentMethod" ? PAYMENT_LABEL[v as PaymentMode] : v}`;

const cat = (code: string) => CATEGORY_META[code as Category]?.label ?? code;

async function guardSize(countQuery: SQL, what: string) {
  const [{ n }] = (await db.execute(countQuery)) as unknown as { n: number }[];
  if (Number(n) > MAX_ROWS) {
    throw new ValidationError(`This ${what} has ${Number(n).toLocaleString("en-IN")} rows, more than the ${MAX_ROWS.toLocaleString("en-IN")} a file can hold. Pick a shorter period or one site.`);
  }
}

/** Groups ordered rows by a key, attaching each group's subtotal row by the same key. */
function grouped(rows: Row[], key: string | null, subtotals: Map<string, Row>, labelOf: (r: Row) => string): Group[] {
  if (!key) return rows.length ? [{ label: null, rows, subtotal: null }] : [];
  const out: Group[] = [];
  for (const r of rows) {
    const k = String(r[key]);
    let g = out.at(-1);
    if (!g || g.label !== labelOf(r)) {
      g = { label: labelOf(r), rows: [], subtotal: subtotals.get(k) ?? null };
      out.push(g);
    }
    g.rows.push(r);
  }
  return out;
}

// ---- Shared SQL filters ---------------------------------------------------------

type Ctx = { f: ExportFilters; siteIds: string[]; t: string };

/** Expense filters, matching listExpenses/expenseConditions semantics, for raw SQL over `e` with joins c, w, s. */
function expenseWhere({ f, siteIds }: Ctx, dated = true) {
  const parts: SQL[] = [sql`e.site_id in ${siteIds}`, sql`e.deleted_at is null`, sql`e.status = 'approved'`];
  if (dated) parts.push(sql`e.expense_date between ${f.from}::date and ${f.to}::date`);
  if (f.categoryCode) parts.push(sql`c.code = ${f.categoryCode}`);
  if (f.workerName) parts.push(sql`w.name = ${f.workerName}`);
  if (f.supplierName) parts.push(sql`sup.name = ${f.supplierName}`);
  if (f.paymentMethod) parts.push(sql`e.payment_method = ${f.paymentMethod}`);
  return sql.join(parts, sql` and `);
}

const EXPENSE_FROM = sql`
  from expenses e
  join expense_categories c on c.id = e.category_id
  join construction_sites cs on cs.id = e.site_id
  join users u on u.id = e.created_by
  left join suppliers sup on sup.id = e.supplier_id
  left join labour_workers w on w.id = e.labour_worker_id
`;

/** Exclusive payment kinds, the same order the dashboard uses, so the two always agree. */
const PAYMENT_KIND = sql`case
  when e.source = 'bill_payment' then 'bill_payments'
  when e.source = 'purchase' then 'purchases'
  when e.labour_worker_id is not null and c.code = 'labour' and e.labour_kind = 'advance' then 'advances'
  when e.labour_worker_id is not null and c.code = 'labour' then 'wages'
  else 'other' end`;

// ---- Sections ---------------------------------------------------------------------

async function expensesSections(ctx: Ctx): Promise<Section[]> {
  const where = expenseWhere(ctx);
  await guardSize(sql`select count(*)::int as n ${EXPENSE_FROM} where ${where}`, "report");
  const rows = (await db.execute(sql`
    select e.id, e.site_id, cs.name as site, e.expense_date::text as date, c.code as category, e.description,
           (select case when count(*) = 1 and not (max(quantity) = 1 and max(unit) in ('nos', 'lot'))
                        then trim(trailing '.' from trim(trailing '0' from max(quantity)::text)) || ' ' || max(unit) end
            from expense_items where expense_id = e.id) as qty,
           coalesce(sup.name, w.name) as payee, sup.gstin, e.payment_method, e.source, u.name as entered_by,
           e.total_amount::text as amount, (select count(*) from receipts r where r.expense_id = e.id and r.deleted_at is null)::int as receipts
    ${EXPENSE_FROM}
    where ${where}
    order by cs.name, e.expense_date, e.created_at, e.id
  `)) as unknown as Record<string, string | null>[];
  const subs = (await db.execute(sql`
    select e.site_id, count(*)::int as n, sum(e.total_amount)::text as amount ${EXPENSE_FROM} where ${where} group by e.site_id
  `)) as unknown as { site_id: string; n: number; amount: string }[];
  const [total] = (await db.execute(sql`
    select count(*)::int as n, coalesce(sum(e.total_amount), 0)::numeric(14, 2)::text as amount,
           coalesce(sum((select count(*) from receipts r where r.expense_id = e.id and r.deleted_at is null)::int), 0)::int as receipts,
           count(*) filter (where (select count(*) from receipts r where r.expense_id = e.id and r.deleted_at is null)::int = 0)::int as missing
    ${EXPENSE_FROM} where ${where}
  `)) as unknown as { n: number; amount: string; receipts: number; missing: number }[];

  const line = (r: Record<string, string | null>): Row => ({
    site_id: r.site_id,
    site: r.site,
    date: r.date,
    category: cat(r.category!),
    description: r.description,
    qty: r.qty,
    payee: r.payee,
    payment: PAYMENT_LABEL[r.payment_method as PaymentMode],
    source: r.source === "bill_payment" ? "Bill payment" : r.source === "purchase" ? "Purchase" : r.source === "voice" ? "Voice" : "Manual",
    entered_by: r.entered_by,
    receipts: r.receipts,
    amount: r.amount,
  });
  const subtotals = new Map(subs.map((s) => [s.site_id, { description: `Subtotal (${s.n} entries)`, amount: s.amount } as Row]));
  return [
    {
      title: "Expenses",
      columns: [
        { key: "date", label: "Date", type: "date", width: 11 },
        { key: "category", label: "Category", type: "text", width: 12 },
        { key: "description", label: "Description", type: "text", width: 34 },
        { key: "qty", label: "Quantity", type: "text", width: 11 },
        { key: "payee", label: "Supplier / worker", type: "text", width: 20 },
        { key: "payment", label: "Paid by", type: "text", width: 12 },
        { key: "source", label: "Source", type: "text", width: 11 },
        { key: "entered_by", label: "Entered by", type: "text", width: 15 },
        { key: "receipts", label: "Receipts", type: "int", width: 8 },
        { key: "amount", label: "Amount", type: "money", width: 15 },
      ],
      groups: grouped(rows.map(line), "site_id", subtotals, (r) => String(r.site)),
      total: { description: `Total (${total.n} entries, ${total.missing} without a receipt)`, receipts: total.receipts, amount: total.amount },
      empty: "No expenses match these filters in this period.",
    },
    ...(await categoriesSections(ctx, "By category")),
  ];
}

async function categoriesSections(ctx: Ctx, title = "Category totals"): Promise<Section[]> {
  const where = expenseWhere(ctx);
  const rows = (await db.execute(sql`
    select e.site_id, cs.name as site, c.code as category, c.sort_order, count(*)::int as n, sum(e.total_amount)::text as amount
    ${EXPENSE_FROM} where ${where}
    group by e.site_id, cs.name, c.code, c.sort_order
    order by cs.name, c.sort_order
  `)) as unknown as { site_id: string; site: string; category: string; n: number; amount: string }[];
  const subs = (await db.execute(sql`
    select e.site_id, count(*)::int as n, sum(e.total_amount)::text as amount ${EXPENSE_FROM} where ${where} group by e.site_id
  `)) as unknown as { site_id: string; n: number; amount: string }[];
  const byCat = (await db.execute(sql`
    select c.code as category, c.sort_order, count(*)::int as n, sum(e.total_amount)::text as amount,
           round(100.0 * sum(e.total_amount) / nullif(sum(sum(e.total_amount)) over (), 0), 1)::text as share
    ${EXPENSE_FROM} where ${where} group by c.code, c.sort_order order by sum(e.total_amount) desc
  `)) as unknown as { category: string; n: number; amount: string; share: string }[];
  const [total] = (await db.execute(sql`select count(*)::int as n, coalesce(sum(e.total_amount), 0)::numeric(14, 2)::text as amount ${EXPENSE_FROM} where ${where}`)) as unknown as { n: number; amount: string }[];

  const columns: Column[] = [
    { key: "category", label: "Category", type: "text", width: 24 },
    { key: "n", label: "Entries", type: "int", width: 10 },
    { key: "amount", label: "Amount", type: "money", width: 16 },
  ];
  const sections: Section[] = [];
  if (ctx.siteIds.length > 1 || title === "Category totals") {
    sections.push({
      title: ctx.siteIds.length > 1 ? `${title}, per site` : title,
      columns,
      groups: grouped(
        rows.map((r) => ({ site_id: r.site_id, site: r.site, category: cat(r.category), n: r.n, amount: r.amount })),
        "site_id",
        new Map(subs.map((s) => [s.site_id, { category: "Site subtotal", n: s.n, amount: s.amount } as Row])),
        (r) => String(r.site),
      ),
      total: { category: "Total", n: total.n, amount: total.amount },
      empty: "No expenses match these filters in this period.",
    });
  }
  sections.push({
    title: ctx.siteIds.length > 1 ? `${title}, all sites, highest first` : `${title}, highest first`,
    columns: [...columns, { key: "share", label: "Share", type: "percent", width: 10 }],
    groups: byCat.length ? [{ label: null, rows: byCat.map((r) => ({ category: cat(r.category), n: r.n, amount: r.amount, share: r.share })), subtotal: null }] : [],
    total: { category: "Total", n: total.n, amount: total.amount, share: byCat.length ? "100.0" : null },
    empty: "No expenses match these filters in this period.",
  });
  return sections;
}

async function purchasesSections({ f, siteIds }: Ctx): Promise<Section[]> {
  const parts: SQL[] = [sql`p.site_id in ${siteIds}`, sql`p.voided_at is null`, sql`p.purchase_date between ${f.from}::date and ${f.to}::date`];
  if (f.supplierName) parts.push(sql`sup.name = ${f.supplierName}`);
  if (f.paymentMethod) parts.push(sql`p.payment_method = ${f.paymentMethod}`);
  const where = sql.join(parts, sql` and `);
  const from = sql`
    from material_purchases p
    join material_purchase_items i on i.purchase_id = p.id
    join materials m on m.id = i.material_id
    join construction_sites cs on cs.id = p.site_id
    left join suppliers sup on sup.id = p.supplier_id
    left join supplier_bills b on b.id = p.supplier_bill_id
  `;
  await guardSize(sql`select count(*)::int as n ${from} where ${where}`, "report");
  const rows = (await db.execute(sql`
    select p.site_id, cs.name as site, p.purchase_date::text as date, sup.name as supplier, sup.gstin,
           p.invoice_number, p.delivery_ref, m.name as material, m.unit,
           trim(trailing '.' from trim(trailing '0' from i.quantity::text)) as qty, i.unit_price::text as unit_price, i.amount::text as amount,
           p.payment_method, b.bill_number
    ${from} where ${where}
    order by cs.name, p.purchase_date, p.created_at, i.position
  `)) as unknown as Record<string, string | null>[];
  const subs = (await db.execute(sql`select p.site_id, sum(i.amount)::text as amount, count(distinct p.id)::int as n ${from} where ${where} group by p.site_id`)) as unknown as { site_id: string; amount: string; n: number }[];
  const byMaterial = (await db.execute(sql`
    select m.name as material, m.unit, trim(trailing '.' from trim(trailing '0' from sum(i.quantity)::text)) as qty, sum(i.amount)::text as amount,
           round(sum(i.amount) / nullif(sum(i.quantity), 0), 2)::text as avg_price
    ${from} where ${where} group by m.name, m.unit order by sum(i.amount) desc
  `)) as unknown as Record<string, string>[];
  const [total] = (await db.execute(sql`
    select coalesce(sum(i.amount), 0)::numeric(14, 2)::text as amount, count(distinct p.id)::int as n,
           coalesce(sum(i.amount) filter (where p.payment_method = 'credit'), 0)::numeric(14, 2)::text as credit
    ${from} where ${where}
  `)) as unknown as { amount: string; n: number; credit: string }[];

  return [
    {
      title: "Material purchases",
      note: "Voided purchases are left out. Credit purchases are owed to the supplier until their bill is paid; see the supplier report.",
      columns: [
        { key: "date", label: "Date", type: "date", width: 11 },
        { key: "supplier", label: "Supplier", type: "text", width: 18 },
        { key: "gstin", label: "Supplier GSTIN", type: "text", width: 16 },
        { key: "invoice", label: "Invoice", type: "text", width: 11 },
        { key: "delivery", label: "Delivery note", type: "text", width: 11 },
        { key: "material", label: "Material", type: "text", width: 18 },
        { key: "qty", label: "Qty", type: "qty", width: 8 },
        { key: "unit", label: "Unit", type: "text", width: 7 },
        { key: "unit_price", label: "Rate", type: "money", width: 12 },
        { key: "payment", label: "Payment", type: "text", width: 13 },
        { key: "amount", label: "Amount", type: "money", width: 14 },
      ],
      groups: grouped(
        rows.map((r) => ({
          site_id: r.site_id,
          site: r.site,
          date: r.date,
          supplier: r.supplier,
          gstin: r.gstin ?? (r.supplier ? "Not recorded" : null),
          invoice: r.invoice_number,
          delivery: r.delivery_ref,
          material: r.material,
          qty: r.qty,
          unit: r.unit,
          unit_price: r.unit_price,
          payment: r.payment_method === "credit" ? `Credit, bill ${r.bill_number ?? "–"}` : PAYMENT_LABEL[r.payment_method as PaymentMode],
          amount: r.amount,
        })),
        "site_id",
        new Map(subs.map((s) => [s.site_id, { material: `Subtotal (${s.n} purchases)`, amount: s.amount } as Row])),
        (r) => String(r.site),
      ),
      total: { material: `Total (${total.n} purchases, ₹${total.credit} on credit)`, amount: total.amount },
      empty: "No material purchases in this period.",
    },
    {
      title: "Purchases by material",
      columns: [
        { key: "material", label: "Material", type: "text", width: 24 },
        { key: "qty", label: "Quantity", type: "qty", width: 12 },
        { key: "unit", label: "Unit", type: "text", width: 8 },
        { key: "avg_price", label: "Average rate", type: "money", width: 14 },
        { key: "amount", label: "Amount", type: "money", width: 16 },
      ],
      groups: byMaterial.length ? [{ label: null, rows: byMaterial, subtotal: null }] : [],
      total: { material: "Total", amount: total.amount },
      empty: "No material purchases in this period.",
    },
  ];
}

async function labourSections({ f, siteIds }: Ctx): Promise<Section[]> {
  const worker = f.workerName ? sql`and w.name = ${f.workerName}` : sql``;
  const attendanceFrom = sql`
    from labour_attendance a join labour_workers w on w.id = a.worker_id join construction_sites cs on cs.id = a.site_id
    where a.site_id in ${siteIds} and a.work_date between ${f.from}::date and ${f.to}::date ${worker}
  `;
  await guardSize(sql`select count(*)::int as n ${attendanceFrom}`, "report");
  // Earned and paid are each summed in their own subquery, per site and worker, so a join can't double them.
  const summary = (await db.execute(sql`
    with att as (
      select a.site_id, a.worker_id,
             count(*) filter (where a.status = 'present')::int as present,
             count(*) filter (where a.status = 'half_day')::int as half,
             count(*) filter (where a.status = 'absent')::int as absent,
             sum(case a.status when 'present' then 1 when 'half_day' then 0.5 else 0 end) as days,
             sum(a.wage_amount) as earned
      from labour_attendance a where a.site_id in ${siteIds} and a.work_date between ${f.from}::date and ${f.to}::date
      group by 1, 2
    ), pay as (
      select e.site_id, e.labour_worker_id as worker_id,
             sum(e.total_amount) filter (where coalesce(e.labour_kind, 'wage') = 'wage') as wages,
             sum(e.total_amount) filter (where e.labour_kind = 'advance') as advances
      from expenses e join expense_categories c on c.id = e.category_id
      where e.site_id in ${siteIds} and e.deleted_at is null and e.status = 'approved' and e.labour_worker_id is not null and c.code = 'labour'
        and e.expense_date between ${f.from}::date and ${f.to}::date
      group by 1, 2
    ), closing as (
      select site_id, worker_id, sum(amount) as balance from (
        select site_id, worker_id, wage_amount as amount from labour_attendance where site_id in ${siteIds} and work_date <= ${f.to}::date
        union all
        select e.site_id, e.labour_worker_id, -e.total_amount from expenses e join expense_categories c on c.id = e.category_id
        where e.site_id in ${siteIds} and e.deleted_at is null and e.status = 'approved' and e.labour_worker_id is not null and c.code = 'labour' and e.expense_date <= ${f.to}::date
      ) x group by 1, 2
    ), keys as (select site_id, worker_id from att union select site_id, worker_id from pay)
    select k.site_id, cs.name as site, w.name as worker, w.trade,
           coalesce(att.present, 0) as present, coalesce(att.half, 0) as half, coalesce(att.absent, 0) as absent,
           coalesce(att.days, 0)::text as days, coalesce(att.earned, 0)::numeric(14, 2)::text as earned,
           coalesce(pay.wages, 0)::numeric(14, 2)::text as wages, coalesce(pay.advances, 0)::numeric(14, 2)::text as advances,
           coalesce(closing.balance, 0)::numeric(14, 2)::text as balance
    from keys k
    join labour_workers w on w.id = k.worker_id
    join construction_sites cs on cs.id = k.site_id
    left join att on att.site_id = k.site_id and att.worker_id = k.worker_id
    left join pay on pay.site_id = k.site_id and pay.worker_id = k.worker_id
    left join closing on closing.site_id = k.site_id and closing.worker_id = k.worker_id
    where true ${worker}
    order by cs.name, w.name
  `)) as unknown as Record<string, string | number>[];

  const sumBy = (rows: Record<string, string | number>[], keys: string[]) =>
    db.execute(sql`select ${sql.join(keys.map((k) => sql`coalesce(sum((v->>${k})::numeric), 0)::numeric(14, 2)::text as ${sql.identifier(k)}`), sql`, `)}
                   from jsonb_array_elements(${JSON.stringify(rows)}::jsonb) v`) as unknown as Promise<Record<string, string>[]>;
  const moneyKeys = ["earned", "wages", "advances", "balance"];
  const siteSubs = new Map<string, Row>();
  for (const siteId of [...new Set(summary.map((r) => String(r.site_id)))]) {
    const [s] = await sumBy(summary.filter((r) => r.site_id === siteId), moneyKeys);
    siteSubs.set(siteId, { worker: "Site subtotal", ...s });
  }
  const [tot] = await sumBy(summary, moneyKeys);

  const attendance = (await db.execute(sql`
    select a.site_id, cs.name as site, a.work_date::text as date, w.name as worker, a.status, a.work_type, a.day_rate::text as day_rate, a.wage_amount::text as wage
    ${attendanceFrom}
    order by cs.name, a.work_date, w.name
  `)) as unknown as Record<string, string | null>[];
  const attSubs = (await db.execute(sql`select a.site_id, count(*)::int as n, sum(a.wage_amount)::text as wage ${attendanceFrom} group by a.site_id`)) as unknown as { site_id: string; n: number; wage: string }[];
  const [attTotal] = (await db.execute(sql`select count(*)::int as n, coalesce(sum(a.wage_amount), 0)::numeric(14, 2)::text as wage ${attendanceFrom}`)) as unknown as { n: number; wage: string }[];

  return [
    {
      title: "Wages by worker",
      note: "Earned is from attendance in the period. Paid is wages and advances paid in the period. Balance is everything up to the end of the period: positive is owed to the worker, negative is an advance not yet worked off.",
      columns: [
        { key: "worker", label: "Worker", type: "text", width: 18 },
        { key: "trade", label: "Work type", type: "text", width: 12 },
        { key: "present", label: "Present", type: "int", width: 8 },
        { key: "half", label: "Half days", type: "int", width: 8 },
        { key: "absent", label: "Absent", type: "int", width: 8 },
        { key: "days", label: "Days worked", type: "qty", width: 9 },
        { key: "earned", label: "Earned", type: "money", width: 13 },
        { key: "wages", label: "Wages paid", type: "money", width: 13 },
        { key: "advances", label: "Advances", type: "money", width: 13 },
        { key: "balance", label: "Balance at end", type: "money", width: 14 },
      ],
      groups: grouped(summary as Row[], "site_id", siteSubs, (r) => String(r.site)),
      total: { worker: "Total", ...tot },
      empty: "No attendance or labour payments in this period.",
    },
    {
      title: "Attendance",
      columns: [
        { key: "date", label: "Date", type: "date", width: 11 },
        { key: "worker", label: "Worker", type: "text", width: 20 },
        { key: "status", label: "Status", type: "text", width: 10 },
        { key: "work_type", label: "Work type", type: "text", width: 14 },
        { key: "day_rate", label: "Day rate", type: "money", width: 12 },
        { key: "wage", label: "Wage", type: "money", width: 12 },
      ],
      groups: grouped(
        attendance.map((a) => ({ ...a, status: STATUS_LABEL[a.status!] ?? a.status })),
        "site_id",
        new Map(attSubs.map((s) => [s.site_id, { worker: `Subtotal (${s.n} days marked)`, wage: s.wage } as Row])),
        (r) => String(r.site),
      ),
      total: { worker: `Total (${attTotal.n} days marked)`, wage: attTotal.wage },
      empty: "No attendance marked in this period.",
    },
  ];
}

async function suppliersSections({ f, siteIds }: Ctx): Promise<Section[]> {
  // Bills as they stood at the end of the period: payments after it don't count yet.
  const parts: SQL[] = [sql`b.site_id in ${siteIds}`, sql`b.bill_date <= ${f.to}::date`];
  if (f.supplierName) parts.push(sql`s.name = ${f.supplierName}`);
  if (f.categoryCode) parts.push(sql`c.code = ${f.categoryCode}`);
  const base = sql`
    select b.id, b.site_id, cs.name as site, s.name as supplier, s.gstin, b.bill_number, b.bill_date, b.due_date, b.amount, c.code as category,
           coalesce((select sum(p.amount) from payments p where p.supplier_bill_id = b.id and p.paid_on <= ${f.to}::date), 0) as paid,
           exists(select 1 from receipts r where r.supplier_bill_id = b.id and r.deleted_at is null) as has_file
    from supplier_bills b join suppliers s on s.id = b.supplier_id join construction_sites cs on cs.id = b.site_id
    join expense_categories c on c.id = b.category_id
    where ${sql.join(parts, sql` and `)}
  `;
  // Bills dated in the period, plus older ones still unpaid at its end.
  const scoped = sql`select * from (${base}) x where x.bill_date >= ${f.from}::date or x.amount > x.paid`;
  await guardSize(sql`select count(*)::int as n from (${scoped}) y`, "report");
  const rows = (await db.execute(sql`
    select site, supplier, gstin, bill_number, bill_date::text as bill_date, due_date::text as due_date, category,
           case when has_file then 'Attached' else 'None' end as file,
           amount::text as amount, paid::numeric(14, 2)::text as paid, (amount - paid)::numeric(14, 2)::text as outstanding,
           case when paid >= amount then 'Paid' when due_date < ${f.to}::date then 'Overdue' when paid > 0 then 'Part paid' else 'Pending' end as status
    from (${scoped}) y order by supplier, bill_date, bill_number
  `)) as unknown as Record<string, string | null>[];
  const subs = (await db.execute(sql`
    select supplier, count(*)::int as n, sum(amount)::text as amount, sum(paid)::numeric(14, 2)::text as paid, sum(amount - paid)::numeric(14, 2)::text as outstanding
    from (${scoped}) y group by supplier
  `)) as unknown as { supplier: string; n: number; amount: string; paid: string; outstanding: string }[];
  const [total] = (await db.execute(sql`
    select count(*)::int as n, coalesce(sum(amount), 0)::numeric(14, 2)::text as amount, coalesce(sum(paid), 0)::numeric(14, 2)::text as paid,
           coalesce(sum(amount - paid), 0)::numeric(14, 2)::text as outstanding,
           coalesce(sum(amount - paid) filter (where due_date < ${f.to}::date), 0)::numeric(14, 2)::text as overdue
    from (${scoped}) y
  `)) as unknown as { n: number; amount: string; paid: string; outstanding: string; overdue: string }[];

  const payments = (await db.execute(sql`
    select cs.name as site, s.name as supplier, b.bill_number, p.paid_on::text as paid_on, p.method, p.reference, u.name as entered_by, p.amount::text as amount
    from payments p join supplier_bills b on b.id = p.supplier_bill_id join suppliers s on s.id = b.supplier_id
    join construction_sites cs on cs.id = p.site_id join users u on u.id = p.created_by join expense_categories c on c.id = b.category_id
    where p.site_id in ${siteIds} and p.paid_on between ${f.from}::date and ${f.to}::date
      ${f.supplierName ? sql`and s.name = ${f.supplierName}` : sql``} ${f.categoryCode ? sql`and c.code = ${f.categoryCode}` : sql``}
    order by s.name, p.paid_on, p.created_at
  `)) as unknown as Record<string, string | null>[];
  const [paidTotal] = (await db.execute(sql`
    select coalesce(sum(p.amount), 0)::numeric(14, 2)::text as amount, count(*)::int as n
    from payments p join supplier_bills b on b.id = p.supplier_bill_id join suppliers s on s.id = b.supplier_id join expense_categories c on c.id = b.category_id
    where p.site_id in ${siteIds} and p.paid_on between ${f.from}::date and ${f.to}::date
      ${f.supplierName ? sql`and s.name = ${f.supplierName}` : sql``} ${f.categoryCode ? sql`and c.code = ${f.categoryCode}` : sql``}
  `)) as unknown as { amount: string; n: number }[];

  return [
    {
      title: "Supplier bills and balances",
      note: `Balances as at ${f.to}: bills dated in the period, and earlier bills still unpaid then. Payments after ${f.to} are not counted.`,
      columns: [
        { key: "bill_number", label: "Invoice no.", type: "text", width: 13 },
        { key: "gstin", label: "Supplier GSTIN", type: "text", width: 16 },
        { key: "site", label: "Site", type: "text", width: 16 },
        { key: "category", label: "Category", type: "text", width: 11 },
        { key: "bill_date", label: "Bill date", type: "date", width: 11 },
        { key: "due_date", label: "Due", type: "date", width: 11 },
        { key: "status", label: "Status", type: "text", width: 9 },
        { key: "file", label: "Bill file", type: "text", width: 9 },
        { key: "amount", label: "Billed", type: "money", width: 13 },
        { key: "paid", label: "Paid", type: "money", width: 13 },
        { key: "outstanding", label: "Outstanding", type: "money", width: 13 },
      ],
      groups: grouped(
        rows.map((r) => ({ ...r, gstin: r.gstin ?? "Not recorded", category: cat(r.category!) })),
        "supplier",
        new Map(subs.map((s) => [s.supplier, { bill_number: `Subtotal (${s.n} bills)`, amount: s.amount, paid: s.paid, outstanding: s.outstanding } as Row])),
        (r) => String(r.supplier),
      ),
      total: { bill_number: `Total (${total.n} bills, ₹${total.overdue} overdue)`, amount: total.amount, paid: total.paid, outstanding: total.outstanding },
      empty: "No supplier bills for this period.",
    },
    {
      title: "Payments to suppliers in the period",
      columns: [
        { key: "paid_on", label: "Paid on", type: "date", width: 11 },
        { key: "bill_number", label: "Invoice no.", type: "text", width: 13 },
        { key: "site", label: "Site", type: "text", width: 18 },
        { key: "method", label: "Method", type: "text", width: 13 },
        { key: "reference", label: "Reference", type: "text", width: 18 },
        { key: "entered_by", label: "Entered by", type: "text", width: 15 },
        { key: "amount", label: "Amount", type: "money", width: 14 },
      ],
      groups: grouped(
        payments.map((p) => ({ ...p, method: PAYMENT_LABEL[p.method as PaymentMode] })),
        "supplier",
        new Map(),
        (r) => String(r.supplier),
      ),
      total: { bill_number: `Total (${paidTotal.n} payments)`, amount: paidTotal.amount },
      empty: "No payments to suppliers in this period.",
    },
  ];
}

async function budgetSections({ f, siteIds }: Ctx): Promise<Section[]> {
  const catFilter = f.categoryCode ? sql`and (x.category = ${f.categoryCode} or x.category is null)` : sql``;
  const rows = (await db.execute(sql`
    with spend as (
      select e.site_id, c.code,
             sum(e.total_amount) filter (where e.expense_date between ${f.from}::date and ${f.to}::date) as period,
             sum(e.total_amount) filter (where e.expense_date <= ${f.to}::date) as to_date
      from expenses e join expense_categories c on c.id = e.category_id
      where e.site_id in ${siteIds} and e.deleted_at is null and e.status = 'approved' group by 1, 2
    ), lines as (
      -- Every budget line, plus categories with spending but no budget line.
      select b.site_id, c.code as category, b.amount as budget, b.alert_percent from site_budgets b
      left join expense_categories c on c.id = b.category_id where b.site_id in ${siteIds}
      union all
      select s.site_id, s.code, null, null from spend s
      where coalesce(s.to_date, 0) > 0 and not exists (
        select 1 from site_budgets b join expense_categories c on c.id = b.category_id where b.site_id = s.site_id and c.code = s.code)
    )
    select x.site_id, cs.name as site, x.category, x.budget::text as budget, x.alert_percent,
           coalesce((select sum(period) from spend where spend.site_id = x.site_id and (x.category is null or spend.code = x.category)), 0)::numeric(14, 2)::text as period,
           coalesce((select sum(to_date) from spend where spend.site_id = x.site_id and (x.category is null or spend.code = x.category)), 0)::numeric(14, 2)::text as to_date
    from lines x join construction_sites cs on cs.id = x.site_id left join expense_categories ec on ec.code = x.category and ec.organization_id = cs.organization_id
    where true ${catFilter}
    order by cs.name, x.category is not null, ec.sort_order
  `)) as unknown as { site_id: string; site: string; category: string | null; budget: string | null; alert_percent: number | null; period: string; to_date: string }[];
  const withMath = (await db.execute(sql`
    select (v->>'i')::int as i,
           case when v->>'budget' is null then null else ((v->>'budget')::numeric - (v->>'to_date')::numeric)::numeric(14, 2)::text end as remaining,
           case when coalesce((v->>'budget')::numeric, 0) > 0 then round(100 * (v->>'to_date')::numeric / (v->>'budget')::numeric, 1)::text end as used
    from jsonb_array_elements(${JSON.stringify(rows.map((r, i) => ({ i, budget: r.budget, to_date: r.to_date })))}::jsonb) v
  `)) as unknown as { i: number; remaining: string | null; used: string | null }[];
  const math = new Map(withMath.map((m) => [m.i, m]));

  return [
    {
      title: "Budget versus actual",
      note: `Spent in period covers ${f.from} to ${f.to}; spent to date is everything up to ${f.to}, which the budget is measured against. The total line covers every category.`,
      columns: [
        { key: "line", label: "Budget line", type: "text", width: 20 },
        { key: "budget", label: "Budget", type: "money", width: 15 },
        { key: "period", label: "Spent in period", type: "money", width: 15 },
        { key: "to_date", label: "Spent to date", type: "money", width: 15 },
        { key: "remaining", label: "Remaining", type: "money", width: 15 },
        { key: "used", label: "Used", type: "percent", width: 9 },
        { key: "status", label: "Status", type: "text", width: 16 },
      ],
      groups: grouped(
        rows.map((r, i) => {
          const m = math.get(i)!;
          const used = m.used === null ? null : Number(m.used);
          return {
            site_id: r.site_id,
            site: r.site,
            line: r.category ? cat(r.category) : "Total budget",
            budget: r.budget,
            period: r.period,
            to_date: r.to_date,
            remaining: m.remaining,
            used: m.used,
            status:
              r.budget === null ? "No budget line" : used === null ? (Number(r.to_date) > 0 ? "Over budget" : "–") : used > 100 ? "Over budget" : used >= (r.alert_percent ?? 80) ? `Past ${r.alert_percent}% alert` : "Within budget",
          };
        }),
        "site_id",
        new Map(),
        (r) => String(r.site),
      ),
      total: null,
      empty: "No budgets or spending for these sites.",
    },
  ];
}

async function paymentsSections(ctx: Ctx): Promise<Section[]> {
  const where = expenseWhere(ctx);
  await guardSize(sql`select count(*)::int as n ${EXPENSE_FROM} where ${where}`, "report");
  const rows = (await db.execute(sql`
    select e.expense_date::text as date, cs.name as site, ${PAYMENT_KIND} as kind, e.payment_method, coalesce(sup.name, w.name) as payee,
           e.description, coalesce((select p.reference from payments p where p.expense_id = e.id limit 1), e.notes) as reference,
           u.name as entered_by, e.total_amount::text as amount, (select count(*) from receipts r where r.expense_id = e.id and r.deleted_at is null)::int as receipts
    ${EXPENSE_FROM} where ${where}
    order by e.payment_method, e.expense_date, e.created_at
  `)) as unknown as Record<string, string | null>[];
  const byMethod = (await db.execute(sql`select e.payment_method, count(*)::int as n, sum(e.total_amount)::text as amount ${EXPENSE_FROM} where ${where} group by 1`)) as unknown as { payment_method: string; n: number; amount: string }[];
  const byKind = (await db.execute(sql`select ${PAYMENT_KIND} as kind, count(*)::int as n, sum(e.total_amount)::text as amount ${EXPENSE_FROM} where ${where} group by 1 order by sum(e.total_amount) desc`)) as unknown as { kind: string; n: number; amount: string }[];
  const [total] = (await db.execute(sql`select count(*)::int as n, coalesce(sum(e.total_amount), 0)::numeric(14, 2)::text as amount ${EXPENSE_FROM} where ${where}`)) as unknown as { n: number; amount: string }[];

  return [
    {
      title: "Payments",
      note: "Every rupee paid out in the period, once. Supplier bill payments, purchases paid on the spot, wages and advances are all included; amounts still owed are not.",
      columns: [
        { key: "date", label: "Date", type: "date", width: 11 },
        { key: "site", label: "Site", type: "text", width: 16 },
        { key: "kind", label: "Type", type: "text", width: 17 },
        { key: "payee", label: "Paid to", type: "text", width: 18 },
        { key: "description", label: "Description", type: "text", width: 28 },
        { key: "reference", label: "Reference / note", type: "text", width: 18 },
        { key: "entered_by", label: "Entered by", type: "text", width: 14 },
        { key: "receipts", label: "Receipts", type: "int", width: 8 },
        { key: "amount", label: "Amount", type: "money", width: 14 },
      ],
      groups: grouped(
        rows.map((r) => ({ ...r, kind: KIND_LABEL[r.kind!], method: r.payment_method })),
        "method",
        new Map(byMethod.map((m) => [m.payment_method, { description: `Subtotal (${m.n} payments)`, amount: m.amount } as Row])),
        (r) => PAYMENT_LABEL[r.method as PaymentMode],
      ),
      total: { description: `Total (${total.n} payments)`, amount: total.amount },
      empty: "No payments match these filters in this period.",
    },
    {
      title: "Payments by type",
      columns: [
        { key: "kind", label: "Type", type: "text", width: 26 },
        { key: "n", label: "Payments", type: "int", width: 10 },
        { key: "amount", label: "Amount", type: "money", width: 16 },
      ],
      groups: byKind.length ? [{ label: null, rows: byKind.map((k) => ({ kind: KIND_LABEL[k.kind], n: k.n, amount: k.amount })), subtotal: null }] : [],
      total: { kind: "Total", n: total.n, amount: total.amount },
      empty: "No payments match these filters in this period.",
    },
  ];
}

const BUILDERS: Record<ReportKind, (ctx: Ctx) => Promise<Section[]>> = {
  expenses: expensesSections,
  categories: (ctx) => categoriesSections(ctx),
  purchases: purchasesSections,
  labour: labourSections,
  suppliers: suppliersSections,
  budget: budgetSections,
  payments: paymentsSections,
};

/**
 * Validates filters, limits the report to sites the actor may export, and builds it.
 * Asking for one site you can't export is Forbidden (NotFound if you can't see it);
 * a consolidated report includes only the sites you can export.
 */
export async function buildReport(actor: Actor, raw: unknown): Promise<Report> {
  const f = exportFilters.parse(raw);
  const t = today();
  if (f.to > t) throw new ValidationError("The period can't end in the future.", { to: "Pick today or earlier." });
  if (daysBetween(f.from, f.to) > 366 * 3) throw new ValidationError("Pick a period of three years or less.", { from: "Period too long." });
  const siteIds = await scopeSiteIds(actor, f.siteId, db, "report:export");
  if (siteIds.length === 0) throw new ForbiddenError("Only site owners and accountants can download reports.");

  const sites = (await db.execute(sql`
    select s.name, s.location, s.client_name, s.status, s.start_date::text as start_date, b.amount::text as budget
    from construction_sites s left join site_budgets b on b.site_id = s.id and b.category_id is null
    where s.id in ${siteIds} order by s.name
  `)) as unknown as { name: string; location: string; client_name: string | null; status: string; start_date: string; budget: string | null }[];

  const applies = APPLIES[f.kind];
  const set = (["categoryCode", "workerName", "supplierName", "paymentMethod"] as const).filter((k) => f[k]);
  return {
    kind: f.kind,
    title: REPORT_TITLES[f.kind],
    organization: actor.orgName,
    sites: sites.map((s) => ({ name: s.name, location: s.location, client: s.client_name, status: STATUS_LABEL[s.status] ?? s.status, startDate: s.start_date, budget: s.budget })),
    consolidated: siteIds.length > 1,
    period: { from: f.from, to: f.to, days: daysBetween(f.from, f.to) + 1 },
    filters: set.filter((k) => applies.includes(k)).map((k) => label(k, f[k]!)),
    ignored: set.filter((k) => !applies.includes(k)).map((k) => label(k, f[k]!)),
    generatedAt: new Date().toISOString(),
    generatedBy: actor.name,
    sections: await BUILDERS[f.kind]({ f, siteIds, t }),
    notes: [STATEMENT_NOTE],
  };
}

