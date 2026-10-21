import "server-only";
import ExcelJS from "exceljs";
import { CATEGORY_META } from "@/lib/categories";
import type { Column, Report, Row, Section } from "./build";
import { cleanText, safeSheetText, sheetName } from "./safe";

/**
 * Report → .xlsx. Amounts are real numbers with an Indian rupee format, dates are real
 * dates, quantities keep up to three decimals. Subtotals and totals are the values the
 * server computed, written as numbers (not formulas), so the file matches the PDF and
 * the app exactly. No cell is ever written as a formula.
 */

// Indian digit grouping (₹1,23,45,678.00). Excel allows two conditions; the third section covers
// everything below a lakh, negatives included (shown with a minus sign).
const INR = '[>=10000000]"₹"##\\,##\\,##\\,##0.00;[>=100000]"₹"##\\,##\\,##0.00;"₹"#,##0.00';
const QTY = "#,##0.###";
const DATE = "dd-mmm-yyyy";

const FILL_HEAD: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF14532D" } };
const FILL_GROUP: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F3EC" } };
const FILL_SUB: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4F7F5" } };
const THIN: Partial<ExcelJS.Border> = { style: "thin", color: { argb: "FFB7C7BD" } };

function cellValue(col: Column, v: Row[string]): ExcelJS.CellValue {
  if (v === null || v === undefined || v === "") return null;
  switch (col.type) {
    case "money":
    case "qty":
    case "int":
      return Number(v);
    case "percent":
      return Number(v) / 100;
    case "date": {
      const s = String(v);
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : safeSheetText(s);
    }
    default:
      return safeSheetText(v);
  }
}

function writeHeader(ws: ExcelJS.Worksheet, report: Report, title: string, width: number) {
  const lines: [string, string][] = [
    ["Report", `${report.title}${title !== report.title ? `: ${title}` : ""}`],
    ["Organization", report.organization],
    report.consolidated
      ? ["Sites", `Consolidated, ${report.sites.length} sites: ${report.sites.map((s) => s.name).join(", ")}`]
      : ["Site", [report.sites[0].name, report.sites[0].location, report.sites[0].client && `Client: ${report.sites[0].client}`].filter(Boolean).join(", ")],
    ["Period", `${report.period.from} to ${report.period.to} (${report.period.days} days)`],
    ["Filters", report.filters.length ? report.filters.join("; ") : "None"],
    ["Generated", `${new Date(report.generatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST by ${report.generatedBy}`],
  ];
  for (const [k, v] of lines) {
    const row = ws.addRow([k, safeSheetText(v)]);
    row.getCell(1).font = { bold: true, color: { argb: "FF4B5563" } };
    ws.mergeCells(row.number, 2, row.number, Math.max(2, width));
  }
  const note = ws.addRow([safeSheetText(report.notes[0])]);
  note.getCell(1).font = { italic: true, color: { argb: "FF92400E" } };
  ws.mergeCells(note.number, 1, note.number, Math.max(2, width));
  note.height = 30;
  note.getCell(1).alignment = { wrapText: true, vertical: "top" };
  ws.addRow([]);
}

