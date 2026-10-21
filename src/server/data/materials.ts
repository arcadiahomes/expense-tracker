import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  expenseItems,
  expenses,
  materialPurchaseItems,
  materialPurchases,
  materials,
  materialUsage,
  payments,
  receipts,
  supplierBills,
  suppliers,
  users,
} from "@/db/schema";
import { formatINR } from "@/lib/format";
import type { Attachment, PaymentMode } from "@/lib/types";
import { can, requireOrgReader, requireSitePermission, siteRoleFor, type Actor } from "../authz";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { materialInput, materialUpdateInput, purchaseInput, usageInput, uuid, voidInput } from "../validation";
import { audit } from "./audit";
import { requireOrgWriter } from "./labour";
import { categoryId, enteredApproved, num, requireOpenSite, rethrowUnique, supplierIdByName, today, type Conn } from "./shared";

/**
 * Materials: an org-wide catalog, purchases into a site's stock and usage out of it.
 * Purchases carry the money (once: an expense if paid now, a supplier bill if on
 * credit); usage only moves quantities, so using cement never counts as spending again.
 */

/** "20.500" → "20.5", "20.000" → "20"; a value without a decimal point is left alone ("10" stays "10"). */
const trimQty = (q: string) => (q.includes(".") ? q.replace(/\.?0+$/, "") : q) || "0";

// ---- Catalog ---------------------------------------------------------------------

export type Material = { id: string; name: string; unit: string; defaultUnitPrice: string | null; active: boolean };

export async function listMaterials(actor: Actor): Promise<Material[]> {
  await requireOrgReader(actor);
  return db
    .select({ id: materials.id, name: materials.name, unit: materials.unit, defaultUnitPrice: materials.defaultUnitPrice, active: materials.active })
    .from(materials)
    .where(eq(materials.organizationId, actor.orgId))
    .orderBy(asc(materials.name));
}

export async function createMaterial(actor: Actor, raw: unknown): Promise<Material> {
  await requireOrgWriter(actor);
  const input = materialInput.parse(raw);
  return db
    .transaction(async (tx) => {
      const [row] = await tx
        .insert(materials)
        .values({ organizationId: actor.orgId, ...input })
        .returning({ id: materials.id, name: materials.name, unit: materials.unit, defaultUnitPrice: materials.defaultUnitPrice, active: materials.active });
      await audit(tx, actor, { action: "material.create", entityType: "material", entityId: row.id, summary: `Added material ${row.name} (${row.unit})`, data: input });
      return row;
    })
    .catch((err) => rethrowUnique(err, "name", "A material with this name already exists."));
}

/** Renames, reprices or retires a material. Its unit is fixed once stock has moved, so quantities stay comparable. */
export async function updateMaterial(actor: Actor, raw: unknown): Promise<Material> {
  await requireOrgWriter(actor);
  const input = materialUpdateInput.parse(raw);
  return db
    .transaction(async (tx) => {
      const [before] = await tx.select().from(materials).where(and(eq(materials.id, input.id), eq(materials.organizationId, actor.orgId))).for("update");
      if (!before) throw new NotFoundError("Material");
      if (before.unit !== input.unit) {
        const [used] = await tx.execute(sql`
          select exists(select 1 from material_purchase_items where material_id = ${input.id})
              or exists(select 1 from material_usage where material_id = ${input.id}) as used
        `) as unknown as { used: boolean }[];
        if (used.used) {
          const message = `The unit can't change after ${before.name} has been bought or used. Add a new material instead.`;
          throw new ValidationError(message, { unit: message });
        }
      }
      const [row] = await tx
        .update(materials)
        .set({ name: input.name, unit: input.unit, defaultUnitPrice: input.defaultUnitPrice ?? null, active: input.active })
        .where(eq(materials.id, input.id))
        .returning({ id: materials.id, name: materials.name, unit: materials.unit, defaultUnitPrice: materials.defaultUnitPrice, active: materials.active });
      await audit(tx, actor, {
        action: "material.update",
        entityType: "material",
        entityId: row.id,
        summary: `Updated material ${row.name}`,
        data: { before: { name: before.name, unit: before.unit, defaultUnitPrice: before.defaultUnitPrice, active: before.active }, after: input },
      });
      return row;
    })
    .catch((err) => rethrowUnique(err, "name", "A material with this name already exists."));
}

