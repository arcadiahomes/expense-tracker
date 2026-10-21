import { beforeAll, describe, expect, it } from "vitest";
import { billTotals, createBill, getBill, listBills, recordPayment } from "@/server/data/bills";
import { listExpenses } from "@/server/data/expenses";
import { addReceipt, readReceipt } from "@/server/data/receipts";
import { getSite } from "@/server/data/sites";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { world } from "./fixtures";

let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => {
  w = await world();
});

const bill = (over: Record<string, unknown> = {}) => ({
  siteId: w.site1,
  supplierName: "Sri Balaji Cements",
  billDate: "2026-10-10",
  dueDate: "2026-10-30",
  amount: "10000",
  description: "Cement 25 bags",
  ...over,
});

describe("bills and payments", () => {
  it("only owners and accountants create bills", async () => {
    await expect(createBill(w.a.eng1, bill())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createBill(w.b.owner, bill())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("derives status from payments and due date, and links each payment to one expense", async () => {
    const spentBefore = (await getSite(w.a.owner, w.site1)).summary.spent;
    const b = await createBill(w.a.owner, bill({ billNumber: "SBC-1" }));
    expect(b.status).toBe("pending");

    const partial = await recordPayment(w.a.owner, { billId: b.id, amount: "4000.50", paidOn: "2026-10-12", method: "upi" });
    expect(partial.status).toBe("partial");
    expect(partial.paid).toBe(4000.5);

    await expect(
      recordPayment(w.a.owner, { billId: b.id, amount: "6000", paidOn: "2026-10-12" }),
    ).rejects.toBeInstanceOf(ValidationError);

    const paid = await recordPayment(w.a.owner, { billId: b.id, amount: "5999.50", paidOn: "2026-10-13" });
    expect(paid.status).toBe("paid");

    const linked = await listExpenses(w.a.owner, { siteId: w.site1, source: "bill_payment", limit: 10 });
    expect(linked.items.map((e) => e.amount).sort()).toEqual([4000.5, 5999.5]);
    expect(linked.items.every((e) => !e.canEdit)).toBe(true);
    expect((await getSite(w.a.owner, w.site1)).summary.spent).toBe(spentBefore + 10000);
  });

  it("marks unpaid bills past their due date as overdue", async () => {
    const b = await createBill(w.a.owner, bill({ billNumber: "SBC-2", billDate: "2026-09-01", dueDate: "2026-09-15" }));
    expect(b.status).toBe("overdue");
    const totals = await billTotals(w.a.owner);
    expect(totals.overdueCount).toBeGreaterThanOrEqual(1);
    const overdue = await listBills(w.a.owner, { status: "overdue" });
    expect(overdue.items.map((x) => x.id)).toContain(b.id);
  });

  it("rejects duplicate bill numbers per supplier", async () => {
    await createBill(w.a.owner, bill({ billNumber: "DUP-1" }));
    await expect(createBill(w.a.owner, bill({ billNumber: "DUP-1" }))).rejects.toBeInstanceOf(ValidationError);
  });

  it("hides other orgs' bills", async () => {
    const b = await createBill(w.a.owner, bill({ billNumber: "SBC-3" }));
    await expect(getBill(w.b.owner, b.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordPayment(w.b.owner, { billId: b.id, amount: "1", paidOn: "2026-10-12" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await listBills(w.b.owner)).items).toHaveLength(0);
  });
});

describe("receipts", () => {
  const pdf = new TextEncoder().encode("%PDF-1.4 test");

  it("stores the file and only serves it to people who can see the site", async () => {
    const b = await createBill(w.a.owner, bill({ billNumber: "RCPT-1" }));
    const r = await addReceipt(w.a.eng1, { siteId: w.site1, supplierBillId: b.id, fileName: "bill.pdf", contentType: "application/pdf" }, pdf);
    expect(r.sizeBytes).toBe(pdf.byteLength);
    expect(r.sha256).toHaveLength(64);
    const file = await readReceipt(w.a.viewer, r.id);
    expect(new TextDecoder().decode(file.bytes)).toBe("%PDF-1.4 test");
    await expect(readReceipt(w.a.eng2, r.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(readReceipt(w.b.owner, r.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses wrong types, viewers, and parents on another site", async () => {
    const b = await createBill(w.a.owner, bill({ billNumber: "RCPT-2" }));
    await expect(
      addReceipt(w.a.eng1, { siteId: w.site1, supplierBillId: b.id, fileName: "x.exe", contentType: "application/x-msdownload" }, pdf),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      addReceipt(w.a.viewer, { siteId: w.site1, supplierBillId: b.id, fileName: "a.pdf", contentType: "application/pdf" }, pdf),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      addReceipt(w.a.owner, { siteId: w.site2, supplierBillId: b.id, fileName: "a.pdf", contentType: "application/pdf" }, pdf),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
