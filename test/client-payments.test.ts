import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  getReceipt,
  invoicePayments,
  listReceipts,
  markInvoicePaid,
  payableInvoices,
  projectCollections,
  recordClientPayment,
  refundClientPayment,
} from "@/server/data/client-payments";
import { cancelInvoice, createClientInvoice, getClientInvoice, invoiceTotals } from "@/server/data/invoices";
import { organizationProfile, updateOrganizationProfile } from "@/server/data/organizations";
import { createSite, getSite } from "@/server/data/sites";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { renderClientInvoicePdf, renderReceiptPdf } from "@/server/reports/invoice-pdf";
import type { ClientReceipt } from "@/lib/types";
import { world } from "./fixtures";

let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => {
  w = await world();
});

/** A ₹15,00,000 interior project billed as one invoice, on a fresh site. */
async function project(name: string, over: Record<string, unknown> = {}) {
  const { site } = await createSite(w.a.owner, { name, location: "Kochi", budget: "1500000", startDate: "2026-01-01" });
  const inv = await createClientInvoice(w.a.owner, {
    siteId: site.id,
    invoiceDate: "2026-08-01",
    dueDate: "2026-12-31",
    clientName: "Mr. Thomas Varghese",
    clientPhone: "+91 94470 55555",
    clientEmail: "Thomas@Example.com",
    items: [
      { description: "Interior design and execution", quantity: "1", unit: "lot", unitPrice: "900000" },
      { description: "Modular wardrobes", quantity: "3", unit: "nos", unitPrice: "200000" },
    ],
    ...over,
  });
  return { siteId: site.id, inv };
}

const pay = (invoiceId: string, amount: string, over: Record<string, unknown> = {}) =>
  recordClientPayment(w.a.owner, { invoiceId, amount, paidOn: "2026-10-01", method: "bank", clientKey: crypto.randomUUID(), ...over });

