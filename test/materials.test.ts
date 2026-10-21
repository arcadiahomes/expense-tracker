import { and, eq, isNull, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { db } from "@/db";
import { auditLog, constructionSites, expenses, supplierBills } from "@/db/schema";
import { recordPayment } from "@/server/data/bills";
import { deleteExpense, updateExpense } from "@/server/data/expenses";
import {
  createMaterial,
  deleteUsage,
  listPurchases,
  recordPurchase,
  recordUsage,
  siteStock,
  updateMaterial,
  voidPurchase,
} from "@/server/data/materials";
import { createSite } from "@/server/data/sites";
import { supplierDirectory } from "@/server/data/suppliers";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { expense, world } from "./fixtures";

let w: Awaited<ReturnType<typeof world>>;
let cement: string;
let sand: string;
beforeAll(async () => {
  w = await world();
  cement = (await createMaterial(w.a.eng1, { name: "Cement", unit: "bags", defaultUnitPrice: "400" })).id;
  sand = (await createMaterial(w.a.owner, { name: "Sand", unit: "loads" })).id;
});

const purchase = (over: Record<string, unknown> = {}) => ({
  siteId: w.site1,
  purchaseDate: "2026-10-20",
  paymentMethod: "cash",
  items: [{ materialId: cement, quantity: "20", unitPrice: "400" }],
  ...over,
});
const stockOf = async (materialId: string, siteId = w.site1) =>
  (await siteStock(w.a.owner, siteId)).find((s) => s.materialId === materialId);
const siteSpend = async (siteId: string) =>
  ((await db.execute(sql`select coalesce(sum(total_amount), 0)::text as t from expenses where site_id = ${siteId} and deleted_at is null`)) as unknown as { t: string }[])[0].t;

describe("material catalog", () => {
  it("is managed by people who can add expenses, with unique names", async () => {
    await expect(createMaterial(w.a.viewer, { name: "Tiles", unit: "boxes" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createMaterial(w.a.eng1, { name: "Cement", unit: "bags" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createMaterial(w.a.eng1, { name: "", unit: "bags" })).rejects.toBeInstanceOf(ZodError);
    // Each organization has its own catalog.
    expect((await createMaterial(w.b.owner, { name: "Cement", unit: "bags" })).name).toBe("Cement");
  });

  it("can't change a unit once stock has moved", async () => {
    const tmt = await createMaterial(w.a.eng1, { name: "TMT 12mm", unit: "kg" });
    await recordPurchase(w.a.eng1, purchase({ items: [{ materialId: tmt.id, quantity: "100", unitPrice: "70" }] }));
    await expect(updateMaterial(w.a.eng1, { id: tmt.id, name: "TMT 12mm", unit: "tons" })).rejects.toBeInstanceOf(ValidationError);
    expect((await updateMaterial(w.a.eng1, { id: tmt.id, name: "TMT Fe500 12mm", unit: "kg" })).name).toBe("TMT Fe500 12mm");
  });
});

describe("purchases", () => {
  it("paid now: one expense with an item per material, totalled in the database", async () => {
    const before = await siteSpend(w.site1);
    const p = await recordPurchase(
      w.a.eng1,
      purchase({
        supplierName: "Malabar Traders",
        invoiceNumber: "MT-101",
        deliveryRef: "DC-55",
        paymentMethod: "upi",
        items: [
          { materialId: cement, quantity: "20", unitPrice: "400" },
          { materialId: sand, quantity: "2", unitPrice: "4750.50" },
        ],
        totalAmount: "1",
      }),
    );
    expect(p.total).toBe("17501.00");
    expect(p.bill).toBeNull();
    expect(p.items.map((i) => [i.material, i.quantity, i.amount])).toEqual([
      ["Cement", "20", "8000.00"],
      ["Sand", "2", "9501.00"],
    ]);
    const [exp] = await db.select().from(expenses).where(eq(expenses.id, p.expenseId!));
    expect([exp.source, exp.totalAmount, exp.paymentMethod]).toEqual(["purchase", "17501.00", "upi"]);
    expect(Number(await siteSpend(w.site1)) - Number(before)).toBe(17501);
    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, p.id));
    expect(audit.map((a) => a.action)).toEqual(["purchase.create"]);
  });

  it("on credit: a supplier bill, no spending until it's paid, and only for finance roles", async () => {
    const body = purchase({ supplierName: "Kerala Steels", invoiceNumber: "KS-9", paymentMethod: "credit", dueDate: "2026-11-05", items: [{ materialId: sand, quantity: "3", unitPrice: "5000" }] });
    await expect(recordPurchase(w.a.eng1, body)).rejects.toBeInstanceOf(ForbiddenError);
    const before = await siteSpend(w.site1);
    const p = await recordPurchase(w.a.accountant, body);
    expect(p.expenseId).toBeNull();
    expect(p.bill).toMatchObject({ amount: "15000.00", paid: "0", dueDate: "2026-11-05" });
    expect(await siteSpend(w.site1)).toBe(before);

    await recordPayment(w.a.accountant, { billId: p.bill!.id, amount: "6000", paidOn: "2026-10-20", method: "bank" });
    expect(Number(await siteSpend(w.site1)) - Number(before)).toBe(6000);
    const ks = (await supplierDirectory(w.a.accountant)).find((s) => s.name === "Kerala Steels")!;
    expect([ks.billed, ks.paid, ks.outstanding]).toEqual(["15000.00", "6000.00", "9000.00"]);
    // The same invoice number can't be billed twice.
    await expect(recordPurchase(w.a.accountant, body)).rejects.toBeInstanceOf(ValidationError);
  });

  it("validate their inputs on the server", async () => {
    await expect(recordPurchase(w.a.accountant, purchase({ paymentMethod: "credit" }))).rejects.toBeInstanceOf(ZodError);
    await expect(recordPurchase(w.a.eng1, purchase({ purchaseDate: "2026-10-21" }))).rejects.toBeInstanceOf(ValidationError);
    await expect(recordPurchase(w.a.eng1, purchase({ items: [{ materialId: cement, quantity: "0", unitPrice: "400" }] }))).rejects.toBeInstanceOf(ZodError);
    await expect(recordPurchase(w.a.eng1, purchase({ items: [{ materialId: cement, quantity: "1", unitPrice: "1.005" }] }))).rejects.toBeInstanceOf(ZodError);
    await expect(
      recordPurchase(w.a.eng1, purchase({ items: [{ materialId: cement, quantity: "1", unitPrice: "1" }, { materialId: cement, quantity: "2", unitPrice: "1" }] })),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("respect site access and other organizations' materials", async () => {
    await expect(recordPurchase(w.a.viewer, purchase())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordPurchase(w.a.eng2, purchase())).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordPurchase(w.b.owner, purchase())).rejects.toBeInstanceOf(NotFoundError);
    const foreign = await createMaterial(w.b.owner, { name: "Blocks", unit: "nos" });
    await expect(recordPurchase(w.a.eng1, purchase({ items: [{ materialId: foreign.id, quantity: "1", unitPrice: "1" }] }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(listPurchases(w.a.eng2, w.site1)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("aren't accepted on completed sites or for retired materials", async () => {
    const closed = await createSite(w.a.owner, { name: "Done Site", location: "Kollam", budget: "1000", startDate: "2026-01-01" });
    await db.update(constructionSites).set({ status: "completed" }).where(eq(constructionSites.id, closed.site.id));
    await expect(recordPurchase(w.a.owner, purchase({ siteId: closed.site.id }))).rejects.toBeInstanceOf(ValidationError);
    const old = await createMaterial(w.a.owner, { name: "Old putty", unit: "kg" });
    await updateMaterial(w.a.owner, { id: old.id, name: "Old putty", unit: "kg", active: false });
    await expect(recordPurchase(w.a.owner, purchase({ items: [{ materialId: old.id, quantity: "1", unitPrice: "1" }] }))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("keep their expense out of the general edit and delete paths", async () => {
    const p = await recordPurchase(w.a.eng1, purchase());
    await expect(updateExpense(w.a.eng1, { ...expense(w.site1), id: p.expenseId })).rejects.toBeInstanceOf(ValidationError);
    await expect(deleteExpense(w.a.eng1, p.expenseId!)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("usage and stock", () => {
  let site: string;
  let gravel: string;
  beforeAll(async () => {
    site = (await createSite(w.a.owner, { name: "Stock Site", location: "Aluva", budget: "1000000", startDate: "2026-01-01" })).site.id;
    gravel = (await createMaterial(w.a.owner, { name: "Gravel", unit: "cft" })).id;
    await recordPurchase(w.a.owner, purchase({ siteId: site, items: [{ materialId: gravel, quantity: "20", unitPrice: "50" }] }));
  });

  it("takes quantity out of stock without counting as spending", async () => {
    const before = await siteSpend(site);
    await recordUsage(w.a.owner, { siteId: site, materialId: gravel, usedOn: "2026-10-20", quantity: "12", purpose: "Footing" });
    const s = await stockOf(gravel, site);
    expect([s?.purchased, s?.used, s?.onHand, s?.purchasedValue, s?.averageUnitCost]).toEqual(["20", "12", "8", "1000.00", "50.00"]);
    expect(await siteSpend(site)).toBe(before);
  });

  it("refuses to use more than is on hand, even when two requests race", async () => {
    await expect(recordUsage(w.a.owner, { siteId: site, materialId: gravel, usedOn: "2026-10-20", quantity: "9" })).rejects.toBeInstanceOf(ValidationError);
    const results = await Promise.allSettled([
      recordUsage(w.a.owner, { siteId: site, materialId: gravel, usedOn: "2026-10-20", quantity: "5" }),
      recordUsage(w.a.owner, { siteId: site, materialId: gravel, usedOn: "2026-10-20", quantity: "5" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await stockOf(gravel, site))?.onHand).toBe("3");
    // A refused usage leaves no audit entry.
    const refused = await db.select().from(auditLog).where(and(eq(auditLog.siteId, site), eq(auditLog.action, "usage.create")));
    expect(refused).toHaveLength(2);
  });

  it("is limited by role, and engineers remove only their own entries", async () => {
    const u = await recordUsage(w.a.eng1, { siteId: w.site1, materialId: cement, usedOn: "2026-10-20", quantity: "1" });
    await expect(recordUsage(w.a.viewer, { siteId: w.site1, materialId: cement, usedOn: "2026-10-20", quantity: "1" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordUsage(w.a.eng2, { siteId: w.site1, materialId: cement, usedOn: "2026-10-20", quantity: "1" })).rejects.toBeInstanceOf(NotFoundError);
    const theirs = await recordUsage(w.a.accountant, { siteId: w.site1, materialId: cement, usedOn: "2026-10-20", quantity: "1" });
    await expect(deleteUsage(w.a.eng1, theirs.id)).rejects.toBeInstanceOf(ForbiddenError);
    await deleteUsage(w.a.eng1, u.id);
    await deleteUsage(w.a.accountant, theirs.id);
  });
});

describe("voiding purchases", () => {
  it("is for finance roles, and refused once the stock is used", async () => {
    const lime = (await createMaterial(w.a.owner, { name: "Lime", unit: "kg" })).id;
    const p = await recordPurchase(w.a.eng1, purchase({ items: [{ materialId: lime, quantity: "10", unitPrice: "30" }] }));
    await expect(voidPurchase(w.a.eng1, { id: p.id, reason: "Entered twice" })).rejects.toBeInstanceOf(ForbiddenError);
    const used = await recordUsage(w.a.eng1, { siteId: w.site1, materialId: lime, usedOn: "2026-10-20", quantity: "4" });
    await expect(voidPurchase(w.a.accountant, { id: p.id, reason: "Entered twice" })).rejects.toBeInstanceOf(ValidationError);
    await deleteUsage(w.a.eng1, used.id);

    const before = await siteSpend(w.site1);
    const voided = await voidPurchase(w.a.accountant, { id: p.id, reason: "Entered twice" });
    expect(voided.voided?.reason).toBe("Entered twice");
    expect(Number(before) - Number(await siteSpend(w.site1))).toBe(300);
    // Nothing live is left for this material on the site, so it drops out of the stock list.
    expect(await stockOf(lime)).toBeUndefined();
    const [exp] = await db.select().from(expenses).where(eq(expenses.id, p.expenseId!));
    expect(exp.deletedAt).not.toBeNull();
  });

  it("removes an unpaid credit bill, and refuses once the bill has payments", async () => {
    const lime = (await createMaterial(w.a.owner, { name: "Lime 2", unit: "kg" })).id;
    const unpaid = await recordPurchase(w.a.accountant, purchase({ supplierName: "Void Co", invoiceNumber: "V-1", paymentMethod: "credit", items: [{ materialId: lime, quantity: "1", unitPrice: "100" }] }));
    await voidPurchase(w.a.accountant, { id: unpaid.id, reason: "Wrong supplier" });
    expect(await db.select().from(supplierBills).where(eq(supplierBills.id, unpaid.bill!.id))).toEqual([]);

    const paid = await recordPurchase(w.a.accountant, purchase({ supplierName: "Void Co", invoiceNumber: "V-2", paymentMethod: "credit", items: [{ materialId: lime, quantity: "1", unitPrice: "100" }] }));
    await recordPayment(w.a.accountant, { billId: paid.bill!.id, amount: "50", paidOn: "2026-10-20", method: "cash" });
    await expect(voidPurchase(w.a.accountant, { id: paid.id, reason: "x" })).rejects.toBeInstanceOf(ValidationError);
    const open = await db.select().from(supplierBills).where(and(eq(supplierBills.id, paid.bill!.id)));
    expect(open).toHaveLength(1);
    expect(await db.select().from(expenses).where(and(eq(expenses.supplierBillId, paid.bill!.id), isNull(expenses.deletedAt)))).toHaveLength(1);
  });
});
