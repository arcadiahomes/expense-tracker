import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { clientPayments } from "@/db/schema";
import { formatINRExact as formatINR } from "@/lib/format";
import type { ClientInvoice, ClientPaymentKind, ClientReceipt, Page, PaymentMode, ProjectCollection, ReceiptStage } from "@/lib/types";
import { can, requireSitePermission, scopeSiteIds, siteRoleFor, type Actor } from "../authz";
import { NotFoundError, ValidationError } from "../errors";
import { clientPaymentInput, clientRefundInput, invoicePaidInput, receiptFilters, uuid } from "../validation";
import { audit } from "./audit";
import { financialYear, getClientInvoice, invoicePaidSql, invoicesQuery, invoiceTotalSql, lockInvoice } from "./invoices";
import { organizationProfile } from "./organizations";
import { decodeCursor, encodeCursor, num, today, type Conn } from "./shared";

/**
 * What clients pay against their invoices, and what is given back: one append-only ledger
 * (client_payments) for people with `finance:manage` on the site. Every payment gets a
 * receipt; refunds and reversals are linked records against one payment, so the original
 * receipt is never changed or removed. Paid, balance and each receipt's figures are
 * summed here in SQL from the ledger, never stored:
 * - paid = payments − refunds − reversals; balance = invoice total − paid.
 * - A receipt shows the invoice as it stood when that entry was recorded (by `seq`), so
 *   downloading it again later always gives the same document.
 * Income only: none of this creates expenses or touches spend and budgets.
 */

type LedgerRow = {
  id: string;
  seq: string;
  kind: ClientPaymentKind;
  stage: ReceiptStage;
  receipt_number: string;
  amount: string;
  paid_on: string;
  method: PaymentMode;
  reference: string | null;
  notes: string | null;
  related_id: string | null;
  related_number: string | null;
  invoice_id: string;
  invoice_number: string;
  invoice_total: string;
  site_id: string;
  site_name: string;
  client_name: string;
  paid_before: string;
  paid_to_date: string;
  balance_after: string;
  refunded: string;
  reversed: boolean;
  created_by: string;
};

/**
 * Every ledger entry on the given sites with its running figures. The window sums run over
 * the whole invoice before any outer filter, so a filtered list still shows true balances.
 */
function ledgerQuery(siteIds: string[]) {
  return sql`
    select l.*, (l.invoice_total::numeric - l.paid_to_date::numeric)::numeric(14, 2)::text as balance_after,
           case
             when l.kind <> 'payment' then l.kind::text
             when l.invoice_total::numeric - l.paid_to_date::numeric <= 0 then 'final'
             when l.paid_before::numeric <= 0 then 'advance'
             else 'part'
           end as stage
    from (
      select p.id, p.seq::text as seq, p.kind, p.receipt_number, p.amount::text as amount, p.paid_on::text as paid_on,
             p.method, p.reference, p.notes, p.related_id, r.receipt_number as related_number,
             p.invoice_id, i.invoice_number, ${invoiceTotalSql}::text as invoice_total,
             p.site_id, cs.name as site_name, i.client_name,
             coalesce(sum(case p.kind when 'payment' then p.amount else -p.amount end)
               over (partition by p.invoice_id order by p.seq rows between unbounded preceding and 1 preceding), 0)::numeric(14, 2)::text as paid_before,
             sum(case p.kind when 'payment' then p.amount else -p.amount end)
               over (partition by p.invoice_id order by p.seq rows between unbounded preceding and current row)::numeric(14, 2)::text as paid_to_date,
             coalesce((select sum(x.amount) from client_payments x where x.related_id = p.id), 0)::numeric(14, 2)::text as refunded,
             exists (select 1 from client_payments x where x.related_id = p.id and x.kind = 'reversal') as reversed,
             u.name as created_by
      from client_payments p
      join client_invoices i on i.id = p.invoice_id
      join construction_sites cs on cs.id = p.site_id
      join users u on u.id = p.created_by
      left join client_payments r on r.id = p.related_id
      where p.site_id in ${siteIds}
    ) l
  `;
}

