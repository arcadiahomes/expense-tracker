import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { expenseItems, expenses, payments, receipts, supplierBills } from "@/db/schema";
import { shiftDate } from "@/lib/dates";
import { formatINR } from "@/lib/format";
import type { Bill, BillStatus, Category, Page } from "@/lib/types";
import { accessibleSites, can, requireSitePermission, scopeSiteIds, siteRoleFor, type Actor } from "../authz";
import { NotFoundError, ValidationError } from "../errors";
import { billFilters, billInput, paymentInput } from "../validation";
import { audit } from "./audit";
import { categoryId, decodeCursor, encodeCursor, enteredApproved, num, rethrowUnique, supplierIdByName, today, type Conn } from "./shared";

type BillRow = {
  id: string;
  site_id: string;
  bill_number: string;
  supplier: string;
  category: Category;
  bill_date: string;
  due_date: string;
  amount: string;
  paid: string;
  status: BillStatus;
  description: string | null;
};

/**
 * Bills with paid amount and status derived from payments and due date.
 * Status is never stored, so it can't drift from the payments table.
 */
export function billsQuery(siteIds: string[], onDate: string) {
  return sql`
    select b.id, b.site_id, b.bill_number, b.supplier_id, s.name as supplier, c.code as category,
           b.bill_date::text as bill_date, b.due_date::text as due_date, b.amount,
           coalesce(p.paid, 0) as paid,
           case
             when coalesce(p.paid, 0) >= b.amount then 'paid'
             when b.due_date < ${onDate}::date then 'overdue'
             when coalesce(p.paid, 0) > 0 then 'partial'
             else 'pending'
           end as status,
           b.description, b.created_at
    from supplier_bills b
    join suppliers s on s.id = b.supplier_id
    join expense_categories c on c.id = b.category_id
    left join lateral (select sum(amount) as paid from payments where supplier_bill_id = b.id) p on true
    where b.site_id in ${siteIds}
  `;
}

async function attachments(billIds: string[], conn: Conn = db) {
  if (billIds.length === 0) return new Map<string, Bill["attachment"]>();
  const rows = await conn
    .select({
      id: receipts.id,
      billId: receipts.supplierBillId,
      name: receipts.fileName,
      size: receipts.sizeBytes,
      type: receipts.contentType,
    })
    .from(receipts)
    .where(and(inArray(receipts.supplierBillId, billIds), isNull(receipts.deletedAt)))
    .orderBy(receipts.createdAt);
  const out = new Map<string, Bill["attachment"]>();
  for (const r of rows) {
    if (!r.billId || out.has(r.billId)) continue;
    out.set(r.billId, {
      id: r.id,
      name: r.name,
      size: r.size,
      kind: r.type === "application/pdf" ? "pdf" : "image",
      url: `/api/receipts/${r.id}`,
    });
  }
  return out;
}

function toDto(r: BillRow, att: Map<string, Bill["attachment"]>, manage: boolean): Bill {
  return {
    id: r.id,
    billNo: r.bill_number,
    supplier: r.supplier,
    siteId: r.site_id,
    date: r.bill_date,
    dueDate: r.due_date,
    amount: num(r.amount),
    paid: num(r.paid),
    status: r.status,
    category: r.category,
    description: r.description ?? "",
    attachment: att.get(r.id),
    canManage: manage,
  };
}

type BillCursor = { d: string; i: string };

/** Bills on visible sites, newest first, filtered by status/site/text, keyset-paginated. */
export async function listBills(actor: Actor, raw: unknown = {}): Promise<Page<Bill>> {
  const f = billFilters.parse(raw);
  const siteIds = await scopeSiteIds(actor, f.siteId);
  if (siteIds.length === 0) return { items: [], nextCursor: null };
  const roles = await accessibleSites(actor);
  const cursor = decodeCursor<BillCursor>(f.cursor);
  const q = f.q ? `%${f.q.replace(/[%_\\]/g, "\\$&")}%` : null;

  const rows = (await db.execute(sql`
    with b as (${billsQuery(siteIds, today())})
    select b.* from b
    left join construction_sites cs on cs.id = b.site_id
    where (${f.status} = 'all' or b.status = ${f.status})
      and (${q}::text is null or b.supplier ilike ${q} or b.bill_number ilike ${q} or cs.name ilike ${q})
      and (${cursor?.d ?? null}::date is null or (b.bill_date::date, b.id) < (${cursor?.d ?? null}::date, ${cursor?.i ?? null}::uuid))
    order by b.bill_date desc, b.id desc
    limit ${f.limit + 1}
  `)) as unknown as BillRow[];

  const page = rows.slice(0, f.limit);
  const att = await attachments(page.map((r) => r.id));
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toDto(r, att, can(roles.get(r.site_id), "finance:manage"))),
    nextCursor: rows.length > f.limit && last ? encodeCursor({ d: last.bill_date, i: last.id }) : null,
  };
}

