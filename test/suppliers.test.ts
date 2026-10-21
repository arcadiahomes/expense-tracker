import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { listAudit } from "@/server/data/audit";
import { createBill, recordPayment } from "@/server/data/bills";
import { createExpense } from "@/server/data/expenses";
import { createSupplier, supplierDetail, supplierDirectory, updateSupplier } from "@/server/data/suppliers";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { expense, world } from "./fixtures";

let w: Awaited<ReturnType<typeof world>>;
let supplierId: string;
beforeAll(async () => {
  w = await world();
  supplierId = (await createSupplier(w.a.eng1, { name: "Sri Balaji Traders", phone: "9847000000" })).id;
  const b1 = await createBill(w.a.accountant, { siteId: w.site1, supplierName: "Sri Balaji Traders", billNumber: "SB-1", billDate: "2026-10-01", dueDate: "2026-10-10", amount: "10000" });
  await createBill(w.a.accountant, { siteId: w.site1, supplierName: "Sri Balaji Traders", billNumber: "SB-2", billDate: "2026-10-15", dueDate: "2026-10-30", amount: "4000" });
  await createBill(w.a.owner, { siteId: w.site2, supplierName: "Sri Balaji Traders", billNumber: "SB-3", billDate: "2026-10-15", dueDate: "2026-10-30", amount: "2500" });
  await recordPayment(w.a.accountant, { billId: b1.id, amount: "6000", paidOn: "2026-10-05", method: "bank", reference: "UTR123" });
  await createExpense(w.a.eng1, expense(w.site1, { supplierName: "Sri Balaji Traders", items: [{ description: "Nails", unitPrice: "750" }] }));
});

describe("supplier balances", () => {
  it("sum bills, payments and what's still owed, with overdue split out", async () => {
    const s = (await supplierDirectory(w.a.owner)).find((x) => x.id === supplierId)!;
    expect([s.billCount, s.billed, s.paid, s.outstanding, s.overdue, s.paidDirect]).toEqual([3, "16500.00", "6000.00", "10500.00", "4000.00", "750.00"]);
  });

  it("count only the sites the viewer can see", async () => {
    const eng2 = (await supplierDirectory(w.a.eng2)).find((x) => x.id === supplierId)!;
    expect([eng2.billCount, eng2.billed, eng2.outstanding, eng2.paidDirect]).toEqual([1, "2500.00", "2500.00", "0"]);
    const viewer = (await supplierDirectory(w.a.viewer)).find((x) => x.id === supplierId)!;
    expect(viewer.billed).toBe("14000.00");
    expect((await supplierDirectory(w.b.owner)).some((x) => x.id === supplierId)).toBe(false);
  });

  it("show each invoice and the payment history", async () => {
    const d = await supplierDetail(w.a.accountant, supplierId);
    expect(d.bills.map((b) => [b.invoiceNumber, b.amount, b.paid, b.outstanding, b.status])).toEqual([
      ["SB-2", "4000.00", "0", "4000.00", "pending"],
      ["SB-1", "10000.00", "6000.00", "4000.00", "overdue"],
    ]);
    expect(d.payments.map((p) => [p.invoiceNumber, p.amount, p.method, p.reference, p.enteredBy])).toEqual([["SB-1", "6000.00", "bank", "UTR123", "Accountant"]]);
    await expect(supplierDetail(w.b.owner, supplierId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(supplierDetail(w.a.owner, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("supplier directory", () => {
  it("is edited by writers, with unique names and an audit entry", async () => {
    await expect(createSupplier(w.a.viewer, { name: "Nope" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createSupplier(w.a.eng1, { name: "Sri Balaji Traders" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createSupplier(w.a.eng1, { name: "Bad GST", gstin: "123" })).rejects.toThrow();
    await updateSupplier(w.a.eng1, supplierId, { name: "Sri Balaji Traders", gstin: "32ABCDE1234F1Z5" });
    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, supplierId));
    expect(audit.map((a) => a.action).sort()).toEqual(["supplier.create", "supplier.update"]);
    await expect(updateSupplier(w.b.owner, supplierId, { name: "Hijack" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("activity log", () => {
  it("records money changes with who made them", async () => {
    const { items } = await listAudit(w.a.accountant, { siteId: w.site1 });
    const actions = items.map((i) => i.action);
    expect(actions).toEqual(expect.arrayContaining(["bill.create", "bill.payment", "expense.create"]));
    expect(items.find((i) => i.action === "bill.payment")).toMatchObject({ actorName: "Accountant", siteId: w.site1 });
    expect(items.every((i) => i.siteId === w.site1)).toBe(true);
  });

  it("is only for owners and accountants of the site", async () => {
    await expect(listAudit(w.a.eng1, { siteId: w.site1 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listAudit(w.a.viewer, { siteId: w.site1 })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listAudit(w.a.eng1)).items).toEqual([]);
    await expect(listAudit(w.b.owner, { siteId: w.site1 })).rejects.toBeInstanceOf(NotFoundError);
    // The site owner sees site 1 but not site 2, and not org-wide entries.
    const owner = await listAudit(w.a.siteOwner);
    expect(owner.items.length).toBeGreaterThan(0);
    expect(owner.items.every((i) => i.siteId === w.site1)).toBe(true);
    // Org admins also see org-wide changes such as the supplier directory.
    expect((await listAudit(w.a.owner)).items.some((i) => i.siteId === null && i.entityId === supplierId)).toBe(true);
  });

  it("pages without repeating or skipping entries", async () => {
    const all = (await listAudit(w.a.owner, { limit: 100 })).items.map((i) => i.id);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listAudit(w.a.owner, { limit: 2, cursor });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(all);
  });
});
