import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { suppliers } from "@/db/schema";
import type { BillStatus, PaymentMode } from "@/lib/types";
import { requireOrgReader, scopeSiteIds, type Actor } from "../authz";
import { NotFoundError } from "../errors";
import { supplierInput, uuid } from "../validation";
import { audit } from "./audit";
import { billsQuery } from "./bills";
import { requireOrgWriter } from "./labour";
import { rethrowUnique, today } from "./shared";

export async function listSuppliers(actor: Actor) {
  await requireOrgReader(actor);
  return db
    .select()
    .from(suppliers)
    .where(eq(suppliers.organizationId, actor.orgId))
    .orderBy(asc(suppliers.name));
}

export async function createSupplier(actor: Actor, raw: unknown) {
  await requireOrgWriter(actor);
  const input = supplierInput.parse(raw);
  return db
    .transaction(async (tx) => {
      const [row] = await tx.insert(suppliers).values({ organizationId: actor.orgId, ...input }).returning();
      await audit(tx, actor, { action: "supplier.create", entityType: "supplier", entityId: row.id, summary: `Added supplier ${row.name}`, data: input });
      return row;
    })
    .catch((err) => rethrowUnique(err, "name", "A supplier with this name already exists."));
}

export async function updateSupplier(actor: Actor, id: string, raw: unknown) {
  await requireOrgWriter(actor);
  const input = supplierInput.parse(raw);
  return db
    .transaction(async (tx) => {
      const [before] = await tx.select().from(suppliers).where(and(eq(suppliers.id, id), eq(suppliers.organizationId, actor.orgId))).for("update");
      if (!before) throw new NotFoundError("Supplier");
      const [row] = await tx
        .update(suppliers)
        .set({ name: input.name, gstin: input.gstin ?? null, phone: input.phone ?? null, address: input.address ?? null })
        .where(eq(suppliers.id, id))
        .returning();
      await audit(tx, actor, {
        action: "supplier.update",
        entityType: "supplier",
        entityId: id,
        summary: `Updated supplier ${row.name}`,
        data: { before: { name: before.name, gstin: before.gstin, phone: before.phone, address: before.address }, after: input },
      });
      return row;
    })
    .catch((err) => rethrowUnique(err, "name", "A supplier with this name already exists."));
}

// ---- Balances ------------------------------------------------------------------

export type SupplierSummary = {
  id: string;
  name: string;
  phone: string | null;
  gstin: string | null;
  billCount: number;
  billed: string;
  paid: string;
  outstanding: string;
  overdue: string;
  /** Bought and paid on the spot (not through bills), for context. */
  paidDirect: string;
  lastActivity: string | null;
};

/**
 * Every supplier with what they billed, what was paid against those bills and what's
 * still owed, counting only sites the actor can see. Direct (cash) purchases are
 * reported separately: they were never owed, so they don't touch the balance.
 */
export async function supplierDirectory(actor: Actor): Promise<SupplierSummary[]> {
  const siteIds = await scopeSiteIds(actor);
  // No readable site (e.g. only an assistant engineer): no supplier records, not even names and phones.
  if (siteIds.length === 0) return [];
  const scope = siteIds;
  const rows = (await db.execute(sql`
    with b as (${billsQuery(scope, today())}),
    bills as (
      select supplier_id, count(*)::int as n, sum(amount) as billed, sum(paid) as paid,
             sum(amount - paid) as outstanding,
             sum(amount - paid) filter (where status = 'overdue') as overdue,
             max(bill_date) as last_bill
      from b group by supplier_id
    ), direct as (
      select supplier_id, sum(total_amount) as spent, max(expense_date) as last_paid
      from expenses
      where site_id in ${scope} and supplier_id is not null and deleted_at is null and status = 'approved' and source <> 'bill_payment'
      group by supplier_id
    )
    select s.id, s.name, s.phone, s.gstin,
           coalesce(bills.n, 0) as n,
           coalesce(bills.billed, 0)::text as billed,
           coalesce(bills.paid, 0)::text as paid,
           coalesce(bills.outstanding, 0)::text as outstanding,
           coalesce(bills.overdue, 0)::text as overdue,
           coalesce(direct.spent, 0)::text as direct,
           greatest(bills.last_bill::date, direct.last_paid)::text as last_activity
    from suppliers s
    left join bills on bills.supplier_id = s.id
    left join direct on direct.supplier_id = s.id
    where s.organization_id = ${actor.orgId}
    order by coalesce(bills.outstanding, 0) desc, s.name
  `)) as unknown as {
    id: string; name: string; phone: string | null; gstin: string | null; n: number;
    billed: string; paid: string; outstanding: string; overdue: string; direct: string; last_activity: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    gstin: r.gstin,
    billCount: Number(r.n),
    billed: r.billed,
    paid: r.paid,
    outstanding: r.outstanding,
    overdue: r.overdue,
    paidDirect: r.direct,
    lastActivity: r.last_activity,
  }));
}