function toDto(r: LedgerRow): ClientReceipt {
  return {
    id: r.id,
    receiptNo: r.receipt_number,
    kind: r.kind,
    stage: r.stage,
    date: r.paid_on,
    method: r.method,
    reference: r.reference ?? "",
    notes: r.notes ?? "",
    amount: num(r.amount),
    invoiceId: r.invoice_id,
    invoiceNo: r.invoice_number,
    invoiceTotal: num(r.invoice_total),
    siteId: r.site_id,
    siteName: r.site_name,
    client: r.client_name,
    paidBefore: num(r.paid_before),
    paidToDate: num(r.paid_to_date),
    balanceAfter: num(r.balance_after),
    related: r.related_id && r.related_number ? { id: r.related_id, receiptNo: r.related_number } : undefined,
    refunded: num(r.refunded),
    reversed: r.reversed,
    createdBy: r.created_by,
  };
}

type ReceiptCursor = { s: string };

/** Receipts, refunds and reversals on sites the actor manages finance for, newest entry first. */
export async function listReceipts(actor: Actor, raw: unknown = {}): Promise<Page<ClientReceipt>> {
  const f = receiptFilters.parse(raw);
  const siteIds = await scopeSiteIds(actor, f.siteId, db, "finance:manage");
  if (!siteIds.length) return { items: [], nextCursor: null };
  const cursor = decodeCursor<ReceiptCursor>(f.cursor);
  const q = f.q ? `%${f.q.replace(/[%_\\]/g, "\\$&")}%` : null;
  const rows = (await db.execute(sql`
    with l as (${ledgerQuery(siteIds)})
    select * from l
    where (${f.stage} = 'all' or l.stage = ${f.stage})
      and (${f.invoiceId ?? null}::uuid is null or l.invoice_id = ${f.invoiceId ?? null}::uuid)
      and (${f.from ?? null}::date is null or l.paid_on::date >= ${f.from ?? null}::date)
      and (${f.to ?? null}::date is null or l.paid_on::date <= ${f.to ?? null}::date)
      and (${q}::text is null or l.client_name ilike ${q} or l.receipt_number ilike ${q} or l.invoice_number ilike ${q} or l.site_name ilike ${q})
      and (${cursor?.s ?? null}::bigint is null or l.seq::bigint < ${cursor?.s ?? null}::bigint)
    order by l.seq::bigint desc
    limit ${f.limit + 1}
  `)) as unknown as LedgerRow[];
  const page = rows.slice(0, f.limit);
  const last = page.at(-1);
  return {
    items: page.map(toDto),
    nextCursor: rows.length > f.limit && last ? encodeCursor({ s: last.seq }) : null,
  };
}

/**
 * Collections per site that has invoices, and their sum. Value is what's invoiced (cancelled
 * invoices left out), collected is every payment, refunded is refunds and reversals, and
 * outstanding is what's left to receive on each invoice. Since a payment can't exceed the
 * balance, outstanding is always value − (collected − refunded).
 */
export async function projectCollections(actor: Actor): Promise<{ projects: ProjectCollection[]; total: Omit<ProjectCollection, "siteId" | "siteName" | "client"> }> {
  const siteIds = await scopeSiteIds(actor, null, db, "finance:manage");
  const zero = { invoices: 0, receipts: 0, value: 0, collected: 0, refunded: 0, outstanding: 0 };
  if (!siteIds.length) return { projects: [], total: zero };
  const rows = (await db.execute(sql`
    with i as (${invoicesQuery(siteIds, today())}),
    per as (
      select cs.id as site_id, cs.name as site_name, coalesce(cs.client_name, '') as client,
             count(i.id) filter (where i.status <> 'cancelled')::int as invoices,
             coalesce(sum(i.total::numeric) filter (where i.status <> 'cancelled'), 0) as value,
             coalesce(sum(greatest(i.balance::numeric, 0)) filter (where i.status <> 'cancelled'), 0) as outstanding,
             coalesce((select sum(p.amount) from client_payments p where p.site_id = cs.id and p.kind = 'payment'), 0) as collected,
             coalesce((select sum(p.amount) from client_payments p where p.site_id = cs.id and p.kind <> 'payment'), 0) as refunded,
             (select count(*) from client_payments p where p.site_id = cs.id and p.kind = 'payment')::int as receipts
      from i join construction_sites cs on cs.id = i.site_id
      group by cs.id, cs.name, cs.client_name
    )
    select site_id, site_name, client, invoices, receipts, value::text, collected::text, refunded::text, outstanding::text from per
    union all
    select null, null, null, coalesce(sum(invoices), 0)::int, coalesce(sum(receipts), 0)::int, coalesce(sum(value), 0)::text,
           coalesce(sum(collected), 0)::text, coalesce(sum(refunded), 0)::text, coalesce(sum(outstanding), 0)::text from per
  `)) as unknown as Record<string, string | number | null>[];
  const dto = (r: Record<string, string | number | null>) => ({
    invoices: Number(r.invoices),
    receipts: Number(r.receipts),
    value: num(r.value),
    collected: num(r.collected),
    refunded: num(r.refunded),
    outstanding: num(r.outstanding),
  });
  const totalRow = rows.find((r) => r.site_id === null)!;
  const projects = rows
    .filter((r) => r.site_id !== null)
    .map((r) => ({ siteId: String(r.site_id), siteName: String(r.site_name), client: String(r.client), ...dto(r) }))
    .sort((a, b) => b.outstanding - a.outstanding || a.siteName.localeCompare(b.siteName));
  return { projects, total: dto(totalRow) };
}