// ---- Purchases --------------------------------------------------------------------

export type Purchase = {
  id: string;
  siteId: string;
  date: string;
  supplier: string | null;
  invoiceNumber: string | null;
  deliveryRef: string | null;
  paymentMethod: PaymentMode;
  total: string;
  /** Credit purchases: the bill and what's been paid on it. */
  bill: { id: string; amount: string; paid: string; dueDate: string } | null;
  expenseId: string | null;
  items: { materialId: string; material: string; unit: string; quantity: string; unitPrice: string; amount: string }[];
  attachment?: Attachment;
  enteredBy: string;
  voided: { at: string; reason: string | null } | null;
  notes: string | null;
};

async function loadPurchases(where: ReturnType<typeof and>, conn: Conn = db): Promise<Purchase[]> {
  const rows = await conn
    .select({
      p: materialPurchases,
      supplier: suppliers.name,
      enteredBy: users.name,
      billAmount: supplierBills.amount,
      billDue: supplierBills.dueDate,
      billPaid: sql<string>`(select coalesce(sum(${payments.amount}), 0)::text from ${payments} where ${payments.supplierBillId} = ${materialPurchases.supplierBillId})`,
    })
    .from(materialPurchases)
    .innerJoin(users, eq(users.id, materialPurchases.createdBy))
    .leftJoin(suppliers, eq(suppliers.id, materialPurchases.supplierId))
    .leftJoin(supplierBills, eq(supplierBills.id, materialPurchases.supplierBillId))
    .where(where)
    .orderBy(desc(materialPurchases.purchaseDate), desc(materialPurchases.createdAt));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.p.id);
  const [items, files] = await Promise.all([
    conn
      .select({
        purchaseId: materialPurchaseItems.purchaseId,
        materialId: materials.id,
        material: materials.name,
        unit: materials.unit,
        quantity: materialPurchaseItems.quantity,
        unitPrice: materialPurchaseItems.unitPrice,
        amount: materialPurchaseItems.amount,
      })
      .from(materialPurchaseItems)
      .innerJoin(materials, eq(materials.id, materialPurchaseItems.materialId))
      .where(inArray(materialPurchaseItems.purchaseId, ids))
      .orderBy(asc(materialPurchaseItems.position)),
    receiptsFor(rows.map((r) => r.p), conn),
  ]);
  return rows.map(({ p, ...r }) => ({
    id: p.id,
    siteId: p.siteId,
    date: p.purchaseDate,
    supplier: r.supplier,
    invoiceNumber: p.invoiceNumber,
    deliveryRef: p.deliveryRef,
    paymentMethod: p.paymentMethod,
    total: p.totalAmount,
    bill: p.supplierBillId && r.billAmount ? { id: p.supplierBillId, amount: r.billAmount, paid: r.billPaid, dueDate: r.billDue! } : null,
    expenseId: p.expenseId,
    items: items
      .filter((i) => i.purchaseId === p.id)
      .map((i) => ({ materialId: i.materialId, material: i.material, unit: i.unit, quantity: trimQty(i.quantity), unitPrice: i.unitPrice, amount: i.amount })),
    attachment: files.get(p.id),
    enteredBy: r.enteredBy,
    voided: p.voidedAt ? { at: p.voidedAt.toISOString(), reason: p.voidReason } : null,
    notes: p.notes,
  }));
}