/** Counts and amounts for the bills header and the overdue bell. */
export async function billTotals(actor: Actor, siteId?: string) {
  const siteIds = await scopeSiteIds(actor, siteId);
  const empty = { outstanding: 0, overdueAmount: 0, overdueCount: 0, dueSoonAmount: 0, dueSoonCount: 0, counts: { all: 0, pending: 0, partial: 0, overdue: 0, paid: 0 } };
  if (siteIds.length === 0) return empty;
  const t = today();
  const [r] = (await db.execute(sql`
    with b as (${billsQuery(siteIds, t)})
    select
      coalesce(sum(b.amount - b.paid), 0) as outstanding,
      coalesce(sum(b.amount - b.paid) filter (where b.status = 'overdue'), 0) as overdue_amount,
      count(*) filter (where b.status = 'overdue')::int as overdue_count,
      coalesce(sum(b.amount - b.paid) filter (where b.status in ('pending', 'partial') and b.due_date::date <= ${shiftDate(t, 7)}::date), 0) as due_soon_amount,
      count(*) filter (where b.status in ('pending', 'partial') and b.due_date::date <= ${shiftDate(t, 7)}::date)::int as due_soon_count,
      count(*)::int as c_all,
      count(*) filter (where b.status = 'pending')::int as c_pending,
      count(*) filter (where b.status = 'partial')::int as c_partial,
      count(*) filter (where b.status = 'paid')::int as c_paid
    from b
  `)) as unknown as Record<string, string | number>[];
  return {
    outstanding: num(r.outstanding),
    overdueAmount: num(r.overdue_amount),
    overdueCount: Number(r.overdue_count),
    dueSoonAmount: num(r.due_soon_amount),
    dueSoonCount: Number(r.due_soon_count),
    counts: {
      all: Number(r.c_all),
      pending: Number(r.c_pending),
      partial: Number(r.c_partial),
      overdue: Number(r.overdue_count),
      paid: Number(r.c_paid),
    },
  };
}

export async function getBill(actor: Actor, billId: string, conn: Conn = db): Promise<Bill> {
  const [meta] = await conn.select({ siteId: supplierBills.siteId }).from(supplierBills).where(eq(supplierBills.id, billId)).limit(1);
  if (!meta) throw new NotFoundError("Bill");
  const role = await siteRoleFor(actor, meta.siteId, conn);
  if (!can(role, "site:read")) throw new NotFoundError("Bill");
  const rows = (await conn.execute(sql`
    with b as (${billsQuery([meta.siteId], today())}) select * from b where b.id = ${billId}
  `)) as unknown as BillRow[];
  const att = await attachments([billId], conn);
  return toDto(rows[0], att, can(role, "finance:manage"));
}