/** Invoices that still have something to receive, for the "record a payment" picker. */
export async function payableInvoices(actor: Actor) {
  const siteIds = await scopeSiteIds(actor, null, db, "finance:manage");
  if (!siteIds.length) return [];
  const rows = (await db.execute(sql`
    with i as (${invoicesQuery(siteIds, today())})
    select id, invoice_number, invoice_date, client_name, site_id, site_name, total, paid, balance, status from i
    where i.status in ('unpaid', 'overdue')
    order by i.invoice_date desc, i.invoice_number desc
    limit 500
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({
    id: r.id,
    invoiceNo: r.invoice_number,
    date: r.invoice_date,
    client: r.client_name,
    siteId: r.site_id,
    siteName: r.site_name,
    total: num(r.total),
    paid: num(r.paid),
    balance: num(r.balance),
    overdue: r.status === "overdue",
  }));
}

/** Every ledger entry against one invoice, oldest first. The caller has checked access. */
async function entriesFor(siteId: string, invoiceId: string, conn: Conn = db) {
  const rows = (await conn.execute(sql`
    with l as (${ledgerQuery([siteId])}) select * from l where l.invoice_id = ${invoiceId} order by l.seq::bigint
  `)) as unknown as LedgerRow[];
  return rows.map(toDto);
}

/** An invoice with every ledger entry against it, oldest first. */
export async function invoicePayments(actor: Actor, invoiceId: string): Promise<{ invoice: ClientInvoice; entries: ClientReceipt[] }> {
  const invoice = await getClientInvoice(actor, invoiceId);
  return { invoice, entries: await entriesFor(invoice.siteId, invoice.id) };
}

/**
 * One receipt with what its document needs: the invoice, the ledger up to and including
 * this entry, and the company's details. NotFound unless the actor manages finance on its site.
 */
export async function getReceipt(actor: Actor, id: string, conn: Conn = db) {
  if (!uuid.safeParse(id).success) throw new NotFoundError("Receipt");
  const [meta] = await conn
    .select({ siteId: clientPayments.siteId, invoiceId: clientPayments.invoiceId })
    .from(clientPayments)
    .where(and(eq(clientPayments.id, id), eq(clientPayments.organizationId, actor.orgId)))
    .limit(1);
  if (!meta || !can(await siteRoleFor(actor, meta.siteId, conn), "finance:manage")) throw new NotFoundError("Receipt");
  const entries = await entriesFor(meta.siteId, meta.invoiceId, conn);
  const index = entries.findIndex((e) => e.id === id);
  const [invoice, organization] = await Promise.all([getClientInvoice(actor, meta.invoiceId, conn), organizationProfile(actor, conn)]);
  return { receipt: entries[index], history: entries.slice(0, index + 1), invoice, organization };
}

/**
 * The next number in the organization's series for the date's financial year:
 * RCT/2026-27/0007 for payments, RFD/2026-27/0002 for refunds and reversals.
 * Called under the organization's receipt lock.
 */
async function nextReceiptNumber(conn: Conn, orgId: string, series: "RCT" | "RFD", onDate: string) {
  const prefix = `${series}/${financialYear(onDate)}/`;
  const [row] = (await conn.execute(sql`
    select coalesce(max(substring(receipt_number from '([0-9]+)$')::int), 0) + 1 as next
    from client_payments
    where organization_id = ${orgId} and receipt_number like ${`${prefix}%`}
  `)) as unknown as { next: number }[];
  return `${prefix}${String(row.next).padStart(4, "0")}`;
}

/** The entry already saved under this form submission, if any (a retry or a double tap). */
async function byClientKey(conn: Conn, actor: Actor, clientKey: string | undefined) {
  if (!clientKey) return null;
  const [row] = await conn
    .select({ id: clientPayments.id, siteId: clientPayments.siteId, invoiceId: clientPayments.invoiceId })
    .from(clientPayments)
    .where(and(eq(clientPayments.organizationId, actor.orgId), eq(clientPayments.clientKey, clientKey)))
    .limit(1);
  return row ?? null;
}

const LABEL: Record<ReceiptStage, string> = { advance: "Advance payment", part: "Part payment", final: "Final payment", refund: "Refund", reversal: "Reversal" };

type PaymentFields = { amount: string | "balance"; paidOn: string; method: PaymentMode; reference?: string; notes?: string; clientKey?: string };

/**
 * Records money received against an invoice, in one transaction under the invoice's row
 * lock (so two payments can't both take the last of the balance) and the organization's
 * receipt lock (so numbers are unique). "balance" takes whatever is left to receive.
 * A submission whose clientKey was already saved returns that receipt instead.
 */
type Saved = { id: string; siteId: string; invoiceId: string };

/** The receipt just written, with its running figures. Access was checked by the write. */
async function saved({ id, siteId, invoiceId }: Saved) {
  return (await entriesFor(siteId, invoiceId)).find((e) => e.id === id)!;
}

async function receive(actor: Actor, invoiceId: string, input: PaymentFields): Promise<Saved> {
  if (input.paidOn > today()) throw new ValidationError("The payment date can't be in the future.", { paidOn: "Pick today or earlier." });
  return db.transaction(async (tx) => {
    const inv = await lockInvoice(actor, invoiceId, tx);
    const existing = await byClientKey(tx, actor, input.clientKey);
    if (existing) return existing;
    if (inv.cancelledAt) throw new ValidationError("This invoice is cancelled.");
    if (input.paidOn < inv.invoiceDate) throw new ValidationError("The payment date is before the invoice date.", { paidOn: "Pick the invoice date or later." });
    const [{ total, paid }] = (await tx.execute(sql`
      select ${invoiceTotalSql}::text as total, ${invoicePaidSql}::text as paid from client_invoices i where i.id = ${inv.id}
    `)) as unknown as { total: string; paid: string }[];
    const [{ balance, over }] = (await tx.execute(sql`
      select (${total}::numeric - ${paid}::numeric)::numeric(14, 2)::text as balance,
             ${input.amount === "balance" ? null : input.amount}::numeric > ${total}::numeric - ${paid}::numeric as over
    `)) as unknown as { balance: string; over: boolean | null }[];
    if (num(balance) <= 0) throw new ValidationError("This invoice is already paid in full.");
    if (over) {
      const message = `That's more than the ${formatINR(num(balance))} still to receive on this invoice.`;
      throw new ValidationError(message, { amount: message });
    }
    const amount = input.amount === "balance" ? balance : input.amount;

    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`receipt:${actor.orgId}`}, 0))`);
    const receiptNumber = await nextReceiptNumber(tx, actor.orgId, "RCT", input.paidOn);
    const [row] = await tx
      .insert(clientPayments)
      .values({
        organizationId: actor.orgId,
        siteId: inv.siteId,
        invoiceId: inv.id,
        kind: "payment",
        receiptNumber,
        amount,
        paidOn: input.paidOn,
        method: input.method,
        reference: input.reference,
        notes: input.notes,
        clientKey: input.clientKey ?? crypto.randomUUID(),
        createdBy: actor.userId,
      })
      .returning({ id: clientPayments.id });
    const [{ after }] = (await tx.execute(sql`select (${balance}::numeric - ${amount}::numeric)::numeric(14, 2)::text as after`)) as unknown as { after: string }[];
    const stage: ReceiptStage = num(after) <= 0 ? "final" : num(paid) <= 0 ? "advance" : "part";
    await audit(tx, actor, {
      siteId: inv.siteId,
      action: "payment.receive",
      entityType: "client_payment",
      entityId: row.id,
      summary: `Receipt ${receiptNumber}: ${formatINR(num(amount))} from ${inv.clientName} against invoice ${inv.invoiceNumber} (${LABEL[stage].toLowerCase()}, ${formatINR(num(after))} left)`,
      data: { invoiceId: inv.id, receiptNumber, amount, paidOn: input.paidOn, method: input.method, reference: input.reference, balanceBefore: balance, balanceAfter: after },
    });
    return { id: row.id, siteId: inv.siteId, invoiceId: inv.id };
  });
}

/** Money received from the client against an invoice. Returns its receipt. */
export async function recordClientPayment(actor: Actor, raw: unknown) {
  const input = clientPaymentInput.parse(raw);
  return saved(await receive(actor, input.invoiceId, input));
}

/** The invoice's whole remaining balance, received at once (the final payment). */
export async function markInvoicePaid(actor: Actor, raw: unknown): Promise<ClientInvoice> {
  const input = invoicePaidInput.parse(raw);
  await receive(actor, input.id, { ...input, amount: "balance" });
  return getClientInvoice(actor, input.id);
}

/**
 * Gives money back against one payment, as a new linked record; the payment's receipt
 * stays as it was. A refund is any part of what's left of the payment; a reversal undoes
 * all of it (a bounced cheque, a payment entered twice) and only if nothing was refunded
 * from it yet. Needs `payment:refund` (site owners, org owners and admins).
 */
export async function refundClientPayment(actor: Actor, raw: unknown) {
  const input = clientRefundInput.parse(raw);
  if (input.paidOn > today()) throw new ValidationError("The date can't be in the future.", { paidOn: "Pick today or earlier." });
  const [target] = await db
    .select({ invoiceId: clientPayments.invoiceId })
    .from(clientPayments)
    .where(and(eq(clientPayments.id, input.paymentId), eq(clientPayments.organizationId, actor.orgId)))
    .limit(1);
  if (!target) throw new NotFoundError("Receipt");

  const result = await db.transaction(async (tx) => {
    const inv = await lockInvoice(actor, target.invoiceId, tx);
    await requireSitePermission(actor, inv.siteId, "payment:refund", tx);
    const existing = await byClientKey(tx, actor, input.clientKey);
    if (existing) return existing;
    const [pay] = (await tx.execute(sql`
      select p.kind, p.receipt_number, p.amount::text as amount, p.paid_on::text as paid_on,
             coalesce((select sum(x.amount) from client_payments x where x.related_id = p.id), 0)::text as given_back,
             (p.amount - coalesce((select sum(x.amount) from client_payments x where x.related_id = p.id), 0))::numeric(14, 2)::text as left_over
      from client_payments p where p.id = ${input.paymentId}
    `)) as unknown as { kind: ClientPaymentKind; receipt_number: string; amount: string; paid_on: string; given_back: string; left_over: string }[];
    if (pay.kind !== "payment") throw new ValidationError("Only a payment can be refunded or reversed.");
    if (input.paidOn < pay.paid_on) throw new ValidationError("That's before the payment was received.", { paidOn: "Pick the payment date or later." });
    if (num(pay.left_over) <= 0) throw new ValidationError(`Receipt ${pay.receipt_number} has already been given back in full.`);
    let amount: string;
    if (input.kind === "reversal") {
      if (num(pay.given_back) > 0) throw new ValidationError(`Part of receipt ${pay.receipt_number} was already refunded. Refund the rest instead of reversing it.`);
      amount = pay.amount;
    } else {
      const [{ over }] = (await tx.execute(sql`select ${input.amount!}::numeric > ${pay.left_over}::numeric as over`)) as unknown as { over: boolean }[];
      if (over) {
        const message = `That's more than the ${formatINR(num(pay.left_over))} left of receipt ${pay.receipt_number}.`;
        throw new ValidationError(message, { amount: message });
      }
      amount = input.amount!;
    }

    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`receipt:${actor.orgId}`}, 0))`);
    const receiptNumber = await nextReceiptNumber(tx, actor.orgId, "RFD", input.paidOn);
    const [row] = await tx
      .insert(clientPayments)
      .values({
        organizationId: actor.orgId,
        siteId: inv.siteId,
        invoiceId: inv.id,
        kind: input.kind,
        receiptNumber,
        amount,
        paidOn: input.paidOn,
        method: input.method,
        reference: input.reference,
        notes: input.reason,
        relatedId: input.paymentId,
        clientKey: input.clientKey,
        createdBy: actor.userId,
      })
      .returning({ id: clientPayments.id });
    await audit(tx, actor, {
      siteId: inv.siteId,
      action: input.kind === "reversal" ? "payment.reverse" : "payment.refund",
      entityType: "client_payment",
      entityId: row.id,
      summary: `${input.kind === "reversal" ? "Reversed" : "Refunded"} ${formatINR(num(amount))} of receipt ${pay.receipt_number} (${receiptNumber}), invoice ${inv.invoiceNumber}: ${input.reason}`,
      data: { invoiceId: inv.id, paymentId: input.paymentId, receiptNumber, amount, paidOn: input.paidOn, method: input.method, reference: input.reference, reason: input.reason },
    });
    return { id: row.id, siteId: inv.siteId, invoiceId: inv.id };
  });
  return saved(result);
}
