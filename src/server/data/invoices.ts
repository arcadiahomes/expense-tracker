import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { clientInvoiceItems, clientInvoices, constructionSites, labourWorkers } from "@/db/schema";
import { formatINR } from "@/lib/format";
import type { ClientInvoice, ClientInvoiceItem, InvoiceStatus, LabourInvoice, LabourInvoiceLine, Page, PaymentMode } from "@/lib/types";
import { can, requireSitePermission, scopeSiteIds, siteRoleFor, type Actor } from "../authz";
import { NotFoundError, ValidationError } from "../errors";
import { clientInvoiceInput, invoiceCancelInput, invoiceFilters, labourInvoiceInput, uuid } from "../validation";
import { audit } from "./audit";
import { decodeCursor, encodeCursor, num, rethrowUnique, today, type Conn } from "./shared";

/**
 * Two kinds of invoice, both for people with `finance:manage` on the site (owners, accountants):
 * - Client invoices: what the company bills its client. Stored, numbered per organization,
 *   never edited once issued (cancel and issue a new one). They are money owed *to* the
 *   company, so they never touch expenses, budgets or spend. What the client has paid
 *   against one is summed from client_payments (data/client-payments.ts).
 * - Labour invoices: a worker's wages for a period on a site. Built on request from attendance
 *   (earned) and labour payments (paid), with the same definitions as the labour balances,
 *   so nothing is stored that could drift from them.
 */

// ---- Client invoices ------------------------------------------------------------

type InvoiceRow = {
  id: string;
  site_id: string;
  site_name: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  client_name: string;
  client_address: string | null;
  client_gstin: string | null;
  client_phone: string | null;
  client_email: string | null;
  gst_percent: string;
  notes: string | null;
  subtotal: string;
  gst: string;
  total: string;
  paid: string;
  balance: string;
  receipts: number;
  status: InvoiceStatus;
  paid_on: string | null;
  paid_method: PaymentMode | null;
  paid_reference: string | null;
  cancel_reason: string | null;
  created_by: string;
};

/**
 * An invoice's total: the sum of its item amounts plus GST at the entered rate on that
 * subtotal, rounded to paise. `i` is the client_invoices row in the surrounding query.
 */
export const invoiceTotalSql = sql`(
  select (s.subtotal + round(s.subtotal * i.gst_percent / 100, 2))::numeric(14, 2)
  from (select coalesce(sum(amount), 0) as subtotal from client_invoice_items where invoice_id = i.id) s
)`;

/** Net paid on invoice `i`: payments less refunds and reversals. */
export const invoicePaidSql = sql`(
  select coalesce(sum(case p.kind when 'payment' then p.amount else -p.amount end), 0)::numeric(14, 2)
  from client_payments p where p.invoice_id = i.id
)`;

/**
 * Invoices with their totals and status, all worked out here: subtotal is the sum of item
 * amounts, GST is the entered rate on that subtotal rounded to paise, paid is summed from
 * client payments, and the invoice is paid once nothing is left to receive. Otherwise it's
 * overdue past its due date (part paid or not), or unpaid.
 */
export function invoicesQuery(siteIds: string[], onDate: string) {
  return sql`
    select i.id, i.site_id, cs.name as site_name, i.invoice_number, i.invoice_date::text as invoice_date,
           i.due_date::text as due_date, i.client_name, i.client_address, i.client_gstin, i.client_phone, i.client_email,
           i.gst_percent::text as gst_percent, i.notes, t.subtotal::text as subtotal, t.gst::text as gst,
           (t.subtotal + t.gst)::text as total, pay.paid::text as paid, (t.subtotal + t.gst - pay.paid)::text as balance,
           pay.receipts,
           case
             when i.cancelled_at is not null then 'cancelled'
             when t.subtotal + t.gst - pay.paid <= 0 then 'paid'
             when i.due_date < ${onDate}::date then 'overdue'
             else 'unpaid'
           end as status,
           last.paid_on::text as paid_on, last.method as paid_method, last.reference as paid_reference,
           i.cancel_reason, u.name as created_by
    from client_invoices i
    join construction_sites cs on cs.id = i.site_id
    join users u on u.id = i.created_by
    left join lateral (
      select s.subtotal, round(s.subtotal * i.gst_percent / 100, 2)::numeric(14, 2) as gst
      from (select coalesce(sum(amount), 0)::numeric(14, 2) as subtotal from client_invoice_items where invoice_id = i.id) s
    ) t on true
    left join lateral (
      select coalesce(sum(case p.kind when 'payment' then p.amount else -p.amount end), 0)::numeric(14, 2) as paid,
             count(*) filter (where p.kind = 'payment')::int as receipts
      from client_payments p where p.invoice_id = i.id
    ) pay on true
    left join lateral (
      select p.paid_on, p.method, p.reference from client_payments p
      where p.invoice_id = i.id and p.kind = 'payment'
        and not exists (select 1 from client_payments r where r.related_id = p.id and r.kind = 'reversal')
      order by p.seq desc limit 1
    ) last on t.subtotal + t.gst - pay.paid <= 0
    where i.site_id in ${siteIds}
  `;
}