export async function createBill(actor: Actor, raw: unknown): Promise<Bill> {
  const input = billInput.parse(raw);
  await requireSitePermission(actor, input.siteId, "finance:manage");
  const id = await db
    .transaction(async (tx) => {
      const [supplierId, catId] = await Promise.all([
        supplierIdByName(actor, input.supplierName, tx),
        categoryId(actor, input.categoryCode, tx),
      ]);
      const [row] = await tx
        .insert(supplierBills)
        .values({
          siteId: input.siteId,
          supplierId: supplierId!,
          categoryId: catId,
          billNumber: input.billNumber ?? `AH-${input.billDate.replace(/-/g, "")}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
          billDate: input.billDate,
          dueDate: input.dueDate,
          amount: input.amount,
          description: input.description,
          createdBy: actor.userId,
        })
        .returning({ id: supplierBills.id });
      await audit(tx, actor, {
        siteId: input.siteId,
        action: "bill.create",
        entityType: "supplier_bill",
        entityId: row.id,
        summary: `Bill from ${input.supplierName} for ${formatINR(num(input.amount))}${input.billNumber ? ` (${input.billNumber})` : ""}`,
        data: input,
      });
      return row.id;
    })
    .catch((err) => rethrowUnique(err, "billNumber", "This supplier already has a bill with that number."));
  return getBill(actor, id);
}

export async function deleteBill(actor: Actor, billId: string) {
  const [meta] = await db.select({ siteId: supplierBills.siteId }).from(supplierBills).where(eq(supplierBills.id, billId)).limit(1);
  if (!meta) throw new NotFoundError("Bill");
  await requireSitePermission(actor, meta.siteId, "finance:manage");
  // Payments cascade; their expenses stay as spend that really happened (bill link is nulled).
  await db.transaction(async (tx) => {
    const [linked] = (await tx.execute(sql`select exists(select 1 from material_purchases where supplier_bill_id = ${billId}) as linked`)) as unknown as { linked: boolean }[];
    if (linked.linked) throw new ValidationError("This bill came from a material purchase. Void the purchase on the Materials page instead.");
    const [gone] = await tx.delete(supplierBills).where(eq(supplierBills.id, billId)).returning();
    await audit(tx, actor, {
      siteId: meta.siteId,
      action: "bill.delete",
      entityType: "supplier_bill",
      entityId: billId,
      summary: `Deleted bill ${gone.billNumber} for ${formatINR(num(gone.amount))}`,
      data: { billNumber: gone.billNumber, amount: gone.amount, supplierId: gone.supplierId },
    });
  });
}

/**
 * Records a payment against a bill and the matching expense in one transaction,
 * so every rupee paid is counted once as spend. The bill row is locked to stop
 * concurrent overpayment.
 */
export async function recordPayment(actor: Actor, raw: unknown): Promise<Bill> {
  const input = paymentInput.parse(raw);
  await db.transaction(async (tx) => {
    const [bill] = (await tx.execute(sql`
      select b.id, b.site_id, b.amount, b.bill_number, b.category_id, b.supplier_id, s.name as supplier,
             coalesce((select sum(amount) from payments where supplier_bill_id = b.id), 0) as paid
      from supplier_bills b join suppliers s on s.id = b.supplier_id
      where b.id = ${input.billId}
      for update of b
    `)) as unknown as {
      id: string; site_id: string; amount: string; bill_number: string; category_id: string; supplier_id: string; supplier: string; paid: string;
    }[];
    if (!bill) throw new NotFoundError("Bill");
    await requireSitePermission(actor, bill.site_id, "finance:manage", tx);
    if (input.paidOn > today()) throw new ValidationError("Payment date can't be in the future.", { paidOn: "Pick today or earlier." });

    const [{ over, balance }] = (await tx.execute(
      sql`select (${input.amount}::numeric > ${bill.amount}::numeric - ${bill.paid}::numeric) as over,
                 (${bill.amount}::numeric - ${bill.paid}::numeric) as balance`,
    )) as unknown as { over: boolean; balance: string }[];
    if (over) {
      const message = `That's more than the ${formatINR(num(balance))} still owed on this bill.`;
      throw new ValidationError(message, { amount: message });
    }

    const [exp] = await tx
      .insert(expenses)
      .values({
        siteId: bill.site_id,
        categoryId: bill.category_id,
        expenseDate: input.paidOn,
        description: `Bill ${bill.bill_number} payment, ${bill.supplier}`,
        paymentMethod: input.method,
        source: "bill_payment",
        supplierId: bill.supplier_id,
        supplierBillId: bill.id,
        createdBy: actor.userId,
        ...enteredApproved(actor),
        notes: input.reference,
      })
      .returning({ id: expenses.id });
    await tx.insert(expenseItems).values({
      expenseId: exp.id,
      description: `Payment against bill ${bill.bill_number}`,
      quantity: "1",
      unit: "lot",
      unitPrice: input.amount,
    });
    await tx.update(expenses).set({ totalAmount: input.amount }).where(eq(expenses.id, exp.id));
    await tx.insert(payments).values({
      siteId: bill.site_id,
      supplierBillId: bill.id,
      expenseId: exp.id,
      amount: input.amount,
      paidOn: input.paidOn,
      method: input.method,
      reference: input.reference,
      createdBy: actor.userId,
    });
    await audit(tx, actor, {
      siteId: bill.site_id,
      action: "bill.payment",
      entityType: "supplier_bill",
      entityId: bill.id,
      summary: `Paid ${formatINR(num(input.amount))} to ${bill.supplier} against bill ${bill.bill_number}`,
      data: { ...input, expenseId: exp.id },
    });
  });
  return getBill(actor, input.billId);
}

export async function listPayments(actor: Actor, billId: string) {
  const bill = await getBill(actor, billId);
  return db
    .select({ id: payments.id, amount: payments.amount, paidOn: payments.paidOn, method: payments.method, reference: payments.reference })
    .from(payments)
    .where(and(eq(payments.supplierBillId, bill.id)))
    .orderBy(payments.paidOn);
}
