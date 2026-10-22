import { beforeAll, describe, expect, it } from "vitest";
import {
  cancelInvoice,
  createClientInvoice,
  financialYear,
  getClientInvoice,
  invoiceTotals,
  labourInvoice,
  listClientInvoices,
  markInvoicePaid,
} from "@/server/data/invoices";
import { createWorker, labourBalances, recordAttendance, recordLabourPayment } from "@/server/data/labour";
import { createSite, getSite } from "@/server/data/sites";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { amountInWords, renderClientInvoicePdf, renderLabourInvoicePdf } from "@/server/reports/invoice-pdf";
import { world } from "./fixtures";

let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => {
  w = await world();
});

const invoice = (over: Record<string, unknown> = {}) => ({
  siteId: w.site1,
  invoiceDate: "2026-10-15",
  dueDate: "2026-10-30",
  clientName: "Mr. Thomas Varghese",
  clientAddress: "Kakkanad, Kochi",
  gstPercent: "18",
  items: [
    { description: "Foundation work, running bill 1", quantity: "2", unit: "lot", unitPrice: "1000.50" },
    { description: "Plastering", quantity: "3.5", unit: "sq m", unitPrice: "100" },
  ],
  ...over,
});

describe("client invoices", () => {
  it("are for people who manage finance on the site", async () => {
    await expect(createClientInvoice(w.a.eng1, invoice())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createClientInvoice(w.a.viewer, invoice())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createClientInvoice(w.b.owner, invoice())).rejects.toBeInstanceOf(NotFoundError);
    const inv = await createClientInvoice(w.a.accountant, invoice());
    await expect(getClientInvoice(w.a.eng1, inv.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getClientInvoice(w.b.owner, inv.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listClientInvoices(w.a.eng1)).items).toHaveLength(0);
    expect((await listClientInvoices(w.b.owner)).items).toHaveLength(0);
    expect((await getClientInvoice(w.a.siteOwner, inv.id)).id).toBe(inv.id);
  });

  it("works out subtotal, GST and total in SQL", async () => {
    const inv = await createClientInvoice(w.a.owner, invoice());
    // 2 × 1000.50 + 3.5 × 100 = 2351.00; 18% of that = 423.18.
    expect(inv.subtotal).toBe(2351);
    expect(inv.gst).toBe(423.18);
    expect(inv.total).toBe(2774.18);
    expect(inv.items.map((i) => i.amount)).toEqual(["2001.00", "350.00"]);
    const noGst = await createClientInvoice(w.a.owner, invoice({ gstPercent: "0" }));
    expect(noGst.total).toBe(2351);
  });

  it("numbers invoices per organization and financial year, unless a number is given", async () => {
    const { site: site } = await createSite(w.b.owner, { name: "Numbering Site", location: "Delhi", budget: "1", startDate: "2026-01-01" });
    const make = (invoiceDate: string) => createClientInvoice(w.b.owner, invoice({ siteId: site.id, invoiceDate, dueDate: invoiceDate }));
    expect((await make("2026-10-01")).invoiceNo).toBe("INV/2026-27/0001");
    expect((await make("2027-03-31")).invoiceNo).toBe("INV/2026-27/0002");
    expect((await make("2027-04-01")).invoiceNo).toBe("INV/2027-28/0001");
    const manual = await createClientInvoice(w.b.owner, invoice({ siteId: site.id, invoiceNumber: "RB-7" }));
    expect(manual.invoiceNo).toBe("RB-7");
    await expect(createClientInvoice(w.b.owner, invoice({ siteId: site.id, invoiceNumber: "RB-7" }))).rejects.toBeInstanceOf(ValidationError);
    expect((await make("2026-11-01")).invoiceNo).toBe("INV/2026-27/0003");
    expect(financialYear("2027-01-15")).toBe("2026-27");
  });

  it("derives status, and never counts as spend", async () => {
    const spentBefore = (await getSite(w.a.owner, w.site2)).summary.spent;
    const late = await createClientInvoice(w.a.owner, invoice({ siteId: w.site2, invoiceDate: "2026-09-01", dueDate: "2026-09-15" }));
    expect(late.status).toBe("overdue");
    const open = await createClientInvoice(w.a.owner, invoice({ siteId: w.site2 }));
    expect(open.status).toBe("unpaid");

    await expect(markInvoicePaid(w.a.owner, { id: late.id, paidOn: "2026-10-25" })).rejects.toBeInstanceOf(ValidationError);
    await expect(markInvoicePaid(w.a.owner, { id: late.id, paidOn: "2026-08-01" })).rejects.toBeInstanceOf(ValidationError);
    await expect(markInvoicePaid(w.a.eng2, { id: late.id, paidOn: "2026-10-10" })).rejects.toBeInstanceOf(ForbiddenError);
    const paid = await markInvoicePaid(w.a.owner, { id: late.id, paidOn: "2026-10-10", method: "upi", reference: "UTR123" });
    expect(paid.status).toBe("paid");
    expect(paid.paidReference).toBe("UTR123");
    await expect(markInvoicePaid(w.a.owner, { id: late.id, paidOn: "2026-10-10" })).rejects.toBeInstanceOf(ValidationError);
    await expect(cancelInvoice(w.a.owner, { id: late.id, reason: "Mistake" })).rejects.toBeInstanceOf(ValidationError);

    await expect(cancelInvoice(w.a.owner, { id: open.id, reason: " " })).rejects.toThrow();
    const cancelled = await cancelInvoice(w.a.owner, { id: open.id, reason: "Wrong rate, reissued" });
    expect(cancelled.status).toBe("cancelled");
    await expect(markInvoicePaid(w.a.owner, { id: open.id, paidOn: "2026-10-16" })).rejects.toBeInstanceOf(ValidationError);

    expect((await getSite(w.a.owner, w.site2)).summary.spent).toBe(spentBefore);
    const cancelledList = await listClientInvoices(w.a.owner, { status: "cancelled", siteId: w.site2 });
    expect(cancelledList.items.map((i) => i.id)).toEqual([open.id]);
  });

  it("totals what's still to receive, leaving out paid and cancelled invoices", async () => {
    const { site } = await createSite(w.a.owner, { name: "Totals Site", location: "Kochi", budget: "1", startDate: "2026-01-01" });
    const before = await invoiceTotals(w.a.owner);
    const one = await createClientInvoice(w.a.owner, invoice({ siteId: site.id, gstPercent: "0" })); // 2351, unpaid
    const two = await createClientInvoice(w.a.owner, invoice({ siteId: site.id, gstPercent: "0", invoiceDate: "2026-09-01", dueDate: "2026-09-02" })); // overdue
    const three = await createClientInvoice(w.a.owner, invoice({ siteId: site.id, gstPercent: "0" }));
    await markInvoicePaid(w.a.owner, { id: three.id, paidOn: "2026-10-16" });
    const four = await createClientInvoice(w.a.owner, invoice({ siteId: site.id, gstPercent: "0" }));
    await cancelInvoice(w.a.owner, { id: four.id, reason: "Duplicate" });
    const after = await invoiceTotals(w.a.owner);
    expect(after.outstanding - before.outstanding).toBeCloseTo(2351 * 2, 2);
    expect(after.overdueAmount - before.overdueAmount).toBeCloseTo(2351, 2);
    expect(after.received - before.received).toBeCloseTo(2351, 2);
    expect(after.counts.all - before.counts.all).toBe(4);
    expect(after.counts.cancelled - before.counts.cancelled).toBe(1);
    expect([one.status, two.status]).toEqual(["unpaid", "overdue"]);
  });

  it("validates input", async () => {
    await expect(createClientInvoice(w.a.owner, invoice({ dueDate: "2026-10-01" }))).rejects.toThrow();
    await expect(createClientInvoice(w.a.owner, invoice({ gstPercent: "7" }))).rejects.toThrow();
    await expect(createClientInvoice(w.a.owner, invoice({ items: [] }))).rejects.toThrow();
    await expect(createClientInvoice(w.a.owner, invoice({ clientGstin: "BAD" }))).rejects.toThrow();
  });

  it("renders a PDF", async () => {
    const inv = await createClientInvoice(w.a.owner, invoice({ clientName: "ശ്രീ തോമസ്" }));
    const pdf = await renderClientInvoicePdf(inv, "Org A");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("labour invoices", () => {
  let site: string;
  let worker: string;
  beforeAll(async () => {
    site = (await createSite(w.a.owner, { name: "Labour Invoice Site", location: "Kochi", budget: "100000", startDate: "2026-01-01" })).site.id;
    worker = (await createWorker(w.a.owner, { name: "Invoice Worker", trade: "Mason", dailyWage: "800" })).id;
    for (const [workDate, status] of [["2026-09-28", "present"], ["2026-10-02", "present"], ["2026-10-03", "half_day"], ["2026-10-05", "absent"]] as const) {
      await recordAttendance(w.a.owner, { siteId: site, workerId: worker, workDate, status });
    }
    await recordLabourPayment(w.a.owner, { siteId: site, workerId: worker, kind: "advance", amount: "500", paidOn: "2026-09-29" });
    await recordLabourPayment(w.a.owner, { siteId: site, workerId: worker, kind: "wage", amount: "600", paidOn: "2026-10-04" });
  });

  it("carries the balance in, adds the period's wages and takes off its payments", async () => {
    const inv = await labourInvoice(w.a.owner, { siteId: site, workerId: worker, from: "2026-10-01", to: "2026-10-20" });
    expect(inv.opening).toBe("300.00"); // 800 earned − 500 advance before October
    expect(inv.earned).toBe("1200.00"); // 800 + 400
    expect(inv.wagesPaid).toBe("600.00");
    expect(inv.advances).toBe("0.00");
    expect(inv.closing).toBe("900.00");
    expect(inv.days).toBe("1.5");
    expect(inv.attendance.map((a) => a.date)).toEqual(["2026-10-02", "2026-10-03"]);
    expect(inv.payments).toHaveLength(1);
    const balance = (await labourBalances(w.a.owner, site)).workers.find((b) => b.workerId === worker)!;
    expect(balance.balance).toBe(inv.closing);

    const all = await labourInvoice(w.a.owner, { siteId: site, workerId: worker, from: "2026-09-01", to: "2026-10-20" });
    expect(all.opening).toBe("0.00");
    expect(all.advances).toBe("500.00");
    expect(all.closing).toBe("900.00");

    const pdf = await renderLabourInvoicePdf(inv, "Org A", "Owner A");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("is for finance managers on the site, for the organization's own workers", async () => {
    await expect(labourInvoice(w.a.eng1, { siteId: w.site1, workerId: worker, from: "2026-10-01", to: "2026-10-20" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(labourInvoice(w.b.owner, { siteId: site, workerId: worker, from: "2026-10-01", to: "2026-10-20" })).rejects.toBeInstanceOf(NotFoundError);
    const other = (await createWorker(w.b.owner, { name: "Other Org Worker" })).id;
    await expect(labourInvoice(w.a.owner, { siteId: site, workerId: other, from: "2026-10-01", to: "2026-10-20" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(labourInvoice(w.a.owner, { siteId: site, workerId: worker, from: "2026-10-01", to: "2026-10-21" })).rejects.toBeInstanceOf(ValidationError);
    await expect(labourInvoice(w.a.owner, { siteId: site, workerId: worker, from: "2026-10-10", to: "2026-10-01" })).rejects.toThrow();
  });
});

describe("amount in words", () => {
  it("uses lakhs and crores", () => {
    expect(amountInWords("0")).toBe("Rupees Zero Only");
    expect(amountInWords("2774.18")).toBe("Rupees Two Thousand Seven Hundred Seventy Four and Eighteen Paise Only");
    expect(amountInWords("125000")).toBe("Rupees One Lakh Twenty Five Thousand Only");
    expect(amountInWords("23456789.05")).toBe("Rupees Two Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine and Five Paise Only");
  });
});