describe("client payments", () => {
  // One ₹15,00,000 project taken from advance to final payment. Each step is its own test
  // (they run in order and build on each other) so each gets the full timeout against the
  // remote test database.
  describe("from advance to final payment, each with its own receipt and balance", () => {
    let siteId: string;
    let inv: Awaited<ReturnType<typeof project>>["inv"];
    const r: Record<"a" | "b" | "c" | "d", ClientReceipt> = {} as never;
    beforeAll(async () => {
      ({ siteId, inv } = await project("Varghese Villa"));
    });

    it("starts with the whole total to receive", () => {
      expect(inv.total).toBe(1500000);
      expect(inv.clientEmail).toBe("thomas@example.com");
      expect([inv.paid, inv.balance, inv.status]).toEqual([0, 1500000, "unpaid"]);
    });

    it("A: an initial advance", async () => {
      r.a = await pay(inv.id, "500000", { paidOn: "2026-08-02", reference: "UTR 4528", notes: "Advance on signing" });
      expect(r.a).toMatchObject({ stage: "advance", amount: 500000, paidBefore: 0, paidToDate: 500000, balanceAfter: 1000000, invoiceTotal: 1500000, reference: "UTR 4528" });
      expect(r.a.receiptNo).toMatch(/^RCT\/2026-27\/\d{4}$/);
    });

    it("B: a part payment", async () => {
      r.b = await pay(inv.id, "200000", { paidOn: "2026-09-10", method: "cheque" });
      expect(r.b).toMatchObject({ stage: "part", paidBefore: 500000, paidToDate: 700000, balanceAfter: 800000 });
    });

    it("C/E: any further installment, with paise, and never more than the balance", async () => {
      r.c = await pay(inv.id, "123456.78", { method: "upi" });
      expect(r.c).toMatchObject({ stage: "part", paidBefore: 700000, paidToDate: 823456.78, balanceAfter: 676543.22 });
      expect(new Set([r.a.receiptNo, r.b.receiptNo, r.c.receiptNo]).size).toBe(3);
      expect((await getClientInvoice(w.a.owner, inv.id)).status).toBe("unpaid");
      await expect(pay(inv.id, "676543.23")).rejects.toBeInstanceOf(ValidationError);
    });

    it("D: the final payment clears it, and only then is the invoice paid", async () => {
      r.d = await pay(inv.id, "676543.22");
      expect(r.d).toMatchObject({ stage: "final", paidToDate: 1500000, balanceAfter: 0 });
      const paid = await getClientInvoice(w.a.owner, inv.id);
      expect([paid.status, paid.paid, paid.balance, paid.receipts]).toEqual(["paid", 1500000, 0, 4]);
      await expect(pay(inv.id, "1")).rejects.toThrow(/already paid in full/);
    });

    it("keeps each receipt as the invoice stood then, and never counts as spend", async () => {
      const { entries } = await invoicePayments(w.a.owner, inv.id);
      expect(entries.map((e) => [e.stage, e.balanceAfter])).toEqual([["advance", 1000000], ["part", 800000], ["part", 676543.22], ["final", 0]]);
      const again = await getReceipt(w.a.owner, r.b.id);
      expect(again.receipt).toMatchObject({ paidBefore: 500000, paidToDate: 700000, balanceAfter: 800000 });
      expect(again.history.map((e) => e.id)).toEqual([r.a.id, r.b.id]);
      expect((await getSite(w.a.owner, siteId)).summary.spent).toBe(0);
    });
  });

  it("returns the same receipt for a repeated submission, and never makes one by reading", async () => {
    const { inv } = await project("Idempotent Site");
    const clientKey = crypto.randomUUID();
    const [one, two] = await Promise.all([pay(inv.id, "1000", { clientKey }), pay(inv.id, "1000", { clientKey })]);
    expect(two.id).toBe(one.id);
    expect((await pay(inv.id, "1000", { clientKey })).id).toBe(one.id);
    await getReceipt(w.a.owner, one.id);
    await getReceipt(w.a.owner, one.id);
    const { entries } = await invoicePayments(w.a.owner, inv.id);
    expect(entries).toHaveLength(1);
    expect((await getClientInvoice(w.a.owner, inv.id)).paid).toBe(1000);
  });

  it("numbers receipts without gaps or clashes when payments arrive together", async () => {
    const { inv } = await project("Concurrent Site");
    const receipts = await Promise.all(Array.from({ length: 5 }, () => pay(inv.id, "100")));
    const nums = receipts.map((r) => Number(r.receiptNo.split("/")[2])).sort((x, y) => x - y);
    expect(new Set(nums).size).toBe(5);
    expect(nums[4] - nums[0]).toBe(4);
    expect((await getClientInvoice(w.a.owner, inv.id)).paid).toBe(500);
  });

  it("refunds and reversals are linked records; the original receipt stays", async () => {
    const { inv } = await project("Refund Site");
    await pay(inv.id, "500000");
    const b = await pay(inv.id, "200000", { method: "cheque", reference: "Cheque 004512" });
    const refund = (paymentId: string, over: Record<string, unknown>) =>
      refundClientPayment(w.a.owner, { paymentId, paidOn: "2026-10-05", method: "bank", reason: "Scope reduced", clientKey: crypto.randomUUID(), ...over });

    // Scenario F: a bounced cheque is reversed in full.
    const rev = await refund(b.id, { kind: "reversal", reason: "Cheque bounced" });
    expect(rev).toMatchObject({ kind: "reversal", stage: "reversal", amount: 200000, paidBefore: 700000, paidToDate: 500000, balanceAfter: 1000000, related: { id: b.id, receiptNo: b.receiptNo } });
    expect(rev.receiptNo).toMatch(/^RFD\/2026-27\/\d{4}$/);
    await expect(refund(b.id, { kind: "reversal" })).rejects.toBeInstanceOf(ValidationError);
    await expect(refund(b.id, { kind: "refund", amount: "1" })).rejects.toThrow(/given back in full/);
    await expect(refund(rev.id, { kind: "refund", amount: "1" })).rejects.toBeInstanceOf(ValidationError);

    const { entries } = await invoicePayments(w.a.owner, inv.id);
    expect(entries.find((e) => e.id === b.id)).toMatchObject({ amount: 200000, reversed: true, refunded: 200000, balanceAfter: 800000 });
    const after = await getClientInvoice(w.a.owner, inv.id);
    expect([after.paid, after.balance]).toEqual([500000, 1000000]);
  });

  describe("a partial refund", () => {
    let inv: Awaited<ReturnType<typeof project>>["inv"];
    let a: ClientReceipt;
    const refund = (paymentId: string, over: Record<string, unknown>) =>
      refundClientPayment(w.a.owner, { paymentId, paidOn: "2026-10-05", method: "bank", reason: "Scope reduced", clientKey: crypto.randomUUID(), ...over });
    beforeAll(async () => {
      ({ inv } = await project("Partial Refund Site"));
      a = await pay(inv.id, "500000");
    });

    it("gives back part of a payment as a linked record", async () => {
      const r1 = await refund(a.id, { kind: "refund", amount: "50000" });
      expect(r1).toMatchObject({ stage: "refund", paidBefore: 500000, paidToDate: 450000, balanceAfter: 1050000, related: { id: a.id } });
      const { entries } = await invoicePayments(w.a.owner, inv.id);
      expect(entries).toHaveLength(2);
      expect(entries.find((e) => e.id === a.id)).toMatchObject({ amount: 500000, refunded: 50000, reversed: false, balanceAfter: 1000000 });
      const after = await getClientInvoice(w.a.owner, inv.id);
      expect([after.paid, after.balance]).toEqual([450000, 1050000]);
    });

    it("never gives back more than what's left, or reverses a part-refunded payment", async () => {
      await expect(refund(a.id, { kind: "refund", amount: "450000.01" })).rejects.toBeInstanceOf(ValidationError);
      await expect(refund(a.id, { kind: "reversal" })).rejects.toThrow(/already refunded/);
    });

    it("needs a date on or after the payment, a reason, and finance on the site", async () => {
      await expect(refund(a.id, { kind: "refund", amount: "10", paidOn: "2026-09-01" })).rejects.toBeInstanceOf(ValidationError);
      await expect(refund(a.id, { kind: "refund", amount: "10", reason: " " })).rejects.toThrow();
      // The accountant has no role on this site, so the payment doesn't exist for them.
      await expect(
        refundClientPayment(w.a.accountant, { paymentId: a.id, kind: "refund", amount: "10", paidOn: "2026-10-05", reason: "x", clientKey: crypto.randomUUID() }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it("keeps the ledger append-only", async () => {
    const { inv } = await project("Immutable Site");
    const a = await pay(inv.id, "1000");
    await expect(db.execute(sql`update client_payments set amount = 1 where id = ${a.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from client_payments where id = ${a.id}`)).rejects.toThrow();
    expect((await getClientInvoice(w.a.owner, inv.id)).paid).toBe(1000);
    const audit = (await db.execute(sql`select action from audit_log where entity_id = ${a.id}`)) as unknown as { action: string }[];
    expect(audit.map((r) => r.action)).toEqual(["payment.receive"]);
  });

  it("still lets a site with payments be deleted (the ledger cascades)", async () => {
    const { siteId, inv } = await project("Cascade Site");
    await pay(inv.id, "1000");
    await db.execute(sql`delete from construction_sites where id = ${siteId}`);
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from client_payments where invoice_id = ${inv.id}`)) as unknown as { n: number }[];
    expect(n).toBe(0);
  });

  it("checks dates, cancelled invoices and who may record", async () => {
    const { inv } = await project("Rules Site");
    await expect(pay(inv.id, "100", { paidOn: "2026-10-21" })).rejects.toBeInstanceOf(ValidationError); // after APP_TODAY
    await expect(pay(inv.id, "100", { paidOn: "2026-07-31" })).rejects.toBeInstanceOf(ValidationError); // before the invoice
    await expect(pay(inv.id, "0")).rejects.toThrow();
    await expect(pay(inv.id, "100", { method: "credit" })).rejects.toThrow();
    await expect(recordClientPayment(w.b.owner, { invoiceId: inv.id, amount: "100", paidOn: "2026-10-01", clientKey: crypto.randomUUID() })).rejects.toBeInstanceOf(NotFoundError);

    const site1Invoice = await createClientInvoice(w.a.owner, {
      siteId: w.site1, invoiceDate: "2026-10-01", dueDate: "2026-10-30", clientName: "Client", items: [{ description: "Work", quantity: "1", unit: "lot", unitPrice: "1000" }],
    });
    await expect(recordClientPayment(w.a.eng1, { invoiceId: site1Invoice.id, amount: "100", paidOn: "2026-10-02", clientKey: crypto.randomUUID() })).rejects.toBeInstanceOf(ForbiddenError);
    const byAccountant = await recordClientPayment(w.a.accountant, { invoiceId: site1Invoice.id, amount: "100", paidOn: "2026-10-02", clientKey: crypto.randomUUID() });
    await expect(getReceipt(w.a.eng1, byAccountant.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getReceipt(w.b.owner, byAccountant.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      refundClientPayment(w.a.accountant, { paymentId: byAccountant.id, kind: "reversal", paidOn: "2026-10-02", reason: "Entered twice", clientKey: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listReceipts(w.a.eng1)).items).toHaveLength(0);

    // Money on an invoice blocks cancelling it until it's given back.
    await expect(cancelInvoice(w.a.siteOwner, { id: site1Invoice.id, reason: "Wrong client" })).rejects.toThrow(/Refund or reverse/);
    await refundClientPayment(w.a.siteOwner, { paymentId: byAccountant.id, kind: "reversal", paidOn: "2026-10-02", reason: "Entered twice", clientKey: crypto.randomUUID() });
    const cancelled = await cancelInvoice(w.a.siteOwner, { id: site1Invoice.id, reason: "Wrong client" });
    expect(cancelled.status).toBe("cancelled");
    await expect(pay(site1Invoice.id, "100")).rejects.toThrow(/cancelled/);
  });

  it("marks an invoice paid by receiving its whole balance", async () => {
    const { inv } = await project("Mark Paid Site");
    await pay(inv.id, "400000");
    const paid = await markInvoicePaid(w.a.owner, { id: inv.id, paidOn: "2026-10-10", method: "upi", reference: "UTR999" });
    expect([paid.status, paid.paid, paid.paidOn, paid.paidReference, paid.paidMethod]).toEqual(["paid", 1500000, "2026-10-10", "UTR999", "upi"]);
    const { entries } = await invoicePayments(w.a.owner, inv.id);
    expect(entries.at(-1)).toMatchObject({ amount: 1100000, stage: "final" });
  });

  it("filters the receipt list and totals collections per project", async () => {
    const { siteId, inv } = await project("Collections Site");
    const before = await invoiceTotals(w.a.owner);
    const a = await pay(inv.id, "500000", { paidOn: "2026-08-05" });
    await pay(inv.id, "200000", { paidOn: "2026-09-05" });
    await refundClientPayment(w.a.owner, { paymentId: a.id, kind: "refund", amount: "25000", paidOn: "2026-09-20", reason: "Discount agreed", clientKey: crypto.randomUUID() });

    const mine = (await listReceipts(w.a.owner, { siteId })).items;
    expect(mine.map((r) => r.stage)).toEqual(["refund", "part", "advance"]);
    expect((await listReceipts(w.a.owner, { siteId, stage: "advance" })).items.map((r) => r.id)).toEqual([a.id]);
    expect((await listReceipts(w.a.owner, { siteId, from: "2026-09-01", to: "2026-09-10" })).items).toHaveLength(1);
    expect((await listReceipts(w.a.owner, { siteId, q: a.receiptNo })).items.map((r) => r.id)).toEqual([a.id]);
    expect((await listReceipts(w.a.owner, { q: "Collections Site" })).items).toHaveLength(3);
    const page1 = await listReceipts(w.a.owner, { siteId, limit: 2 });
    const page2 = await listReceipts(w.a.owner, { siteId, limit: 2, cursor: page1.nextCursor! });
    expect([...page1.items, ...page2.items].map((r) => r.id)).toEqual(mine.map((r) => r.id));

    const { projects, total } = await projectCollections(w.a.owner);
    const p = projects.find((x) => x.siteId === siteId)!;
    expect(p).toMatchObject({ value: 1500000, collected: 700000, refunded: 25000, outstanding: 825000, invoices: 1, receipts: 2 });
    expect(total.outstanding).toBeCloseTo(total.value - (total.collected - total.refunded), 2);

    const after = await invoiceTotals(w.a.owner);
    expect(after.outstanding - before.outstanding).toBeCloseTo(-675000, 2);
    expect(after.received - before.received).toBeCloseTo(675000, 2);
    expect((await payableInvoices(w.a.owner)).find((i) => i.id === inv.id)).toMatchObject({ balance: 825000, paid: 675000 });
  });

  it("prints company details, and renders receipts and invoices", async () => {
    await expect(updateOrganizationProfile(w.a.accountant, { phone: "1" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateOrganizationProfile(w.a.owner, { email: "nope" })).rejects.toThrow();
    await updateOrganizationProfile(w.a.owner, { address: "Kakkanad, Kochi", phone: "+91 98470 12345", email: "Accounts@Arcadia.in", website: "" });
    const org = await organizationProfile(w.a.owner);
    expect(org).toMatchObject({ address: "Kakkanad, Kochi", email: "accounts@arcadia.in", website: "" });

    const { inv } = await project("PDF Site", { clientName: "ശ്രീ തോമസ്" });
    const a = await pay(inv.id, "500000");
    const doc = await getReceipt(w.a.owner, a.id);
    expect(doc.organization.phone).toBe("+91 98470 12345");
    expect((await renderReceiptPdf(doc, "Owner A")).subarray(0, 5).toString()).toBe("%PDF-");
    const { invoice, entries } = await invoicePayments(w.a.owner, inv.id);
    expect((await renderClientInvoicePdf(invoice, org, entries)).subarray(0, 5).toString()).toBe("%PDF-");
  });
});
