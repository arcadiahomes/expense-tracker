import "server-only";
import PDFDocument from "pdfkit";
import type { ClientInvoice, LabourInvoice } from "@/lib/types";
import { today } from "../data/shared";
import { loadFonts } from "./pdf";
import { cleanText } from "./safe";

/**
 * Invoices → PDF (A4 portrait). Like the reports, every amount shown was computed in
 * SQL, user text is cleaned of control and bidi characters, and pdfkit writes it as
 * glyphs in embedded fonts (Carlito, Rachana for Malayalam).
 */

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const date = (iso: string) => `${iso.slice(8)} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const money = (v: string | number) => inr.format(Number(v));

const MALAYALAM = /[ഀ-ൿ]/;
const INK = "#111827";
const MUTED = "#4b5563";
const BRAND = "#14532d";
const LINE = "#c9d6cd";

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

/** An A4 portrait page set with the helpers both invoices draw with. */
function setup(title: string, author: string) {
  const f = loadFonts();
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 44, bottom: 54, left: 44, right: 44 },
    bufferPages: true,
    info: { Title: cleanText(title, 200), Author: cleanText(author, 200), Creator: "Arcadia Home" },
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
  const text = (s: string, x: number, y: number, opts: Opts = {}) => {
    const clean = cleanText(s, 2000);
    doc
      .font(MALAYALAM.test(clean) ? (opts.bold ? "mlBold" : "ml") : opts.bold ? "latinBold" : "latin")
      .fontSize(opts.size ?? 9.5)
      .fillColor(opts.color ?? INK);
    doc.text(clean, x, y, { lineBreak: true, ...opts });
    return doc.y;
  };
  const height = (s: string, w: number, opts: { bold?: boolean; size?: number } = {}) => {
    const clean = cleanText(s, 2000);
    doc.font(MALAYALAM.test(clean) ? (opts.bold ? "mlBold" : "ml") : opts.bold ? "latinBold" : "latin").fontSize(opts.size ?? 9.5);
    return doc.heightOfString(clean || " ", { width: w });
  };

  /** A table that repeats its header on each new page. Returns the y below it. */
  const table = (y: number, cols: Col[], rows: string[][], empty: string) => {
    const total = cols.reduce((t, c) => t + c.width, 0);
    const widths = cols.map((c) => (c.width / total) * width);
    const xs = widths.map((_, i) => left + widths.slice(0, i).reduce((t, w) => t + w, 0));
    const pad = 4;
    const header = () => {
      const h = Math.max(...cols.map((c, i) => height(c.label, widths[i] - pad * 2, { bold: true, size: 9 }))) + pad * 2;
      doc.rect(left, y, width, h).fill(BRAND);
      cols.forEach((c, i) => text(c.label, xs[i] + pad, y + pad, { size: 9, bold: true, color: "#ffffff", width: widths[i] - pad * 2, align: c.align ?? "left" }));
      y += h;
    };
    header();
    if (!rows.length) {
      text(empty, left + pad, y + 6, { size: 9, color: MUTED });
      return y + 24;
    }
    for (const row of rows) {
      const h = Math.max(...row.map((s, i) => height(s, widths[i] - pad * 2))) + pad * 2;
      if (y + h > bottom()) {
        doc.addPage();
        y = doc.page.margins.top;
        header();
      }
      row.forEach((s, i) => text(s, xs[i] + pad, y + pad, { width: widths[i] - pad * 2, align: cols[i].align ?? "left" }));
      y += h;
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.4).strokeColor(LINE).stroke();
    }
    return y;
  };

  /** Label/value lines right-aligned under a table; the last one is the grand total. */
  const summary = (y: number, lines: [string, string][], boxWidth = 240) => {
    if (y + lines.length * 18 + 16 > bottom()) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    const x = left + width - boxWidth;
    y += 8;
    lines.forEach(([label, value], i) => {
      const last = i === lines.length - 1;
      if (last) {
        doc.rect(x, y - 3, boxWidth, 22).fill("#e8f3ec");
        y += 2;
      }
      text(label, x + 6, y, { size: last ? 11 : 9.5, bold: last, width: boxWidth / 2 });
      text(value, x + boxWidth / 2, y, { size: last ? 11 : 9.5, bold: last, width: boxWidth / 2 - 6, align: "right" });
      y += last ? 22 : 16;
    });
    return y;
  };

  /** A block of label/value pairs, e.g. "Bill to". Returns the y below it. */
  const block = (title: string, lines: string[], x: number, y: number, w: number) => {
    text(title.toUpperCase(), x, y, { size: 8, bold: true, color: MUTED, width: w, characterSpacing: 0.6 });
    let yy = y + 12;
    lines.filter(Boolean).forEach((l, i) => {
      yy = text(l, x, yy, { size: i === 0 ? 11 : 9.5, bold: i === 0, width: w }) + 1;
    });
    return yy;
  };

  const footer = (label: string) => {
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const fy = doc.page.height - 34;
      const saved = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.moveTo(left, fy - 6).lineTo(left + width, fy - 6).lineWidth(0.4).strokeColor(LINE).stroke();
      text(label, left, fy, { size: 7.5, color: MUTED, width: width - 80, lineBreak: false });
      text(`Page ${i + 1} of ${range.count}`, left + width - 80, fy, { size: 7.5, color: MUTED, width: 80, align: "right", lineBreak: false });
      doc.page.margins.bottom = saved;
    }
    doc.end();
    return done;
  };

  /** Organization name on the left, document title and its details on the right. */
  const heading = (org: string, title: string, details: [string, string][]) => {
    const top = doc.page.margins.top;
    const orgBottom = text(org, left, top, { size: 18, bold: true, color: BRAND, width: width * 0.55 });
    text(title.toUpperCase(), left + width * 0.55, top, { size: 16, bold: true, color: INK, width: width * 0.45, align: "right", characterSpacing: 1 });
    let y = top + 24;
    for (const [k, v] of details) {
      text(`${k}  `, left + width * 0.55, y, { size: 9, color: MUTED, width: width * 0.45 - 110, align: "right" });
      text(v, left + width - 110, y, { size: 9, bold: true, width: 110, align: "right" });
      y += 13;
    }
    y = Math.max(y, orgBottom) + 10;
    doc.moveTo(left, y).lineTo(left + width, y).lineWidth(1.2).strokeColor(BRAND).stroke();
    return y + 14;
  };

  /** A boxed status stamp beside the totals: PAID, CANCELLED. */
  const stamp = (label: string, color: string, y: number) => {
    doc.save();
    doc.roundedRect(left, y, 130, 30, 4).lineWidth(2).strokeColor(color).stroke();
    text(label, left, y + 7, { size: 14, bold: true, color, width: 130, align: "center", characterSpacing: 2 });
    doc.restore();
  };

  return { doc, left, width, bottom, text, table, summary, block, footer, heading, stamp };
}

export async function renderClientInvoicePdf(inv: ClientInvoice, organization: string): Promise<Buffer> {
  const p = setup(`Invoice ${inv.invoiceNo}`, organization);
  const { left, width, text } = p;
  let y = p.heading(organization, "Invoice", [
    ["Invoice no.", inv.invoiceNo],
    ["Invoice date", date(inv.date)],
    ["Due date", date(inv.dueDate)],
  ]);

  const half = width / 2 - 10;
  const billTo = p.block("Bill to", [inv.client, inv.clientAddress, inv.clientGstin && `GSTIN ${inv.clientGstin}`], left, y, half);
  const site = p.block("Site", [inv.siteName], left + width / 2 + 10, y, half);
  y = Math.max(billTo, site) + 16;

  y = p.table(
    y,
    [
      { label: "#", width: 4 },
      { label: "Description", width: 40 },
      { label: "Qty", width: 10, align: "right" },
      { label: "Unit", width: 9 },
      { label: "Rate", width: 17, align: "right" },
      { label: "Amount", width: 20, align: "right" },
    ],
    inv.items.map((it, i) => [String(i + 1), it.description, qtyFmt.format(Number(it.quantity)), it.unit, money(it.unitPrice), money(it.amount)]),
    "No items.",
  );

  const totalsTop = y + 4;
  y = p.summary(y, [
    ["Subtotal", money(inv.subtotal)],
    ...(inv.gstPercent > 0 ? ([[`GST @ ${inv.gstPercent}%`, money(inv.gst)]] as [string, string][]) : []),
    ["Total", money(inv.total)],
  ]);
  if (inv.status === "paid") p.stamp("PAID", "#15803d", totalsTop + 10);
  if (inv.status === "cancelled") p.stamp("CANCELLED", "#b91c1c", totalsTop + 10);

  y = text(`Amount in words: ${amountInWords(String(inv.total))}`, left, y + 8, { size: 9.5, width }) + 10;
  const extra: string[] = [];
  if (inv.status === "paid" && inv.paidOn) extra.push(`Received on ${date(inv.paidOn)}${inv.paidReference ? `, reference ${inv.paidReference}` : ""}.`);
  if (inv.status === "cancelled") extra.push(`Cancelled: ${inv.cancelReason ?? ""}`);
  if (inv.notes) extra.push(inv.notes);
  for (const line of extra) {
    if (y + 40 > p.bottom()) {
      p.doc.addPage();
      y = p.doc.page.margins.top;
    }
    y = text(line, left, y, { size: 9.5, color: MUTED, width }) + 6;
  }
  return p.footer(`${organization} · Invoice ${inv.invoiceNo} · ${inv.client}`);
}

const STATUS_LABEL = { present: "Present", half_day: "Half day" } as const;

export async function renderLabourInvoicePdf(inv: LabourInvoice, organization: string, generatedBy: string): Promise<Buffer> {
  const p = setup(`Labour invoice, ${inv.worker.name}, ${inv.from} to ${inv.to}`, organization);
  const { left, width, text } = p;
  let y = p.heading(organization, "Labour invoice", [
    ["Period", `${date(inv.from)} – ${date(inv.to)}`],
    ["Days worked", inv.days],
    ["Issued", date(today())],
  ]);

  const half = width / 2 - 10;
  const worker = p.block("Worker", [inv.worker.name, inv.worker.trade, inv.worker.phone && `Phone ${inv.worker.phone}`], left, y, half);
  const site = p.block("Site", [inv.site.name, inv.site.location, inv.site.client && `Client ${inv.site.client}`], left + width / 2 + 10, y, half);
  y = Math.max(worker, site) + 16;

  y = text("Attendance", left, y, { size: 11, bold: true, color: BRAND }) + 4;
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

  y += 16;
  if (y + 60 > p.bottom()) {
    p.doc.addPage();
    y = p.doc.page.margins.top;
  }
  y = text("Payments in this period", left, y, { size: 11, bold: true, color: BRAND }) + 4;
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
  y = p.summary(
    y + 6,
    [
      [opening < 0 ? "Advance carried in" : "Owed before period", opening < 0 ? `− ${money(-opening)}` : money(opening)],
      ["Wages earned", money(inv.earned)],
      ["Less wages paid", `− ${money(inv.wagesPaid)}`],
      ["Less advances", `− ${money(inv.advances)}`],
      [closing < 0 ? "Advance outstanding" : "Amount payable", money(Math.abs(closing))],
    ],
    260,
  );
  if (closing >= 0) y = text(`Amount payable in words: ${amountInWords(inv.closing)}`, left, y + 8, { size: 9.5, width }) + 6;

  y += 30;
  if (y + 40 > p.bottom()) {
    p.doc.addPage();
    y = p.doc.page.margins.top + 30;
  }
  const sig = (label: string, x: number) => {
    p.doc.moveTo(x, y).lineTo(x + 170, y).lineWidth(0.6).strokeColor(INK).stroke();
    text(label, x, y + 4, { size: 8.5, color: MUTED, width: 170 });
  };
  sig("Worker's signature", left);
  sig(`For ${organization}`, left + width - 170);

  return p.footer(`${organization} · Labour invoice · ${inv.worker.name} · internal statement, not a tax invoice · prepared by ${generatedBy}`);
}