export type SupplierBillRow = {
  id: string;
  siteId: string;
  site: string;
  invoiceNumber: string;
  date: string;
  dueDate: string;
  amount: string;
  paid: string;
  outstanding: string;
  status: BillStatus;
  description: string | null;
};

export type SupplierPaymentRow = {
  id: string;
  billId: string;
  invoiceNumber: string;
  site: string;
  paidOn: string;
  amount: string;
  method: PaymentMode;
  reference: string | null;
  enteredBy: string;
};

export async function supplierDetail(actor: Actor, id: string) {
  if (!uuid.safeParse(id).success) throw new NotFoundError("Supplier");
  await requireOrgReader(actor);
  const [supplier] = await db.select().from(suppliers).where(and(eq(suppliers.id, id), eq(suppliers.organizationId, actor.orgId))).limit(1);
  if (!supplier) throw new NotFoundError("Supplier");
  const summary = (await supplierDirectory(actor)).find((s) => s.id === id)!;
  const siteIds = await scopeSiteIds(actor);
  if (!siteIds.length) return { supplier, summary, bills: [], payments: [], purchases: [] };

  const [bills, paymentRows, purchases] = await Promise.all([
    db.execute(sql`
      with b as (${billsQuery(siteIds, today())})
      select b.*, (b.amount - b.paid)::text as outstanding, cs.name as site_name from b join construction_sites cs on cs.id = b.site_id
      where b.supplier_id = ${id}
      order by b.bill_date desc, b.id desc
    `) as unknown as Promise<
      { id: string; site_id: string; site_name: string; outstanding: string; bill_number: string; bill_date: string; due_date: string; amount: string; paid: string; status: BillStatus; description: string | null }[]
    >,
    db.execute(sql`
      select p.id, p.supplier_bill_id as bill_id, b.bill_number, cs.name as site, p.paid_on::text as paid_on,
             p.amount::text as amount, p.method, p.reference, u.name as entered_by
      from payments p
      join supplier_bills b on b.id = p.supplier_bill_id
      join construction_sites cs on cs.id = p.site_id
      join users u on u.id = p.created_by
      where b.supplier_id = ${id} and p.site_id in ${siteIds}
      order by p.paid_on desc, p.created_at desc
    `) as unknown as Promise<
      { id: string; bill_id: string; bill_number: string; site: string; paid_on: string; amount: string; method: PaymentMode; reference: string | null; entered_by: string }[]
    >,
    db.execute(sql`
      select p.id, cs.name as site, p.purchase_date::text as date, p.invoice_number, p.delivery_ref,
             p.total_amount::text as total, p.payment_method, p.voided_at is not null as voided
      from material_purchases p join construction_sites cs on cs.id = p.site_id
      where p.supplier_id = ${id} and p.site_id in ${siteIds}
      order by p.purchase_date desc, p.created_at desc
      limit 50
    `) as unknown as Promise<
      { id: string; site: string; date: string; invoice_number: string | null; delivery_ref: string | null; total: string; payment_method: PaymentMode; voided: boolean }[]
    >,
  ]);

  return {
    supplier,
    summary,
    bills: bills.map(
      (b): SupplierBillRow => ({
        id: b.id,
        siteId: b.site_id,
        site: b.site_name,
        invoiceNumber: b.bill_number,
        date: b.bill_date,
        dueDate: b.due_date,
        amount: String(b.amount),
        paid: String(b.paid),
        outstanding: b.outstanding,
        status: b.status,
        description: b.description,
      }),
    ),
    payments: paymentRows.map(
      (p): SupplierPaymentRow => ({
        id: p.id,
        billId: p.bill_id,
        invoiceNumber: p.bill_number,
        site: p.site,
        paidOn: p.paid_on,
        amount: p.amount,
        method: p.method,
        reference: p.reference,
        enteredBy: p.entered_by,
      }),
    ),
    purchases: purchases.map((p) => ({
      id: p.id,
      site: p.site,
      date: p.date,
      invoiceNumber: p.invoice_number,
      deliveryRef: p.delivery_ref,
      total: p.total,
      paymentMethod: p.payment_method,
      voided: p.voided,
    })),
  };
}