/** A purchase's receipt is stored on the expense or bill that carries its money. */
async function receiptsFor(list: { id: string; expenseId: string | null; supplierBillId: string | null }[], conn: Conn) {
  const out = new Map<string, Attachment>();
  const expenseIds = list.map((p) => p.expenseId).filter((v): v is string => !!v);
  const billIds = list.map((p) => p.supplierBillId).filter((v): v is string => !!v);
  if (!expenseIds.length && !billIds.length) return out;
  const rows = await conn
    .select({ id: receipts.id, expenseId: receipts.expenseId, billId: receipts.supplierBillId, name: receipts.fileName, size: receipts.sizeBytes, type: receipts.contentType })
    .from(receipts)
    .where(sql`${receipts.deletedAt} is null and (${receipts.expenseId} in ${expenseIds.length ? expenseIds : [null]} or ${receipts.supplierBillId} in ${billIds.length ? billIds : [null]})`)
    .orderBy(asc(receipts.createdAt));
  for (const p of list) {
    const r = rows.find((x) => (p.expenseId && x.expenseId === p.expenseId) || (p.supplierBillId && x.billId === p.supplierBillId));
    if (r) out.set(p.id, { id: r.id, name: r.name, size: r.size, kind: r.type === "application/pdf" ? "pdf" : "image", url: `/api/receipts/${r.id}` });
  }
  return out;
}

export async function listPurchases(actor: Actor, siteId: string): Promise<Purchase[]> {
  await requireSitePermission(actor, siteId, "site:read");
  return loadPurchases(eq(materialPurchases.siteId, siteId));
}

export async function getPurchase(actor: Actor, id: string, conn: Conn = db): Promise<Purchase> {
  if (!uuid.safeParse(id).success) throw new NotFoundError("Purchase");
  const [row] = await loadPurchases(eq(materialPurchases.id, id), conn);
  if (!row || !can(await siteRoleFor(actor, row.siteId, conn), "site:read")) throw new NotFoundError("Purchase");
  return row;
}

/**
 * Records a delivery. Paid now: one expense (source "purchase") with an item per
 * material. On credit: one supplier bill for the total, paid later from Bills.
 * Either way the purchase, its items, the money record and the audit entry are one transaction.
 */
export async function recordPurchase(actor: Actor, raw: unknown): Promise<Purchase> {
  const input = purchaseInput.parse(raw);
  const credit = input.paymentMethod === "credit";
  // Buying on credit creates a debt for the site, which is a finance decision.
  await requireSitePermission(actor, input.siteId, credit ? "finance:manage" : "field:record");
  await requireOpenSite(input.siteId);
  if (input.purchaseDate > today()) {
    throw new ValidationError("The purchase date can't be in the future.", { purchaseDate: "Pick today or earlier." });
  }

  const id = await db
    .transaction(async (tx) => {
      const ids = input.items.map((i) => i.materialId);
      const mats = await tx
        .select({ id: materials.id, name: materials.name, unit: materials.unit })
        .from(materials)
        .where(and(inArray(materials.id, ids), eq(materials.organizationId, actor.orgId), eq(materials.active, true)));
      if (mats.length !== ids.length) throw new NotFoundError("Material");
      const byId = new Map(mats.map((m) => [m.id, m]));

      // The total is Postgres arithmetic on the same numbers the items store, never a client value.
      const arr = (vals: string[]) => sql`array[${sql.join(vals.map((v) => sql`${v}`), sql`, `)}]::numeric[]`;
      const [{ total }] = (await tx.execute(sql`
        select coalesce(sum(round(t.q * t.p, 2)), 0)::text as total
        from unnest(${arr(input.items.map((i) => i.quantity))}, ${arr(input.items.map((i) => i.unitPrice))}) as t(q, p)
      `)) as unknown as { total: string }[];

      const supplierId = await supplierIdByName(actor, input.supplierName, tx);
      const catId = await categoryId(actor, "materials", tx);
      const summary = input.items.map((i) => `${byId.get(i.materialId)!.name} ${trimQty(i.quantity)} ${byId.get(i.materialId)!.unit}`).join(", ");
      const description = `${summary}${input.supplierName ? `, ${input.supplierName}` : ""}`.slice(0, 200);

      let expenseId: string | null = null;
      let supplierBillId: string | null = null;
      if (credit) {
        const [bill] = await tx
          .insert(supplierBills)
          .values({
            siteId: input.siteId,
            supplierId: supplierId!,
            categoryId: catId,
            billNumber: input.invoiceNumber!,
            billDate: input.purchaseDate,
            dueDate: input.dueDate ?? input.purchaseDate,
            amount: total,
            description: `Materials: ${summary}`.slice(0, 500),
            createdBy: actor.userId,
          })
          .returning({ id: supplierBills.id })
          .catch((err) => rethrowUnique(err, "invoiceNumber", "This supplier already has a bill with that invoice number."));
        supplierBillId = bill.id;
      } else {
        const [exp] = await tx
          .insert(expenses)
          .values({
            siteId: input.siteId,
            categoryId: catId,
            expenseDate: input.purchaseDate,
            description,
            paymentMethod: input.paymentMethod,
            source: "purchase",
            supplierId,
            notes: [input.invoiceNumber && `Invoice ${input.invoiceNumber}`, input.deliveryRef && `Delivery ${input.deliveryRef}`].filter(Boolean).join(", ") || undefined,
            createdBy: actor.userId,
            ...enteredApproved(actor),
          })
          .returning({ id: expenses.id });
        await tx.insert(expenseItems).values(
          input.items.map((i, position) => ({
            expenseId: exp.id,
            position,
            description: byId.get(i.materialId)!.name,
            quantity: i.quantity,
            unit: byId.get(i.materialId)!.unit.slice(0, 20),
            unitPrice: i.unitPrice,
          })),
        );
        await tx.execute(sql`update expenses set total_amount = (select sum(amount) from expense_items where expense_id = ${exp.id}) where id = ${exp.id}`);
        expenseId = exp.id;
      }

      const [purchase] = await tx
        .insert(materialPurchases)
        .values({
          siteId: input.siteId,
          supplierId,
          purchaseDate: input.purchaseDate,
          invoiceNumber: input.invoiceNumber,
          deliveryRef: input.deliveryRef,
          paymentMethod: input.paymentMethod,
          totalAmount: total,
          expenseId,
          supplierBillId,
          notes: input.notes,
          createdBy: actor.userId,
        })
        .returning({ id: materialPurchases.id });
      await tx.insert(materialPurchaseItems).values(
        input.items.map((i, position) => ({ purchaseId: purchase.id, materialId: i.materialId, position, quantity: i.quantity, unitPrice: i.unitPrice })),
      );
      await audit(tx, actor, {
        siteId: input.siteId,
        action: "purchase.create",
        entityType: "material_purchase",
        entityId: purchase.id,
        summary: `Bought ${summary} for ${formatINR(num(total))}${credit ? " on credit" : ""}`,
        data: { ...input, total, expenseId, supplierBillId },
      });
      return purchase.id;
    });
  return getPurchase(actor, id);
}