async function itemsFor(ids: string[], conn: Conn = db) {
  const out = new Map<string, ClientInvoiceItem[]>();
  if (!ids.length) return out;
  const rows = await conn
    .select()
    .from(clientInvoiceItems)
    .where(inArray(clientInvoiceItems.invoiceId, ids))
    .orderBy(asc(clientInvoiceItems.invoiceId), asc(clientInvoiceItems.position));
  for (const r of rows) {
    const list = out.get(r.invoiceId) ?? [];
    list.push({ description: r.description, quantity: r.quantity, unit: r.unit, unitPrice: r.unitPrice, amount: r.amount });
    out.set(r.invoiceId, list);
  }
  return out;
}

function toDto(r: InvoiceRow, items: Map<string, ClientInvoiceItem[]>): ClientInvoice {
  return {
    id: r.id,
    siteId: r.site_id,
    siteName: r.site_name,
    invoiceNo: r.invoice_number,
    date: r.invoice_date,
    dueDate: r.due_date,
    client: r.client_name,
    clientAddress: r.client_address ?? "",
    clientGstin: r.client_gstin ?? "",
    clientPhone: r.client_phone ?? "",
    clientEmail: r.client_email ?? "",
    gstPercent: num(r.gst_percent),
    subtotal: num(r.subtotal),
    gst: num(r.gst),
    total: num(r.total),
    paid: num(r.paid),
    balance: num(r.balance),
    receipts: Number(r.receipts),
    status: r.status,
    notes: r.notes ?? "",
    items: items.get(r.id) ?? [],
    paidOn: r.paid_on ?? undefined,
    paidMethod: r.paid_method ?? undefined,
    paidReference: r.paid_reference ?? undefined,
    cancelReason: r.cancel_reason ?? undefined,
    createdBy: r.created_by,
  };
}

/** Sites the actor invoices for, with the client recorded on each (to pre-fill new invoices). */
export async function invoiceSites(actor: Actor) {
  const ids = await scopeSiteIds(actor, null, db, "finance:manage");
  if (!ids.length) return [];
  return db
    .select({ id: constructionSites.id, name: constructionSites.name, client: constructionSites.clientName })
    .from(constructionSites)
    .where(inArray(constructionSites.id, ids))
    .orderBy(asc(constructionSites.name));
}

type InvoiceCursor = { d: string; i: string };

/** Invoices on sites the actor manages finance for, newest first, keyset-paginated. */
export async function listClientInvoices(actor: Actor, raw: unknown = {}): Promise<Page<ClientInvoice>> {
  const f = invoiceFilters.parse(raw);
  const siteIds = await scopeSiteIds(actor, f.siteId, db, "finance:manage");
  if (!siteIds.length) return { items: [], nextCursor: null };
  const cursor = decodeCursor<InvoiceCursor>(f.cursor);
  const q = f.q ? `%${f.q.replace(/[%_\\]/g, "\\$&")}%` : null;
  const rows = (await db.execute(sql`
    with i as (${invoicesQuery(siteIds, today())})
    select * from i
    where (${f.status} = 'all' or i.status = ${f.status})
      and (${q}::text is null or i.client_name ilike ${q} or i.invoice_number ilike ${q} or i.site_name ilike ${q})
      and (${cursor?.d ?? null}::date is null or (i.invoice_date::date, i.id) < (${cursor?.d ?? null}::date, ${cursor?.i ?? null}::uuid))
    order by i.invoice_date desc, i.id desc
    limit ${f.limit + 1}
  `)) as unknown as InvoiceRow[];
  const page = rows.slice(0, f.limit);
  const items = await itemsFor(page.map((r) => r.id));
  const last = page.at(-1);
  return {
    items: page.map((r) => toDto(r, items)),
    nextCursor: rows.length > f.limit && last ? encodeCursor({ d: last.invoice_date, i: last.id }) : null,
  };
}

