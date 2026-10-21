import ExcelJS from "exceljs";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { db } from "@/db";
import { createBill, recordPayment } from "@/server/data/bills";
import { upsertBudget } from "@/server/data/budgets";
import { createExpense } from "@/server/data/expenses";
import { createWorker, recordAttendance, recordLabourPayment } from "@/server/data/labour";
import { createMaterial, recordPurchase } from "@/server/data/materials";
import { createSite } from "@/server/data/sites";
import { getReport, reportRows } from "@/server/data/reports";
import { createSupplier } from "@/server/data/suppliers";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { buildReport, MAX_ROWS, STATEMENT_NOTE, type Report, type Section } from "@/server/reports/build";
import { renderPdf } from "@/server/reports/pdf";
import { cleanText, safeSheetText } from "@/server/reports/safe";
import { renderXlsx } from "@/server/reports/xlsx";
import { expense, world } from "./fixtures";

/**
 * Sample records (APP_TODAY 2026-10-20). Site 1 and site 2 have known amounts; every
 * total checked below is summed by hand from these.
 *
 * Site 1: 10-05 transport 2500 "=HYPERLINK(...)" (cash) · 10-10 other 1200 "@SUM(A1)" (UPI)
 *         10-12 cement purchase 20 × 400 = 8000 (UPI) from Sri Balaji (GSTIN recorded)
 *         10-01 credit purchase 30 × 500 = 15000 from Kerala Steels (no GSTIN), 6000 paid 10-15, 4000 paid 10-25 (after period)…
 *         attendance അനു 10-14 present (900), 10-15 half (450); wages paid 900 on 10-16
 * Site 2: 10-08 transport 4000 (bank) · bill KS-2 2500 dated 10-02, 500 paid in cash on 10-20
 * Totals for 10-01..10-20: site 1 18600, site 2 4500, all 23100.
 */
let w: Awaited<ReturnType<typeof world>>;
const period = { from: "2026-10-01", to: "2026-10-20" };
const report = (actor = w.a.owner, over: Record<string, unknown> = {}) => buildReport(actor, { kind: "expenses", format: "xlsx", ...period, ...over });

beforeAll(async () => {
  w = await world();
  const s1 = w.site1;
  await createExpense(w.a.owner, expense(s1, { expenseDate: "2026-10-05", categoryCode: "transport", description: "=HYPERLINK(\"http://evil\",\"x\")", items: [{ description: "Lorry", unitPrice: "2500" }] }));
  await createExpense(w.a.owner, expense(s1, { expenseDate: "2026-10-10", categoryCode: "other", paymentMethod: "upi", description: "@SUM(A1) ‮evil", items: [{ description: "Tea", unitPrice: "1200" }] }));
  await createExpense(w.a.owner, expense(w.site2, { expenseDate: "2026-10-08", categoryCode: "transport", paymentMethod: "bank", description: "Pune lorry", items: [{ description: "Lorry", unitPrice: "4000" }] }));

  await createSupplier(w.a.owner, { name: "Sri Balaji", gstin: "32ABCDE1234F1Z5" });
  const cement = await createMaterial(w.a.owner, { name: "Cement", unit: "bags" });
  await recordPurchase(w.a.owner, { siteId: s1, supplierName: "Sri Balaji", invoiceNumber: "SB-77", deliveryRef: "DC-1", purchaseDate: "2026-10-12", paymentMethod: "upi", items: [{ materialId: cement.id, quantity: "20", unitPrice: "400" }] });
  const credit = await recordPurchase(w.a.owner, { siteId: s1, supplierName: "Kerala Steels", invoiceNumber: "KS-1", purchaseDate: "2026-10-01", dueDate: "2026-10-10", paymentMethod: "credit", items: [{ materialId: cement.id, quantity: "30", unitPrice: "500" }] });
  await recordPayment(w.a.owner, { billId: credit.bill!.id, amount: "6000", paidOn: "2026-10-15", method: "bank", reference: "UTR-1" });

  const anu = await createWorker(w.a.owner, { name: "അനു", dailyWage: "900" });
  await recordAttendance(w.a.owner, { siteId: s1, workerId: anu.id, workDate: "2026-10-14", status: "present", workType: "Mason" });
  await recordAttendance(w.a.owner, { siteId: s1, workerId: anu.id, workDate: "2026-10-15", status: "half_day" });
  await recordLabourPayment(w.a.owner, { siteId: s1, workerId: anu.id, kind: "wage", amount: "900", paidOn: "2026-10-16", method: "cash" });

  const ks2 = await createBill(w.a.owner, { siteId: w.site2, supplierName: "Kerala Steels", billNumber: "KS-2", billDate: "2026-10-02", dueDate: "2026-10-30", amount: "2500" });
  await recordPayment(w.a.owner, { billId: ks2.id, amount: "500", paidOn: "2026-10-20", method: "cash" });

  await upsertBudget(w.a.owner, { siteId: s1, categoryCode: "materials", amount: "20000", alertPercent: 70 });
}, 600_000); // many sequential round trips to the remote test database

