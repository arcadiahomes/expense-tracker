import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import type { Column, Report, Row, Section } from "./build";
import { cleanText } from "./safe";

/**
 * Report → PDF (A4 landscape). pdfkit writes text as glyph ids in embedded fonts, so
 * user text can never become PDF syntax; it is also stripped of control and bidi
 * characters first. Every number shown was computed by the server.
 */

const FONT_DIR = path.join(process.cwd(), "src/assets/fonts");
let fonts: Record<"latin" | "latinBold" | "ml" | "mlBold", Buffer> | null = null;
function loadFonts() {
  fonts ??= {
    latin: readFileSync(path.join(FONT_DIR, "Carlito-Regular.ttf")),
    latinBold: readFileSync(path.join(FONT_DIR, "Carlito-Bold.ttf")),
    ml: readFileSync(path.join(FONT_DIR, "RIT-Rachana-Regular.otf")),
    mlBold: readFileSync(path.join(FONT_DIR, "RIT-Rachana-Bold.otf")),
  };
  return fonts;
}

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const date = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8)} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : iso);

function format(col: Column, v: Row[string]): string {
  if (v === null || v === undefined || v === "") return "";
  switch (col.type) {
    case "money":
      return inr.format(Number(v));
    case "qty":
      return qtyFmt.format(Number(v));
    case "int":
      return String(Number(v));
    case "percent":
      return `${Number(v).toFixed(1)}%`;
    case "date":
      return date(String(v));
    default:
      return cleanText(v, 400);
  }
}

const MALAYALAM = /[ഀ-ൿ]/;
const INK = "#111827";
const MUTED = "#4b5563";
const BRAND = "#14532d";
const LINE = "#c9d6cd";