/**
 * Cancels a purchase entered by mistake. The record stays (marked void, with the
 * reason); its expense is soft-deleted, or its unpaid bill removed. Refused when
 * the bill has payments, or when the stock it added has already been used.
 */
export async function voidPurchase(actor: Actor, raw: unknown): Promise<Purchase> {
  const input = voidInput.parse(raw);
  await db.transaction(async (tx) => {
    const [p] = await tx.select().from(materialPurchases).where(eq(materialPurchases.id, input.id)).for("update");
    if (!p) throw new NotFoundError("Purchase");
    const role = await siteRoleFor(actor, p.siteId, tx);
    if (!role) throw new NotFoundError("Purchase");
    if (!can(role, "finance:manage")) throw new ForbiddenError("Only the site owner or accountant can void a purchase.");
    if (p.voidedAt) return;

    const items = await tx.select().from(materialPurchaseItems).where(eq(materialPurchaseItems.purchaseId, p.id));
    for (const it of items) {
      await lockStock(tx, p.siteId, it.materialId);
      const s = await stockOf(tx, p.siteId, it.materialId);
      if (Number(s.onHand) < Number(it.quantity)) {
        throw new ValidationError("Some of this stock has already been used. Remove those usage entries before voiding the purchase.");
      }
    }
    if (p.supplierBillId) {
      const [{ n }] = (await tx.execute(sql`select count(*)::int as n from payments where supplier_bill_id = ${p.supplierBillId}`)) as unknown as { n: number }[];
      if (n > 0) throw new ValidationError("This purchase's bill already has payments, so it can't be voided.");
    }
    await tx
      .update(materialPurchases)
      .set({ voidedAt: new Date(), voidedBy: actor.userId, voidReason: input.reason, supplierBillId: null })
      .where(eq(materialPurchases.id, p.id));
    if (p.supplierBillId) {
      await tx.delete(receipts).where(eq(receipts.supplierBillId, p.supplierBillId));
      await tx.delete(supplierBills).where(eq(supplierBills.id, p.supplierBillId));
    }
    if (p.expenseId) await tx.update(expenses).set({ deletedAt: new Date() }).where(eq(expenses.id, p.expenseId));
    await audit(tx, actor, {
      siteId: p.siteId,
      action: "purchase.void",
      entityType: "material_purchase",
      entityId: p.id,
      summary: `Voided a purchase of ${formatINR(num(p.totalAmount))}: ${input.reason}`,
      data: { reason: input.reason, expenseId: p.expenseId, supplierBillId: p.supplierBillId },
    });
  });
  return getPurchase(actor, input.id);
}

