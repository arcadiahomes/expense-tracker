import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import type { ClientInvoice, ClientReceipt, LabourInvoice, OrganizationProfile, PaymentMode, ReceiptStage } from "@/lib/types";
import { today } from "../data/shared";
import { loadFonts } from "./pdf";
import { cleanText } from "./safe";

/**
 * Invoices and receipts → PDF (A4 portrait). Like the reports, every amount shown was
 * computed in SQL, user text is cleaned of control and bidi characters, and pdfkit writes
 * it as glyphs in embedded fonts (Carlito, Rachana for Malayalam). The first page carries
 * the Arcadia Home mark and the company's details, every page the brand bands and a
 * footer; blocks that don't fit move to a new page whole, and tables repeat their header,
 * so nothing is cut off when printed.
 */

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const date = (iso: string) => `${iso.slice(8)} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const money = (v: string | number) => inr.format(Number(v));

const MALAYALAM = /[ഀ-ൿ]/;
const INK = "#14201a";
const MUTED = "#55645b";
const BRAND = "#14532d";
const ACCENT = "#2f8f4e";
const TINT = "#eef6f0";
const ZEBRA = "#f7fbf8";
const LINE = "#d3e2d8";
const RED = "#b42318";
const AMBER = "#9a6700";

const LOGO = path.join(process.cwd(), "src/assets/arcadia-mark.png");
let logo: Buffer | null = null;
const loadLogo = () => (logo ??= readFileSync(LOGO));

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function belowHundred(n: number) {
  return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
}

function belowThousand(n: number) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h && `${ONES[h]} Hundred`, rest && belowHundred(rest)].filter(Boolean).join(" ");
}

/** "₹1,25,000.50" → "Rupees One Lakh Twenty Five Thousand and Fifty Paise Only", in the Indian system. */
export function amountInWords(amount: string) {
  const [r, p = "0"] = Number(amount).toFixed(2).split(".");
  let rupees = Number(r);
  const paise = Number(p);
  const parts: string[] = [];
  for (const [size, name] of [[1_00_00_000, "Crore"], [1_00_000, "Lakh"], [1_000, "Thousand"]] as const) {
    const n = Math.floor(rupees / size);
    // Above 99 crore the crore count itself is read out in full.
    if (n) parts.push(`${size === 1_00_00_000 && n > 99 ? amountInWords(String(n)).replace(/^Rupees |\sOnly$/g, "") : belowHundred(n)} ${name}`);
    rupees %= size;
  }
  if (rupees) parts.push(belowThousand(rupees));
  const words = parts.join(" ") || "Zero";
  return `Rupees ${words}${paise ? ` and ${belowHundred(paise)} Paise` : ""} Only`;
}

type Col = { label: string; width: number; align?: "left" | "right" };
type Opts = PDFKit.Mixins.TextOptions & { bold?: boolean; size?: number; color?: string };
type Org = OrganizationProfile | string;

const profile = (org: Org): OrganizationProfile => (typeof org === "string" ? { name: org, address: "", phone: "", email: "", website: "" } : org);

/** An A4 portrait page set with the helpers every document draws with. */
function setup(title: string, org: OrganizationProfile) {
  const f = loadFonts();
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 40, bottom: 60, left: 44, right: 44 },
    bufferPages: true,
    info: { Title: cleanText(title, 200), Author: cleanText(org.name, 200), Creator: "Arcadia Home" },
  });
  doc.registerFont("latin", f.latin);
  doc.registerFont("latinBold", f.latinBold);
  doc.registerFont("ml", f.ml);
  doc.registerFont("mlBold", f.mlBold);
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const font = (s: string, bold?: boolean) => (MALAYALAM.test(s) ? (bold ? "mlBold" : "ml") : bold ? "latinBold" : "latin");
  const text = (s: string, x: number, y: number, opts: Opts = {}) => {
    const clean = cleanText(s, 2000);
    doc
      .font(font(clean, opts.bold))
      .fontSize(opts.size ?? 9.5)
      .fillColor(opts.color ?? INK);
    doc.text(clean, x, y, { lineBreak: true, ...opts });
    return doc.y;
  };
  const height = (s: string, w: number, opts: { bold?: boolean; size?: number } = {}) => {
    const clean = cleanText(s, 2000);
    doc.font(font(clean, opts.bold)).fontSize(opts.size ?? 9.5);
    return doc.heightOfString(clean || " ", { width: w });
  };
  const rule = (y: number, color = LINE, lineWidth = 0.6, x = left, w = width) => doc.moveTo(x, y).lineTo(x + w, y).lineWidth(lineWidth).strokeColor(color).stroke();

  /** The page header: green band, the mark, company name and details, and the document title. */
  const letterhead = (docTitle: string, number?: string) => {
    doc.rect(0, 0, doc.page.width, 6).fill(BRAND);
    doc.rect(0, 6, doc.page.width, 2).fill(ACCENT);
    const top = doc.page.margins.top;
    doc.image(loadLogo(), left, top, { fit: [50, 50] });
    const tx = left + 60;
    const tw = width * 0.58 - 60;
    let y = text(org.name, tx, top + 1, { size: 17, bold: true, color: BRAND, width: tw });
    const contact = [org.phone, org.email, org.website].filter(Boolean).join("  ·  ");
    if (org.address) y = text(org.address, tx, y + 1, { size: 8.5, color: MUTED, width: tw });
    if (contact) y = text(contact, tx, y + 1, { size: 8.5, color: MUTED, width: tw });
    const rx = left + width * 0.58;
    const rw = width * 0.42;
    let ry = text(docTitle.toUpperCase(), rx, top + 2, { size: 19, bold: true, color: INK, width: rw, align: "right", characterSpacing: 1.5 });
    if (number) ry = text(number, rx, ry + 1, { size: 10, bold: true, color: ACCENT, width: rw, align: "right" });
    y = Math.max(y, ry, top + 50) + 12;
    rule(y, BRAND, 1.2);
    return y + 12;
  };

  /** A tinted strip of label/value pairs (number, dates, status) under the letterhead. */
  const metaStrip = (y: number, cells: { label: string; value: string; color?: string }[]) => {
    const h = 40;
    doc.roundedRect(left, y, width, h, 6).fill(TINT);
    const cw = width / cells.length;
    cells.forEach((c, i) => {
      const x = left + cw * i + 12;
      text(c.label.toUpperCase(), x, y + 8, { size: 7, bold: true, color: MUTED, width: cw - 18, characterSpacing: 0.7, lineBreak: false });
      text(c.value, x, y + 19, { size: 10.5, bold: true, color: c.color ?? INK, width: cw - 18, lineBreak: false, ellipsis: true });
    });
    return y + h + 16;
  };

  /** A titled block of lines, e.g. "Bill to"; the first line is the name. Returns the y below it. */
  const block = (title: string, lines: (string | false | undefined)[], x: number, y: number, w: number) => {
    text(title.toUpperCase(), x, y, { size: 7.5, bold: true, color: ACCENT, width: w, characterSpacing: 0.8 });
    rule(y + 11, LINE, 0.6, x, w);
    let yy = y + 16;
    (lines.filter(Boolean) as string[]).forEach((l, i) => {
      yy = text(l, x, yy, { size: i === 0 ? 11 : 9, bold: i === 0, color: i === 0 ? INK : MUTED, width: w }) + 1.5;
    });
    return yy;
  };

  /** Starts a new page when `need` points won't fit below y. */
  const ensure = (y: number, need: number) => {
    if (y + need <= bottom()) return y;
    doc.addPage();
    return doc.page.margins.top;
  };

  /** A table that repeats its header on each new page. Returns the y below it. */
  const table = (y: number, cols: Col[], rows: string[][], empty: string) => {
    const total = cols.reduce((t, c) => t + c.width, 0);
    const widths = cols.map((c) => (c.width / total) * width);
    const xs = widths.map((_, i) => left + widths.slice(0, i).reduce((t, w) => t + w, 0));
    const pad = 6;
    const header = () => {
      const h = Math.max(...cols.map((c, i) => height(c.label, widths[i] - pad * 2, { bold: true, size: 8.5 }))) + pad * 2;
      doc.rect(left, y, width, h).fill(BRAND);
      cols.forEach((c, i) => text(c.label.toUpperCase(), xs[i] + pad, y + pad, { size: 8.5, bold: true, color: "#ffffff", width: widths[i] - pad * 2, align: c.align ?? "left", characterSpacing: 0.4 }));
      y += h;
    };
    y = ensure(y, 50);
    header();
    if (!rows.length) {
      text(empty, left + pad, y + 8, { size: 9, color: MUTED });
      return y + 28;
    }
    rows.forEach((row, r) => {
      const h = Math.max(...row.map((s, i) => height(s, widths[i] - pad * 2))) + pad * 2;
      if (y + h > bottom()) {
        doc.addPage();
        y = doc.page.margins.top;
        header();
      }
      if (r % 2 === 1) doc.rect(left, y, width, h).fill(ZEBRA);
      row.forEach((s, i) => text(s, xs[i] + pad, y + pad, { width: widths[i] - pad * 2, align: cols[i].align ?? "left" }));
      y += h;
      rule(y);
    });
    return y;
  };

  /**
   * Label/value lines in a box on the right. Lines marked `strong` are emphasised;
   * `highlight` gets a filled band (the grand total or balance). Returns the y below it.
   */
  const summary = (y: number, lines: { label: string; value: string; strong?: boolean; highlight?: string; color?: string }[], boxWidth = 250) => {
    const x = left + width - boxWidth;
    let yy = y + 6;
    for (const l of lines) {
      if (l.highlight) {
        doc.roundedRect(x, yy - 2, boxWidth, 24, 4).fill(l.highlight);
        text(l.label, x + 10, yy + 4, { size: 10.5, bold: true, color: "#ffffff", width: boxWidth / 2 });
        text(l.value, x + boxWidth / 2, yy + 4, { size: 10.5, bold: true, color: "#ffffff", width: boxWidth / 2 - 10, align: "right" });
        yy += 28;
      } else {
        text(l.label, x + 10, yy, { size: 9.5, bold: l.strong, color: l.strong ? INK : MUTED, width: boxWidth / 2 });
        text(l.value, x + boxWidth / 2, yy, { size: 9.5, bold: l.strong, color: l.color ?? INK, width: boxWidth / 2 - 10, align: "right" });
        yy += 17;
        if (l.strong) rule(yy - 4, LINE, 0.6, x, boxWidth);
      }
    }
    return yy;
  };

  /** Height `summary` will take, to keep it on one page. */
  const summaryHeight = (lines: { highlight?: string }[]) => 6 + lines.reduce((t, l) => t + (l.highlight ? 28 : 17), 0);

  /** A rounded status pill, e.g. PAID or PART PAYMENT. */
  const pill = (label: string, color: string, x: number, y: number) => {
    const clean = label.toUpperCase();
    doc.font("latinBold").fontSize(8.5);
    const w = doc.widthOfString(clean, { characterSpacing: 0.8 }) + 18;
    doc.save();
    doc.roundedRect(x, y, w, 18, 9).lineWidth(1.2).strokeColor(color).stroke();
    doc.restore();
    text(clean, x, y + 4.5, { size: 8.5, bold: true, color, width: w, align: "center", characterSpacing: 0.8, lineBreak: false });
    return w;
  };

  /** A boxed stamp beside the totals: PAID, CANCELLED. */
  const stamp = (label: string, color: string, x: number, y: number) => {
    doc.save();
    doc.roundedRect(x, y, 140, 36, 5).lineWidth(2).strokeColor(color).stroke();
    doc.restore();
    text(label, x, y + 9, { size: 15, bold: true, color, width: 140, align: "center", characterSpacing: 2.5 });
  };

  /** Signature lines at the end of the document. */
  const signatures = (y: number, leftLabel: string, rightLabel: string) => {
    y = ensure(y + 34, 50);
    const w = 180;
    rule(y, INK, 0.6, left, w);
    text(leftLabel, left, y + 5, { size: 8.5, color: MUTED, width: w });
    rule(y, INK, 0.6, left + width - w, w);
    text(rightLabel, left + width - w, y + 5, { size: 8.5, color: MUTED, width: w, align: "right" });
    text("Authorised signatory", left + width - w, y + 17, { size: 8.5, bold: true, color: INK, width: w, align: "right" });
    return y + 34;
  };

  /** Page footer: `label` on one line (cut short if it must be), then `note`, page numbers on the right. */
  const footer = (label: string, note = "Computer-generated document") => {
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const fy = doc.page.height - 38;
      const saved = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      rule(fy - 8);
      text(label, left, fy, { size: 7.5, color: MUTED, width: width - 90, height: 9, ellipsis: true });
      text(`Page ${i + 1} of ${range.count}`, left + width - 90, fy, { size: 7.5, color: MUTED, width: 90, align: "right", lineBreak: false });
      text(note, left, fy + 11, { size: 7, color: MUTED, width: width - 90, height: 9, ellipsis: true });
      doc.rect(0, doc.page.height - 6, doc.page.width, 6).fill(BRAND);
      doc.page.margins.bottom = saved;
    }
    doc.end();
    return done;
  };

  return { doc, left, width, bottom, text, height, rule, letterhead, metaStrip, block, ensure, table, summary, summaryHeight, pill, stamp, signatures, footer };
}

const METHOD: Record<PaymentMode, string> = { cash: "Cash", upi: "UPI", bank: "Bank transfer", cheque: "Cheque", credit: "Credit" };
const INVOICE_STATUS = {
  unpaid: { label: "Unpaid", color: AMBER },
  overdue: { label: "Overdue", color: RED },
  paid: { label: "Paid", color: ACCENT },
  cancelled: { label: "Cancelled", color: RED },
} as const;

/** The invoice with what's been received against it. `payments` are its ledger entries, oldest first. */
export async function renderClientInvoicePdf(inv: ClientInvoice, organization: Org, payments: ClientReceipt[] = []): Promise<Buffer> {
  const org = profile(organization);
  const p = setup(`Invoice ${inv.invoiceNo}`, org);
  const { left, width, text } = p;
  const partPaid = inv.status !== "paid" && inv.status !== "cancelled" && inv.paid > 0;
  const status = partPaid ? { label: inv.status === "overdue" ? "Part paid, overdue" : "Part paid", color: inv.status === "overdue" ? RED : AMBER } : INVOICE_STATUS[inv.status];
  let y = p.letterhead("Invoice", inv.invoiceNo);
  y = p.metaStrip(y, [
    { label: "Invoice date", value: date(inv.date) },
    { label: "Due date", value: date(inv.dueDate), color: inv.status === "overdue" ? RED : undefined },
    { label: "Amount due", value: money(Math.max(inv.balance, 0)) },
    { label: "Status", value: status.label, color: status.color },
  ]);

  const half = width / 2 - 12;
  const billTo = p.block(
    "Bill to",
    [inv.client, inv.clientAddress, inv.clientPhone && `Phone ${inv.clientPhone}`, inv.clientEmail, inv.clientGstin && `GSTIN ${inv.clientGstin}`],
    left,
    y,
    half,
  );
  const project = p.block("Project / site", [inv.siteName, `Project ID ${projectId(inv.siteId)}`], left + width / 2 + 12, y, half);
  y = Math.max(billTo, project) + 18;

  y = p.table(
    y,
    [
      { label: "#", width: 5 },
      { label: "Description", width: 41 },
      { label: "Qty", width: 10, align: "right" },
      { label: "Unit", width: 9 },
      { label: "Rate", width: 16, align: "right" },
      { label: "Amount", width: 19, align: "right" },
    ],
    inv.items.map((it, i) => [String(i + 1), it.description, qtyFmt.format(Number(it.quantity)), it.unit, money(it.unitPrice), money(it.amount)]),
    "No items.",
  );

  const lines = [
    { label: "Subtotal", value: money(inv.subtotal) },
    ...(inv.gstPercent > 0 ? [{ label: `GST @ ${inv.gstPercent}%`, value: money(inv.gst) }] : []),
    { label: "Total", value: money(inv.total), strong: true },
    { label: "Amount paid", value: money(inv.paid), color: ACCENT },
    { label: "Balance due", value: money(Math.max(inv.balance, 0)), highlight: inv.status === "cancelled" ? MUTED : inv.balance > 0 ? BRAND : ACCENT },
  ];
  y = p.ensure(y, p.summaryHeight(lines) + 40);
  const totalsTop = y;
  y = p.summary(y + 6, lines);
  if (inv.status === "paid") p.stamp("PAID", ACCENT, left, totalsTop + 18);
  if (inv.status === "cancelled") p.stamp("CANCELLED", RED, left, totalsTop + 18);

  y = p.ensure(y + 6, 40);
  text("AMOUNT IN WORDS", left, y, { size: 7.5, bold: true, color: ACCENT, characterSpacing: 0.8 });
  y = text(amountInWords(String(inv.total)), left, y + 11, { size: 9.5, width }) + 12;

  if (payments.length) {
    y = p.ensure(y + 4, 70);
    y = text("Payments received", left, y, { size: 11, bold: true, color: BRAND }) + 6;
    y = p.table(
      y,
      [
        { label: "Date", width: 16 },
        { label: "Receipt no.", width: 22 },
        { label: "Type", width: 18 },
        { label: "Method", width: 18 },
        { label: "Amount", width: 26, align: "right" },
      ],
      payments.map((e) => [date(e.date), e.receiptNo, STAGE_LABEL[e.stage], METHOD[e.method], e.kind === "payment" ? money(e.amount) : `− ${money(e.amount)}`]),
      "",
    );
    y += 10;
  }

  const extra: string[] = [];
  if (inv.status === "cancelled") extra.push(`Cancelled: ${inv.cancelReason ?? ""}`);
  if (inv.notes) extra.push(inv.notes);
  if (extra.length) {
    y = p.ensure(y + 4, 40);
    text("NOTES", left, y, { size: 7.5, bold: true, color: ACCENT, characterSpacing: 0.8 });
    y += 12;
    for (const line of extra) {
      y = p.ensure(y, 30);
      y = text(line, left, y, { size: 9.5, color: MUTED, width }) + 6;
    }
  }
  p.signatures(y, "Client's acknowledgement", `For ${org.name}`);
  return p.footer(`${org.name} · Invoice ${inv.invoiceNo} · ${inv.client} · Thank you for your business`);
}

/** A short, stable reference for a site, printed as its project ID. */
const projectId = (siteId: string) => `PRJ-${siteId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;

export const STAGE_LABEL: Record<ReceiptStage, string> = {
  advance: "Advance Payment",
  part: "Part Payment",
  final: "Final Payment",
  refund: "Refund",
  reversal: "Payment Reversal",
};

const STAGE_COLOR: Record<ReceiptStage, string> = { advance: BRAND, part: AMBER, final: ACCENT, refund: RED, reversal: RED };

/**
 * One receipt: a payment (advance, part or final), or a refund or reversal of one. The
 * figures are the invoice as it stood when the entry was recorded; `history` is the
 * invoice's ledger up to and including it.
 */
export async function renderReceiptPdf(
  doc: { receipt: ClientReceipt; history: ClientReceipt[]; invoice: ClientInvoice; organization: OrganizationProfile },
  preparedBy?: string,
): Promise<Buffer> {
  const { receipt: r, history, invoice: inv, organization: org } = doc;
  const payment = r.kind === "payment";
  const title = payment ? "Payment receipt" : r.kind === "refund" ? "Refund receipt" : "Payment reversal";
  const p = setup(`${title} ${r.receiptNo}`, org);
  const { left, width, text } = p;

  let y = p.letterhead(title, r.receiptNo);
  y = p.metaStrip(y, [
    { label: payment ? "Receipt date" : "Date", value: date(r.date) },
    { label: "Invoice no.", value: r.invoiceNo },
    { label: "Payment method", value: METHOD[r.method] },
    { label: "Status", value: STAGE_LABEL[r.stage], color: STAGE_COLOR[r.stage] },
  ]);

  const half = width / 2 - 12;
  const from = p.block(
    payment ? "Received from" : "Paid to",
    [inv.client, inv.clientAddress, inv.clientPhone && `Phone ${inv.clientPhone}`, inv.clientEmail, inv.clientGstin && `GSTIN ${inv.clientGstin}`],
    left,
    y,
    half,
  );
  const project = p.block("Project", [r.siteName, `Project ID ${projectId(r.siteId)}`, `Invoice ${r.invoiceNo} dated ${date(inv.date)}`], left + width / 2 + 12, y, half);
  y = Math.max(from, project) + 18;

  // The amount, large, with its words.
  const words = amountInWords(String(r.amount));
  const boxH = Math.max(78, 30 + p.height(words, width - 205, { size: 9.5 }) + 16);
  y = p.ensure(y, boxH);
  p.doc.roundedRect(left, y, width, boxH, 8).fill(TINT);
  p.doc.rect(left, y, 5, boxH).fill(STAGE_COLOR[r.stage]);
  text(payment ? "AMOUNT RECEIVED" : r.kind === "refund" ? "AMOUNT REFUNDED" : "AMOUNT REVERSED", left + 18, y + 12, { size: 7.5, bold: true, color: MUTED, characterSpacing: 0.8 });
  text(money(r.amount), left + 18, y + 24, { size: 22, bold: true, color: BRAND, width: 170 });
  text("IN WORDS", left + 190, y + 12, { size: 7.5, bold: true, color: MUTED, characterSpacing: 0.8 });
  text(words, left + 190, y + 26, { size: 9.5, width: width - 205 });
  p.pill(STAGE_LABEL[r.stage], STAGE_COLOR[r.stage], left + 18, y + boxH - 26);
  y += boxH + 16;

  // Payment details on the left, the account on the right.
  const details: [string, string][] = [
    [payment ? "Payment date" : "Date", date(r.date)],
    ["Payment method", METHOD[r.method]],
    ["Transaction reference", r.reference || "Not applicable"],
    ...(r.related ? ([["Against receipt", r.related.receiptNo]] as [string, string][]) : []),
    [payment ? "Description" : "Reason", r.notes || `Payment against invoice ${r.invoiceNo}`],
  ];
  const account = [
    { label: "Total invoice amount", value: money(r.invoiceTotal), strong: true },
    { label: "Previously paid", value: money(r.paidBefore) },
    payment ? { label: "This payment", value: money(r.amount), color: ACCENT } : { label: r.kind === "refund" ? "Less this refund" : "Less this reversal", value: `− ${money(r.amount)}`, color: RED },
    { label: "Total paid to date", value: money(r.paidToDate), strong: true },
    { label: "Remaining balance", value: money(Math.max(r.balanceAfter, 0)), highlight: r.balanceAfter > 0 ? BRAND : ACCENT },
  ];
  const dw = width - 270;
  const detailsH = details.reduce((t, [, v]) => t + 13 + p.height(v, dw, { size: 9.5 }) + 6, 16);
  y = p.ensure(y, Math.max(detailsH, p.summaryHeight(account) + 16));
  const top = y;
  text("PAYMENT DETAILS", left, y, { size: 7.5, bold: true, color: ACCENT, characterSpacing: 0.8 });
  p.rule(y + 11, LINE, 0.6, left, dw);
  let dy = y + 17;
  for (const [k, v] of details) {
    text(k, left, dy, { size: 8, color: MUTED, width: dw });
    dy = text(v, left, dy + 10, { size: 9.5, width: dw }) + 6;
  }
  text("ACCOUNT SUMMARY", left + width - 250, top, { size: 7.5, bold: true, color: ACCENT, characterSpacing: 0.8 });
  p.rule(top + 11, LINE, 0.6, left + width - 250, 250);
  const sy = p.summary(top + 12, account);
  y = Math.max(dy, sy) + 14;

  if (payment && r.reversed) y = text("This payment was later reversed; see the linked reversal record.", left, y, { size: 9, bold: true, color: RED, width }) + 8;
  else if (payment && r.refunded > 0) y = text(`${money(r.refunded)} of this payment was later refunded; see the linked refund records.`, left, y, { size: 9, bold: true, color: RED, width }) + 8;

  y = p.ensure(y + 4, 70);
  y = text("Payment history", left, y, { size: 11, bold: true, color: BRAND }) + 6;
  y = p.table(
    y,
    [
      { label: "Date", width: 15 },
      { label: "Receipt no.", width: 21 },
      { label: "Type", width: 20 },
      { label: "Amount", width: 21, align: "right" },
      { label: "Balance after", width: 23, align: "right" },
    ],
    history.map((e) => [date(e.date), e.receiptNo, STAGE_LABEL[e.stage], e.kind === "payment" ? money(e.amount) : `− ${money(e.amount)}`, money(Math.max(e.balanceAfter, 0))]),
    "",
  );

  p.signatures(y, payment ? "Client's signature" : "Received by (client)", `For ${org.name}`);
  return p.footer(
    `${org.name} · ${title} ${r.receiptNo} · ${r.client}`,
    `Internal receipt, not a tax invoice · computer-generated${preparedBy ? ` · prepared by ${preparedBy}` : ""}`,
  );
}

const STATUS_LABEL = { present: "Present", half_day: "Half day" } as const;

export async function renderLabourInvoicePdf(inv: LabourInvoice, organization: Org, generatedBy: string): Promise<Buffer> {
  const org = profile(organization);
  const p = setup(`Labour invoice, ${inv.worker.name}, ${inv.from} to ${inv.to}`, org);
  const { left, width, text } = p;
  let y = p.letterhead("Labour invoice");
  y = p.metaStrip(y, [
    { label: "Period", value: `${date(inv.from)} – ${date(inv.to)}` },
    { label: "Days worked", value: inv.days },
    { label: "Issued", value: date(today()) },
  ]);

  const half = width / 2 - 12;
  const worker = p.block("Worker", [inv.worker.name, inv.worker.trade, inv.worker.phone && `Phone ${inv.worker.phone}`], left, y, half);
  const site = p.block("Site", [inv.site.name, inv.site.location, inv.site.client && `Client ${inv.site.client}`], left + width / 2 + 12, y, half);
  y = Math.max(worker, site) + 18;

  y = text("Attendance", left, y, { size: 11, bold: true, color: BRAND }) + 6;
  y = p.table(
    y,
    [
      { label: "Date", width: 18 },
      { label: "Day", width: 16 },
      { label: "Work", width: 30 },
      { label: "Day rate", width: 18, align: "right" },
      { label: "Wage", width: 18, align: "right" },
    ],
    inv.attendance.map((a) => [date(a.date), STATUS_LABEL[a.status], a.workType, money(a.dayRate), money(a.amount)]),
    "No attendance in this period.",
  );

  y = p.ensure(y + 16, 60);
  y = text("Payments in this period", left, y, { size: 11, bold: true, color: BRAND }) + 6;
  y = p.table(
    y,
    [
      { label: "Date", width: 18 },
      { label: "Paid as", width: 16 },
      { label: "Details", width: 48 },
      { label: "Amount", width: 18, align: "right" },
    ],
    inv.payments.map((x) => [date(x.date), x.kind === "advance" ? "Advance" : "Wages", x.description, money(x.amount)]),
    "No payments in this period.",
  );

  const closing = Number(inv.closing);
  const opening = Number(inv.opening);
  const lines = [
    { label: opening < 0 ? "Advance carried in" : "Owed before period", value: opening < 0 ? `− ${money(-opening)}` : money(opening) },
    { label: "Wages earned", value: money(inv.earned) },
    { label: "Less wages paid", value: `− ${money(inv.wagesPaid)}` },
    { label: "Less advances", value: `− ${money(inv.advances)}` },
    { label: closing < 0 ? "Advance outstanding" : "Amount payable", value: money(Math.abs(closing)), highlight: BRAND },
  ];
  y = p.ensure(y + 6, p.summaryHeight(lines) + 10);
  y = p.summary(y + 6, lines, 260);
  if (closing >= 0) {
    y = p.ensure(y + 6, 30);
    y = text(`Amount payable in words: ${amountInWords(inv.closing)}`, left, y, { size: 9.5, width }) + 6;
  }

  p.signatures(y, "Worker's signature", `For ${org.name}`);
  return p.footer(`${org.name} · Labour invoice · ${inv.worker.name}`, `Internal statement, not a tax invoice · computer-generated · prepared by ${generatedBy}`);
}