function writeSection(ws: ExcelJS.Worksheet, report: Report, section: Section) {
  const cols = section.columns;
  writeHeader(ws, report, section.title, cols.length);
  if (section.note) {
    const r = ws.addRow([safeSheetText(section.note)]);
    ws.mergeCells(r.number, 1, r.number, cols.length);
    r.getCell(1).alignment = { wrapText: true };
    r.getCell(1).font = { color: { argb: "FF4B5563" } };
    r.height = 30;
  }

  const head = ws.addRow(cols.map((c) => c.label));
  head.eachCell((cell, i) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = FILL_HEAD;
    cell.alignment = { vertical: "middle", horizontal: ["money", "qty", "int", "percent"].includes(cols[i - 1].type) ? "right" : "left", wrapText: true };
  });
  head.height = 22;
  ws.views = [{ state: "frozen", ySplit: head.number }];

  cols.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.max(c.width, i === 0 ? 14 : 0);
    col.numFmt = c.type === "money" ? INR : c.type === "qty" ? QTY : c.type === "int" ? "0" : c.type === "percent" ? "0.0%" : c.type === "date" ? DATE : "@";
  });

  const style = (row: ExcelJS.Row, kind: "item" | "group" | "sub" | "total") => {
    row.eachCell({ includeEmpty: true }, (cell, i) => {
      const c = cols[i - 1];
      if (!c) return;
      cell.numFmt = c.type === "money" ? INR : c.type === "qty" ? QTY : c.type === "int" ? "0" : c.type === "percent" ? "0.0%" : c.type === "date" ? DATE : "@";
      cell.alignment = { vertical: "top", wrapText: c.type === "text" };
      if (kind === "group") {
        cell.fill = FILL_GROUP;
        cell.font = { bold: true };
      } else if (kind === "sub") {
        cell.fill = FILL_SUB;
        cell.font = { bold: true };
        cell.border = { top: THIN };
      } else if (kind === "total") {
        cell.font = { bold: true, size: 12 };
        cell.border = { top: { style: "thin" }, bottom: { style: "double" } };
      } else {
        cell.border = { bottom: THIN };
      }
    });
  };

  if (!section.groups.length) {
    const r = ws.addRow([safeSheetText(section.empty)]);
    r.getCell(1).font = { italic: true, color: { argb: "FF6B7280" } };
    ws.mergeCells(r.number, 1, r.number, cols.length);
  }
  for (const g of section.groups) {
    if (g.label !== null) {
      const r = ws.addRow([safeSheetText(g.label)]);
      ws.mergeCells(r.number, 1, r.number, cols.length);
      style(r, "group");
    }
    for (const item of g.rows) style(ws.addRow(cols.map((c) => cellValue(c, item[c.key]))), "item");
    if (g.subtotal) style(ws.addRow(cols.map((c) => cellValue(c, g.subtotal![c.key]))), "sub");
  }
  if (section.total) {
    ws.addRow([]);
    style(ws.addRow(cols.map((c) => cellValue(c, section.total![c.key]))), "total");
  }
  ws.pageSetup = { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${head.number}:${head.number}` };
  ws.headerFooter = { oddFooter: `&L${cleanText(report.title).replace(/&/g, "&&")} · internal statement, not a tax invoice&RPage &P of &N` };
}

export async function renderXlsx(report: Report): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = cleanText(`${report.organization} (Arcadia Home)`, 200);
  wb.created = new Date(report.generatedAt);
  wb.title = cleanText(report.title, 200);
  const used = new Set<string>();

  // A cover sheet with site details for consolidated or single-site reports.
  const cover = wb.addWorksheet(sheetName("Summary", used));
  writeHeader(cover, report, report.title, 6);
  const head = cover.addRow(["Site", "Location", "Client", "Status", "Started", "Total budget"]);
  head.eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = FILL_HEAD;
  });
  for (const s of report.sites) {
    const r = cover.addRow([safeSheetText(s.name), safeSheetText(s.location), s.client ? safeSheetText(s.client) : null, s.status, new Date(`${s.startDate}T00:00:00Z`), s.budget === null ? null : Number(s.budget)]);
    r.getCell(5).numFmt = DATE;
    r.getCell(6).numFmt = INR;
  }
  [22, 22, 20, 12, 13, 16].forEach((w, i) => (cover.getColumn(i + 1).width = w));
  if (report.ignored.length) {
    cover.addRow([]);
    cover.addRow([safeSheetText(`Not applied to this report: ${report.ignored.join("; ")}`)]).getCell(1).font = { italic: true };
  }
  cover.addRow([]);
  cover.addRow([`Categories: ${Object.values(CATEGORY_META).map((m) => m.label).join(", ")}`]).getCell(1).font = { color: { argb: "FF6B7280" } };

  for (const section of report.sections) writeSection(wb.addWorksheet(sheetName(section.title, used)), report, section);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