// ---- Usage and stock ----------------------------------------------------------------

/** Serializes stock changes for one material on one site, so two usages can't both take the last bag. */
async function lockStock(conn: Conn, siteId: string, materialId: string) {
  await conn.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`stock:${siteId}:${materialId}`}, 0))`);
}

async function stockOf(conn: Conn, siteId: string, materialId: string) {
  const [row] = (await conn.execute(sql`
    select
      (select coalesce(sum(i.quantity), 0) from material_purchase_items i join material_purchases p on p.id = i.purchase_id
        where p.site_id = ${siteId} and i.material_id = ${materialId} and p.voided_at is null)::text as purchased,
      (select coalesce(sum(quantity), 0) from material_usage
        where site_id = ${siteId} and material_id = ${materialId} and deleted_at is null)::text as used
  `)) as unknown as { purchased: string; used: string }[];
  const [{ on_hand }] = (await conn.execute(sql`select (${row.purchased}::numeric - ${row.used}::numeric)::text as on_hand`)) as unknown as { on_hand: string }[];
  return { purchased: row.purchased, used: row.used, onHand: on_hand };
}

export type StockRow = {
  materialId: string;
  material: string;
  unit: string;
  purchased: string;
  used: string;
  onHand: string;
  /** What was paid for this material on the site, from non-voided purchases. */
  purchasedValue: string;
  /** purchasedValue ÷ purchased: the average cost of one unit here. */
  averageUnitCost: string | null;
};

/** Purchased, used and on-hand quantities per material for a site. */
export async function siteStock(actor: Actor, siteId: string): Promise<StockRow[]> {
  await requireSitePermission(actor, siteId, "site:read");
  const rows = (await db.execute(sql`
    with bought as (
      select i.material_id, sum(i.quantity) as qty, sum(i.amount) as value
      from material_purchase_items i join material_purchases p on p.id = i.purchase_id
      where p.site_id = ${siteId} and p.voided_at is null
      group by i.material_id
    ), used as (
      select material_id, sum(quantity) as qty from material_usage
      where site_id = ${siteId} and deleted_at is null group by material_id
    )
    select m.id, m.name, m.unit,
           coalesce(b.qty, 0)::text as purchased, coalesce(u.qty, 0)::text as used,
           (coalesce(b.qty, 0) - coalesce(u.qty, 0))::text as on_hand,
           coalesce(b.value, 0)::text as value,
           case when coalesce(b.qty, 0) > 0 then round(b.value / b.qty, 2)::text end as avg_cost
    from materials m
    left join bought b on b.material_id = m.id
    left join used u on u.material_id = m.id
    where m.organization_id = ${actor.orgId} and (b.qty is not null or u.qty is not null)
    order by m.name
  `)) as unknown as { id: string; name: string; unit: string; purchased: string; used: string; on_hand: string; value: string; avg_cost: string | null }[];
  return rows.map((r) => ({
    materialId: r.id,
    material: r.name,
    unit: r.unit,
    purchased: trimQty(r.purchased),
    used: trimQty(r.used),
    onHand: trimQty(r.on_hand),
    purchasedValue: r.value,
    averageUnitCost: r.avg_cost,
  }));
}

export type Usage = { id: string; date: string; materialId: string; material: string; unit: string; quantity: string; purpose: string | null; enteredBy: string; canDelete: boolean };

export async function listUsage(actor: Actor, siteId: string): Promise<Usage[]> {
  const role = await requireSitePermission(actor, siteId, "site:read");
  const rows = await db
    .select({ u: materialUsage, material: materials.name, unit: materials.unit, enteredBy: users.name })
    .from(materialUsage)
    .innerJoin(materials, eq(materials.id, materialUsage.materialId))
    .innerJoin(users, eq(users.id, materialUsage.createdBy))
    .where(and(eq(materialUsage.siteId, siteId), isNull(materialUsage.deletedAt)))
    .orderBy(desc(materialUsage.usedOn), desc(materialUsage.createdAt));
  return rows.map(({ u, ...r }) => ({
    id: u.id,
    date: u.usedOn,
    materialId: u.materialId,
    material: r.material,
    unit: r.unit,
    quantity: trimQty(u.quantity),
    purpose: u.purpose,
    enteredBy: r.enteredBy,
    canDelete: can(role, "expense:edit_any") || (can(role, "field:record") && u.createdBy === actor.userId),
  }));
}

/** Takes material out of stock. Refused if the site doesn't have that much on hand. */
export async function recordUsage(actor: Actor, raw: unknown): Promise<Usage> {
  const input = usageInput.parse(raw);
  await requireSitePermission(actor, input.siteId, "field:record");
  await requireOpenSite(input.siteId);
  if (input.usedOn > today()) throw new ValidationError("The date can't be in the future.", { usedOn: "Pick today or earlier." });
  const id = await db.transaction(async (tx) => {
    const [mat] = await tx.select().from(materials).where(and(eq(materials.id, input.materialId), eq(materials.organizationId, actor.orgId))).limit(1);
    if (!mat) throw new NotFoundError("Material");
    await lockStock(tx, input.siteId, input.materialId);
    const stock = await stockOf(tx, input.siteId, input.materialId);
    const [{ short }] = (await tx.execute(sql`select ${input.quantity}::numeric > ${stock.onHand}::numeric as short`)) as unknown as { short: boolean }[];
    if (short) {
      const message = `Only ${trimQty(stock.onHand)} ${mat.unit} of ${mat.name} is in stock on this site. Record the purchase first.`;
      throw new ValidationError(message, { quantity: message });
    }
    const [row] = await tx
      .insert(materialUsage)
      .values({ ...input, createdBy: actor.userId })
      .returning({ id: materialUsage.id });
    await audit(tx, actor, {
      siteId: input.siteId,
      action: "usage.create",
      entityType: "material_usage",
      entityId: row.id,
      summary: `Used ${trimQty(input.quantity)} ${mat.unit} of ${mat.name}${input.purpose ? ` for ${input.purpose}` : ""}`,
      data: input,
    });
    return row.id;
  });
  const list = await listUsage(actor, input.siteId);
  return list.find((u) => u.id === id)!;
}

/** Soft delete, so the audit trail and the entry itself survive. */
export async function deleteUsage(actor: Actor, id: string) {
  if (!uuid.safeParse(id).success) throw new NotFoundError("Usage entry");
  await db.transaction(async (tx) => {
    const [u] = await tx.select().from(materialUsage).where(eq(materialUsage.id, id)).for("update");
    if (!u) throw new NotFoundError("Usage entry");
    const role = await siteRoleFor(actor, u.siteId, tx);
    if (!role) throw new NotFoundError("Usage entry");
    if (!(can(role, "expense:edit_any") || (can(role, "field:record") && u.createdBy === actor.userId))) {
      throw new ForbiddenError("Engineers can only remove usage they entered.");
    }
    if (u.deletedAt) return;
    await tx.update(materialUsage).set({ deletedAt: new Date(), deletedBy: actor.userId }).where(eq(materialUsage.id, id));
    await audit(tx, actor, {
      siteId: u.siteId,
      action: "usage.delete",
      entityType: "material_usage",
      entityId: u.id,
      summary: `Removed a usage entry of ${trimQty(u.quantity)} on ${u.usedOn}`,
      data: { materialId: u.materialId, quantity: u.quantity, usedOn: u.usedOn },
    });
  });
}