/**
 * Header figures and tab counts. Outstanding and overdue are what's left to receive on
 * open invoices (part payments taken off); received is net of refunds. Cancelled invoices
 * are counted but never owed.
 */
export async function invoiceTotals(actor: Actor) {
  const siteIds = await scopeSiteIds(actor, null, db, "finance:manage");
  const empty = { outstanding: 0, overdueAmount: 0, overdueCount: 0, received: 0, counts: { all: 0, unpaid: 0, overdue: 0, paid: 0, cancelled: 0 } };
  if (!siteIds.length) return empty;
  const [r] = (await db.execute(sql`
    with i as (${invoicesQuery(siteIds, today())})
    select
      coalesce(sum(i.balance::numeric) filter (where i.status in ('unpaid', 'overdue')), 0) as outstanding,
      coalesce(sum(i.balance::numeric) filter (where i.status = 'overdue'), 0) as overdue_amount,
      coalesce(sum(i.paid::numeric), 0) as received,
      count(*)::int as c_all,
      count(*) filter (where i.status = 'unpaid')::int as c_unpaid,
      count(*) filter (where i.status = 'overdue')::int as c_overdue,
      count(*) filter (where i.status = 'paid')::int as c_paid,
      count(*) filter (where i.status = 'cancelled')::int as c_cancelled
    from i
  `)) as unknown as Record<string, string | number>[];
  return {
    outstanding: num(r.outstanding),
    overdueAmount: num(r.overdue_amount),
    overdueCount: Number(r.c_overdue),
    received: num(r.received),
    counts: {
      all: Number(r.c_all),
      unpaid: Number(r.c_unpaid),
      overdue: Number(r.c_overdue),
      paid: Number(r.c_paid),
      cancelled: Number(r.c_cancelled),
    },
  };
}

/** One invoice, for anyone who manages finance on its site; NotFound for everyone else. */
export async function getClientInvoice(actor: Actor, id: string, conn: Conn = db): Promise<ClientInvoice> {
  if (!uuid.safeParse(id).success) throw new NotFoundError("Invoice");
  const [meta] = await conn.select({ siteId: clientInvoices.siteId }).from(clientInvoices).where(eq(clientInvoices.id, id)).limit(1);
  if (!meta || !can(await siteRoleFor(actor, meta.siteId, conn), "finance:manage")) throw new NotFoundError("Invoice");
  const rows = (await conn.execute(sql`
    with i as (${invoicesQuery([meta.siteId], today())}) select * from i where i.id = ${id}
  `)) as unknown as InvoiceRow[];
  return toDto(rows[0], await itemsFor([id], conn));
}