const section = (r: Report, title: string) => r.sections.find((s) => s.title.startsWith(title))!;
const allRows = (s: Section) => s.groups.flatMap((g) => g.rows);

describe("authorization", () => {
  it("is for owners and accountants, on sites they can export", async () => {
    await expect(report(w.a.eng1)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(report(w.a.viewer, { siteId: w.site1 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(report(w.a.eng2, { siteId: w.site1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(report(w.b.owner, { siteId: w.site1 })).rejects.toBeInstanceOf(NotFoundError);
    expect((await report(w.a.accountant, { siteId: w.site1 })).consolidated).toBe(false);
  });

  it("consolidates only the sites each user may export", async () => {
    const owner = await report();
    expect([owner.consolidated, owner.sites.map((s) => s.name).sort()]).toEqual([true, ["Site One", "Site Two"]]);
    // The accountant is only on site 1: a consolidated report is site 1 alone, with none of site 2's money.
    const acct = await report(w.a.accountant);
    expect(acct.sites.map((s) => s.name)).toEqual(["Site One"]);
    expect(section(acct, "Expenses").total?.amount).toBe("18600.00");
  });

  it("validates the period on the server", async () => {
    await expect(report(w.a.owner, { from: "2026-10-20", to: "2026-10-01" })).rejects.toBeInstanceOf(ZodError);
    await expect(report(w.a.owner, { to: "2026-10-21" })).rejects.toBeInstanceOf(ValidationError);
    await expect(report(w.a.owner, { kind: "everything" })).rejects.toBeInstanceOf(ZodError);
  });
});

describe("report contents match the sample records", () => {
  it("expenses: line items, per-site subtotals and a total", async () => {
    const r = await report();
    const s = section(r, "Expenses");
    // Site 1: 2500 + 1200 + 8000 (cement) + 6000 (bill payment) + 900 (wages) = 18600 · Site 2: 4000 + 500 (bill payment).
    expect(s.groups.map((g) => [g.label, g.rows.length, g.subtotal?.amount])).toEqual([
      ["Site One", 5, "18600.00"],
      ["Site Two", 2, "4500.00"],
    ]);
    expect(s.total?.amount).toBe("23100.00");
    expect(r.notes).toEqual([STATEMENT_NOTE]);
    expect(r.period).toEqual({ ...period, days: 20 });
  });

  it("categories: ranked with shares that add up", async () => {
    const s = section(await buildReport(w.a.owner, { kind: "categories", format: "pdf", ...period }), "Category totals, all sites");
    expect(allRows(s).map((r) => [r.category, r.amount, r.share])).toEqual([
      ["Materials", "14500.00", "62.8"], // 8000 + 6000 + 500 (bill payments are materials bills)
      ["Transport", "6500.00", "28.1"],
      ["Other", "1200.00", "5.2"],
      ["Labour", "900.00", "3.9"],
    ]);
  });

  it("purchases: GSTIN only where recorded, credit marked, no tax invented", async () => {
    const r = await buildReport(w.a.owner, { kind: "purchases", format: "xlsx", ...period });
    const s = section(r, "Material purchases");
    expect(allRows(s).map((x) => [x.supplier, x.gstin, x.invoice, x.qty, x.amount, x.payment])).toEqual([
      ["Kerala Steels", "Not recorded", "KS-1", "30", "15000.00", "Credit, bill KS-1"],
      ["Sri Balaji", "32ABCDE1234F1Z5", "SB-77", "20", "8000.00", "UPI"],
    ]);
    expect(s.total?.amount).toBe("23000.00");
    const labels = r.sections.flatMap((x) => x.columns.map((c) => c.label.toLowerCase()));
    expect(labels.some((l) => /cgst|sgst|igst|gst amount|tax amount|taxable/.test(l))).toBe(false);
  });

  it("labour: attendance, earned, paid and closing balance", async () => {
    const r = await buildReport(w.a.owner, { kind: "labour", format: "xlsx", ...period });
    const wages = section(r, "Wages by worker");
    expect(allRows(wages).map((x) => [x.worker, x.present, x.half, x.days, x.earned, x.wages, x.balance])).toEqual([["അനു", 1, 1, "1.5", "1350.00", "900.00", "450.00"]]);
    expect(section(r, "Attendance").total?.wage).toBe("1350.00");
    // The balance at an earlier period end only counts what had happened by then.
    const early = await buildReport(w.a.owner, { kind: "labour", format: "xlsx", from: "2026-10-01", to: "2026-10-14" });
    expect(allRows(section(early, "Wages by worker"))[0]).toMatchObject({ earned: "900.00", wages: "0.00", balance: "900.00" });
  });

  it("suppliers: balances as at the period end", async () => {
    // Payments after the period end (6000 on 10-15, 500 on 10-20) must not reduce the balances shown for it.
    const oct10 = await buildReport(w.a.owner, { kind: "suppliers", format: "pdf", from: "2026-10-01", to: "2026-10-10" });
    const s = section(oct10, "Supplier bills");
    expect(allRows(s).map((x) => [x.bill_number, x.amount, x.paid, x.outstanding])).toEqual([
      ["KS-1", "15000.00", "0.00", "15000.00"],
      ["KS-2", "2500.00", "0.00", "2500.00"],
    ]);
    const now = await buildReport(w.a.owner, { kind: "suppliers", format: "pdf", ...period });
    expect(section(now, "Supplier bills").total).toMatchObject({ amount: "17500.00", paid: "6500.00", outstanding: "11000.00" });
    expect(section(now, "Payments to suppliers").total?.amount).toBe("6500.00");
  });

  it("budget versus actual: each line and unbudgeted spending", async () => {
    const r = await buildReport(w.a.owner, { kind: "budget", format: "xlsx", ...period, siteId: w.site1 });
    const rows = allRows(section(r, "Budget versus actual"));
    expect(rows.map((x) => [x.line, x.budget, x.to_date, x.remaining, x.used, x.status])).toEqual([
      ["Total budget", "100000.00", "18600.00", "81400.00", "18.6", "Within budget"],
      ["Materials", "20000.00", "14000.00", "6000.00", "70.0", "Past 70% alert"],
      ["Labour", null, "900.00", null, null, "No budget line"],
      ["Transport", null, "2500.00", null, null, "No budget line"],
      ["Other", null, "1200.00", null, null, "No budget line"],
    ]);
  });

  it("payment history: by method, and by type adding up to the total", async () => {
    const r = await buildReport(w.a.owner, { kind: "payments", format: "xlsx", ...period });
    const s = section(r, "Payments");
    expect(s.groups.map((g) => [g.label, g.subtotal?.amount])).toEqual([
      ["Cash", "3900.00"], // lorry 2500 + wages 900 + KS-2 payment 500
      ["UPI", "9200.00"], // tea 1200 + cement 8000
      ["Bank transfer", "10000.00"], // site 2 lorry 4000 + KS-1 payment 6000
    ]);
    const byType = allRows(section(r, "Payments by type"));
    expect(byType.reduce((t, x) => t + Number(x.amount), 0)).toBe(Number(s.total?.amount));
    // The bill payment's reference (UTR) comes from the payment record.
    expect(allRows(s).find((x) => x.kind === "Supplier bill payment" && x.amount === "6000.00")?.reference).toBe("UTR-1");
  });
});

describe("filters", () => {
  it("apply category, supplier, worker and payment method", async () => {
    expect(section(await report(w.a.owner, { categoryCode: "transport" }), "Expenses").total?.amount).toBe("6500.00");
    expect(section(await report(w.a.owner, { paymentMethod: "upi" }), "Expenses").total?.amount).toBe("9200.00");
    expect(section(await report(w.a.owner, { supplierName: "Sri Balaji" }), "Expenses").total?.amount).toBe("8000.00");
    expect(section(await report(w.a.owner, { workerName: "അനു" }), "Expenses").total?.amount).toBe("900.00");
    expect(section(await report(w.a.owner, { siteId: w.site2 }), "Expenses").total?.amount).toBe("4500.00");
  });

  it("give the same total on screen, in the CSV rows and in the PDF/Excel report", async () => {
    const cases: Record<string, unknown>[] = [
      {},
      { categoryCode: "transport" },
      { paymentMethod: "upi" },
      { supplierName: "Sri Balaji" },
      { workerName: "അനു" },
      { siteId: w.site2 },
      { siteId: w.site1, categoryCode: "materials" },
    ];
    for (const filters of cases) {
      const screen = await getReport(w.a.owner, { ...period, ...filters });
      let csv = 0;
      for await (const e of reportRows(w.a.owner, { ...period, ...filters })) csv += Math.round(e.amount * 100);
      const file = section(await report(w.a.owner, filters), "Expenses").total?.amount ?? "0.00";
      expect({ filters, screen: screen.summary.total.toFixed(2), csv: (csv / 100).toFixed(2) }).toEqual({ filters, screen: file, csv: file });
    }
  });

  it("list filters that don't apply instead of silently using them", async () => {
    const r = await buildReport(w.a.owner, { kind: "purchases", format: "pdf", ...period, workerName: "അനു", supplierName: "Sri Balaji" });
    expect(r.filters).toEqual(["Supplier: Sri Balaji"]);
    expect(r.ignored).toEqual(["Worker: അനു"]);
  });
});

describe("files", () => {
  it("Excel: numbers as numbers in rupee format, totals present, formulas impossible", async () => {
    const buf = await renderXlsx(await report());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as never);
    expect(wb.worksheets.map((s) => s.name)).toEqual(["Summary", "Expenses", "By category, per site", "By category, all sites, highest"]);
    const ws = wb.getWorksheet("Expenses")!;
    const cells: ExcelJS.Cell[] = [];
    ws.eachRow((row) => row.eachCell((c) => cells.push(c)));
    expect(cells.some((c) => c.type === ExcelJS.ValueType.Formula || c.formula)).toBe(false);
    const texts = cells.filter((c) => typeof c.value === "string").map((c) => c.value as string);
    expect(texts).toContain(`'=HYPERLINK("http://evil","x")`);
    expect(texts.some((t) => t.startsWith("'@SUM(A1)") && !t.includes("‮"))).toBe(true);
    const amounts = cells.filter((c) => typeof c.value === "number" && String(c.numFmt).includes("₹")).map((c) => c.value);
    expect(amounts).toContain(23100);
    expect(texts.some((t) => t.includes("not a tax invoice"))).toBe(true);
  });

  it("PDF: a valid document with the statement notice and page numbers", async () => {
    const buf = await renderPdf(await buildReport(w.a.owner, { kind: "labour", format: "pdf", ...period }));
    const raw = buf.toString("latin1");
    expect(raw.startsWith("%PDF-")).toBe(true);
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(raw).toContain("Not a tax invoice");
    // Fonts are embedded (subsets), never the standard 14 that lack ₹ and Malayalam.
    expect(raw).toMatch(/FontFile2|FontFile3/);
  });

  it("render empty periods without failing", async () => {
    for (const kind of ["expenses", "categories", "purchases", "labour", "suppliers", "budget", "payments"]) {
      const r = await buildReport(w.a.owner, { kind, format: "pdf", from: "2025-01-01", to: "2025-01-31", siteId: w.site2 });
      if (kind !== "budget" && kind !== "suppliers") expect(r.sections.every((s) => s.groups.length === 0)).toBe(true);
      expect((await renderPdf(r)).subarray(0, 5).toString()).toBe("%PDF-");
      expect((await renderXlsx(r)).byteLength).toBeGreaterThan(1000);
    }
    const empty = await report(w.a.owner, { from: "2025-01-01", to: "2025-01-31" });
    expect(section(empty, "Expenses").total?.amount).toBe("0.00");
  });
});

describe("large reports", () => {
  let big: string;
  beforeAll(async () => {
    big = (await createSite(w.a.owner, { name: "Big Site", location: "Thrissur", budget: "99999999", startDate: "2026-01-01" })).site.id;
    // 3,000 expenses of ₹1 to ₹3,000 in one statement: total 3000 × 3001 / 2 = 4,501,500.
    await db.execute(sql`
      insert into expenses (site_id, category_id, expense_date, description, total_amount, payment_method, source, created_by, submitted_at, reviewed_by, reviewed_at)
      select ${big}, (select id from expense_categories where organization_id = ${w.a.owner.orgId} and code = 'other'),
             date '2026-10-01' + (g % 20), 'Bulk item ' || g, g, 'cash', 'import', ${w.a.owner.userId}, now(), ${w.a.owner.userId}, now()
      from generate_series(1, 3000) g
    `);
  }, 600_000);

  it("keep every row and the exact total, across many PDF pages", async () => {
    const r = await report(w.a.owner, { siteId: big });
    const s = section(r, "Expenses");
    expect(allRows(s)).toHaveLength(3000);
    expect(s.total?.amount).toBe("4501500.00");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await renderXlsx(r)) as never);
    expect(wb.getWorksheet("Expenses")!.rowCount).toBeGreaterThan(3000);
    const pdf = (await renderPdf(r)).toString("latin1");
    expect((pdf.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(50);
  });

  it("are refused past the row limit instead of producing an unusable file", async () => {
    await db.execute(sql`
      insert into expenses (site_id, category_id, expense_date, description, total_amount, payment_method, source, created_by, submitted_at, reviewed_by, reviewed_at)
      select ${big}, (select id from expense_categories where organization_id = ${w.a.owner.orgId} and code = 'other'),
             date '2026-10-02', 'Overflow ' || g, 1, 'cash', 'import', ${w.a.owner.userId}, now(), ${w.a.owner.userId}, now()
      from generate_series(1, ${MAX_ROWS}) g
    `);
    await expect(report(w.a.owner, { siteId: big })).rejects.toBeInstanceOf(ValidationError);
    // Narrowing the period brings it back under the limit.
    expect(section(await report(w.a.owner, { siteId: big, from: "2026-10-03", to: "2026-10-03" }), "Expenses").groups[0].rows.length).toBe(150);
  });
});

describe("text safety", () => {
  it("neutralises formula starts and strips control and bidi characters", () => {
    for (const s of ["=1+1", "+1", "-1", "@A1", "\tx", "\rx", "＝1"]) expect(safeSheetText(s).startsWith("'")).toBe(true);
    expect(safeSheetText("Cement 20 bags")).toBe("Cement 20 bags");
    expect(cleanText("a\u0000b‮c\u0007d")).toBe("abcd");
    expect(cleanText("x".repeat(600)).length).toBe(500);
  });
});