export async function renderPdf(report: Report): Promise<Buffer> {
  const f = loadFonts();
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margins: { top: 40, bottom: 48, left: 36, right: 36 },
    bufferPages: true,
    info: {
      Title: cleanText(`${report.title}, ${report.period.from} to ${report.period.to}`, 200),
      Author: cleanText(report.organization, 200),
      Subject: "Internal statement. Not a tax invoice.",
      Creator: "Arcadia Home",
    },
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
  /** Picks the font that has the glyphs: Rachana for any Malayalam, Carlito otherwise. */
  const font = (text: string, bold = false) => doc.font(MALAYALAM.test(text) ? (bold ? "mlBold" : "ml") : bold ? "latinBold" : "latin");
  const text = (s: string, x: number, y: number, opts: PDFKit.Mixins.TextOptions & { bold?: boolean; size?: number; color?: string } = {}) => {
    const clean = cleanText(s, 2000);
    font(clean, opts.bold).fontSize(opts.size ?? 9).fillColor(opts.color ?? INK);
    doc.text(clean, x, y, { lineBreak: true, ...opts });
  };

  // ---- First-page header ----------------------------------------------------------
  text(report.organization, left, 40, { size: 10, color: MUTED });
  text(report.title, left, 54, { size: 18, bold: true, color: BRAND });
  const site = report.sites[0];
  const details: [string, string][] = [
    ["Reporting period", `${date(report.period.from)} to ${date(report.period.to)} (${report.period.days} ${report.period.days === 1 ? "day" : "days"})`],
    report.consolidated
      ? ["Sites", `Consolidated report for ${report.sites.length} sites: ${report.sites.map((s) => s.name).join(", ")}`]
      : ["Site", [site.name, site.location, site.client && `client ${site.client}`, site.status, `started ${date(site.startDate)}`, site.budget && `budget ${inr.format(Number(site.budget))}`].filter(Boolean).join(" · ")],
    ["Filters", report.filters.length ? report.filters.join(" · ") : "None"],
    ["Generated", `${new Date(report.generatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} IST by ${report.generatedBy}`],
  ];
  if (report.ignored.length) details.push(["Not applied", report.ignored.join(" · ")]);
  let y = 82;
  for (const [k, v] of details) {
    text(k, left, y, { size: 9, bold: true, color: MUTED, width: 100 });
    text(v, left + 104, y, { size: 9, width: width - 104 });
    y = Math.max(doc.y, y + 12) + 2;
  }
  // The statement notice, boxed so it can't be missed.
  y += 4;
  const note = report.notes[0];
  font(note).fontSize(8.5);
  const noteH = doc.heightOfString(note, { width: width - 16 }) + 10;
  doc.roundedRect(left, y, width, noteH, 3).fillAndStroke("#fffbeb", "#f59e0b");
  text(note, left + 8, y + 5, { size: 8.5, color: "#78350f", width: width - 16 });
  y += noteH + 14;

  // ---- Tables ------------------------------------------------------------------------
  const drawSection = (section: Section) => {
    const cols = section.columns;
    const totalW = cols.reduce((t, c) => t + c.width, 0);
    const widths = cols.map((c) => (c.width / totalW) * width);
    const xs = widths.map((_, i) => left + widths.slice(0, i).reduce((t, w) => t + w, 0));
    const right = (c: Column) => ["money", "qty", "int", "percent"].includes(c.type);
    const pad = 3;

    const rowHeight = (cells: string[], bold: boolean, size: number) =>
      Math.min(
        48,
        Math.max(
          ...cells.map((s, i) => {
            font(s, bold).fontSize(size);
            return doc.heightOfString(s || " ", { width: widths[i] - pad * 2 });
          }),
        ) + pad * 2,
      );

    const drawHeader = () => {
      const labels = cols.map((c) => c.label);
      const h = rowHeight(labels, true, 8.5);
      doc.rect(left, y, width, h).fill(BRAND);
      labels.forEach((l, i) => text(l, xs[i] + pad, y + pad, { size: 8.5, bold: true, color: "#ffffff", width: widths[i] - pad * 2, align: right(cols[i]) ? "right" : "left" }));
      y += h;
    };
    const ensure = (h: number, header = true) => {
      if (y + h > bottom()) {
        doc.addPage();
        y = doc.page.margins.top;
        text(`${section.title} (continued)`, left, y, { size: 10, bold: true, color: BRAND });
        y = doc.y + 4;
        if (header) drawHeader();
      }
    };
    const drawRow = (row: Row, kind: "item" | "sub" | "total") => {
      const cells = cols.map((c) => format(c, row[c.key]));
      const bold = kind !== "item";
      const size = kind === "total" ? 9.5 : 8.5;
      const h = rowHeight(cells, bold, size);
      ensure(h);
      if (kind === "sub") doc.rect(left, y, width, h).fill("#f3f6f4");
      cells.forEach((s, i) =>
        text(s, xs[i] + pad, y + pad, { size, bold, width: widths[i] - pad * 2, height: h - pad, ellipsis: true, align: right(cols[i]) ? "right" : "left" }),
      );
      y += h;
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(kind === "total" ? 1.2 : 0.4).strokeColor(kind === "item" ? LINE : INK).stroke();
      if (kind === "total") {
        doc.moveTo(left, y + 2).lineTo(left + width, y + 2).lineWidth(0.6).stroke();
        y += 3;
      }
    };

    ensure(60, false);
    text(section.title, left, y, { size: 12, bold: true, color: BRAND });
    y = doc.y + 2;
    if (section.note) {
      text(section.note, left, y, { size: 8.5, color: MUTED, width });
      y = doc.y + 4;
    }
    drawHeader();
    if (!section.groups.length) {
      ensure(20);
      text(section.empty, left + pad, y + 5, { size: 9, color: MUTED });
      y += 20;
    }
    for (const g of section.groups) {
      if (g.label !== null) {
        ensure(34);
        doc.rect(left, y, width, 16).fill("#e8f3ec");
        text(g.label, left + pad, y + 3, { size: 9, bold: true, width: width - pad * 2 });
        y += 16;
      }
      for (const r of g.rows) drawRow(r, "item");
      if (g.subtotal) drawRow(g.subtotal, "sub");
    }
    if (section.total) drawRow(section.total, "total");
    y += 18;
  };
  for (const s of report.sections) drawSection(s);

  // ---- Footer on every page ----------------------------------------------------------
  const range = doc.bufferedPageRange();
  const stamp = new Date(report.generatedAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium" });
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const fy = doc.page.height - 30;
    // Keep the footer out of the bottom margin's auto page-break.
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    text(`${report.title} · ${report.organization} · internal statement, not a tax invoice · generated ${stamp}`, left, fy, { size: 7.5, color: MUTED, width: width - 80, lineBreak: false });
    text(`Page ${i + 1} of ${range.count}`, left + width - 80, fy, { size: 7.5, color: MUTED, width: 80, align: "right", lineBreak: false });
    doc.page.margins.bottom = saved;
  }
  doc.end();
  return done;
}