/** Indian financial year of a date: 2026-10-22 → "2026-27", 2027-02-01 → "2026-27". */
export function financialYear(isoDate: string) {
  const y = Number(isoDate.slice(0, 4));
  const start = Number(isoDate.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/**
 * The next number in the organization's series for the invoice date's financial year,
 * e.g. INV/2026-27/0007. Called under the organization's invoice lock.
 */
async function nextInvoiceNumber(conn: Conn, orgId: string, invoiceDate: string) {
  const prefix = `INV/${financialYear(invoiceDate)}/`;
  const [row] = (await conn.execute(sql`
    select coalesce(max(substring(invoice_number from '([0-9]+)$')::int), 0) + 1 as next
    from client_invoices
    where organization_id = ${orgId} and invoice_number like ${`${prefix}%`} and invoice_number ~ ${"^INV/[0-9]{4}-[0-9]{2}/[0-9]+$"}
  `)) as unknown as { next: number }[];
  return `${prefix}${String(row.next).padStart(4, "0")}`;
}

export async function createClientInvoice(actor: Actor, raw: unknown): Promise<ClientInvoice> {
  const input = clientInvoiceInput.parse(raw);
  await requireSitePermission(actor, input.siteId, "finance:manage");
  const id = await db
    .transaction(async (tx) => {
      // Serializes numbering so two invoices saved together can't take the same number.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`invoice:${actor.orgId}`}, 0))`);
      const invoiceNumber = input.invoiceNumber ?? (await nextInvoiceNumber(tx, actor.orgId, input.invoiceDate));
      const [row] = await tx
        .insert(clientInvoices)
        .values({
          organizationId: actor.orgId,
          siteId: input.siteId,
          invoiceNumber,
          invoiceDate: input.invoiceDate,
          dueDate: input.dueDate,
          clientName: input.clientName,
          clientAddress: input.clientAddress,
          clientGstin: input.clientGstin,
          clientPhone: input.clientPhone,
          clientEmail: input.clientEmail,
          gstPercent: input.gstPercent,
          notes: input.notes,
          createdBy: actor.userId,
        })
        .returning({ id: clientInvoices.id });
      await tx.insert(clientInvoiceItems).values(
        input.items.map((it, position) => ({ invoiceId: row.id, position, description: it.description, quantity: it.quantity, unit: it.unit, unitPrice: it.unitPrice })),
      );
      const [{ total }] = (await tx.execute(sql`
        select (s.subtotal + round(s.subtotal * ${input.gstPercent}::numeric / 100, 2))::text as total
        from (select coalesce(sum(amount), 0) as subtotal from client_invoice_items where invoice_id = ${row.id}) s
      `)) as unknown as { total: string }[];
      await audit(tx, actor, {
        siteId: input.siteId,
        action: "invoice.create",
        entityType: "client_invoice",
        entityId: row.id,
        summary: `Invoice ${invoiceNumber} to ${input.clientName} for ${formatINR(num(total))}`,
        data: { ...input, invoiceNumber, total },
      });
      return row.id;
    })
    .catch((err) => rethrowUnique(err, "invoiceNumber", "An invoice with this number already exists."));
  return getClientInvoice(actor, id);
}

/** Locks the invoice and checks the actor manages finance on its site. */
export async function lockInvoice(actor: Actor, id: string, conn: Conn) {
  const [row] = await conn.select().from(clientInvoices).where(eq(clientInvoices.id, id)).for("update");
  if (!row || row.organizationId !== actor.orgId) throw new NotFoundError("Invoice");
  await requireSitePermission(actor, row.siteId, "finance:manage", conn);
  return row;
}

/**
 * Cancels an invoice nothing has been received against. It stays listed (and keeps its
 * number) with the reason. Money received has to be refunded or reversed first, so the
 * receipts never point at a cancelled invoice with money still on it.
 */
export async function cancelInvoice(actor: Actor, raw: unknown): Promise<ClientInvoice> {
  const input = invoiceCancelInput.parse(raw);
  await db.transaction(async (tx) => {
    const inv = await lockInvoice(actor, input.id, tx);
    if (inv.cancelledAt) throw new ValidationError("This invoice is already cancelled.");
    const [{ paid }] = (await tx.execute(sql`select ${invoicePaidSql}::text as paid from client_invoices i where i.id = ${inv.id}`)) as unknown as { paid: string }[];
    if (num(paid) > 0) throw new ValidationError(`${formatINR(num(paid))} has been received against this invoice. Refund or reverse it before cancelling.`);
    await tx
      .update(clientInvoices)
      .set({ cancelledAt: new Date(), cancelledBy: actor.userId, cancelReason: input.reason })
      .where(eq(clientInvoices.id, inv.id));
    await audit(tx, actor, {
      siteId: inv.siteId,
      action: "invoice.cancel",
      entityType: "client_invoice",
      entityId: inv.id,
      summary: `Cancelled invoice ${inv.invoiceNumber}: ${input.reason}`,
      data: input,
    });
  });
  return getClientInvoice(actor, input.id);
}

// ---- Labour invoices -------------------------------------------------------------

/**
 * A worker's wages on one site for a period. Earned and paid follow the labour balances
 * exactly (attendance wage amounts; approved, undeleted labour expenses naming the worker,
 * wages being anything not marked as an advance), so the closing figure here is the
 * worker's balance as of the period's end.
 */
export async function labourInvoice(actor: Actor, raw: unknown): Promise<LabourInvoice> {
  const f = labourInvoiceInput.parse(raw);
  await requireSitePermission(actor, f.siteId, "finance:manage");
  if (f.to > today()) throw new ValidationError("The period can't end after today.", { to: "Pick today or earlier." });
  const [[site], [worker]] = await Promise.all([
    db
      .select({ id: constructionSites.id, name: constructionSites.name, location: constructionSites.location, client: constructionSites.clientName })
      .from(constructionSites)
      .where(eq(constructionSites.id, f.siteId))
      .limit(1),
    db
      .select({ id: labourWorkers.id, name: labourWorkers.name, trade: labourWorkers.trade, phone: labourWorkers.phone })
      .from(labourWorkers)
      .where(and(eq(labourWorkers.id, f.workerId), eq(labourWorkers.organizationId, actor.orgId)))
      .limit(1),
  ]);
  if (!worker) throw new NotFoundError("Worker");

  const paidFrom = sql`
    from expenses e join expense_categories c on c.id = e.category_id
    where e.site_id = ${f.siteId} and e.labour_worker_id = ${f.workerId}
      and e.deleted_at is null and e.status = 'approved' and c.code = 'labour'
  `;
  const [[sums], attendance, payments] = await Promise.all([
    db.execute(sql`
      with earned as (
        select coalesce(sum(wage_amount) filter (where work_date < ${f.from}::date), 0) as before,
               coalesce(sum(wage_amount) filter (where work_date between ${f.from}::date and ${f.to}::date), 0) as earned,
               coalesce(sum(case status when 'present' then 1 when 'half_day' then 0.5 else 0 end)
                 filter (where work_date between ${f.from}::date and ${f.to}::date), 0) as days
        from labour_attendance where site_id = ${f.siteId} and worker_id = ${f.workerId}
      ), paid as (
        select coalesce(sum(e.total_amount) filter (where e.expense_date < ${f.from}::date), 0) as before,
               coalesce(sum(e.total_amount) filter (where e.expense_date between ${f.from}::date and ${f.to}::date and coalesce(e.labour_kind, 'wage') = 'wage'), 0) as wages,
               coalesce(sum(e.total_amount) filter (where e.expense_date between ${f.from}::date and ${f.to}::date and e.labour_kind = 'advance'), 0) as advances
        ${paidFrom}
      )
      select earned.days::text as days,
             (earned.before - paid.before)::numeric(14, 2)::text as opening,
             earned.earned::numeric(14, 2)::text as earned,
             paid.wages::numeric(14, 2)::text as wages,
             paid.advances::numeric(14, 2)::text as advances,
             (earned.before - paid.before + earned.earned - paid.wages - paid.advances)::numeric(14, 2)::text as closing
      from earned, paid
    `) as unknown as Promise<{ days: string; opening: string; earned: string; wages: string; advances: string; closing: string }[]>,
    db.execute(sql`
      select work_date::text as date, status, coalesce(work_type, '') as work_type,
             coalesce(day_rate, 0)::text as day_rate, wage_amount::text as amount
      from labour_attendance
      where site_id = ${f.siteId} and worker_id = ${f.workerId} and status <> 'absent'
        and work_date between ${f.from}::date and ${f.to}::date
      order by work_date
    `) as unknown as Promise<{ date: string; status: "present" | "half_day"; work_type: string; day_rate: string; amount: string }[]>,
    db.execute(sql`
      select e.expense_date::text as date, coalesce(e.labour_kind::text, 'wage') as kind, e.description, e.total_amount::text as amount
      ${paidFrom}
        and e.expense_date between ${f.from}::date and ${f.to}::date
      order by e.expense_date, e.created_at
    `) as unknown as Promise<{ date: string; kind: "wage" | "advance"; description: string; amount: string }[]>,
  ]);

  return {
    site: { id: site.id, name: site.name, location: site.location, client: site.client ?? "" },
    worker: { id: worker.id, name: worker.name, trade: worker.trade ?? "", phone: worker.phone ?? "" },
    from: f.from,
    to: f.to,
    days: (sums.days.includes(".") ? sums.days.replace(/\.?0+$/, "") : sums.days) || "0",
    opening: sums.opening,
    earned: sums.earned,
    wagesPaid: sums.wages,
    advances: sums.advances,
    closing: sums.closing,
    attendance: attendance.map((a) => ({ date: a.date, status: a.status, workType: a.work_type, dayRate: a.day_rate, amount: a.amount })),
    payments: payments.map((p): LabourInvoiceLine => ({ date: p.date, kind: p.kind, description: p.description, amount: p.amount })),
  };
}
