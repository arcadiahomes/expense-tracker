import type { DateFormat, NumberStyle } from "./types";

const inrFull = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

/** ₹1,25,000 */
export function formatINR(amount: number) {
  return inrFull.format(amount);
}

const inrPaise = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** ₹1,25,000, or ₹1,25,000.50 when there are paise: for receipts and balances, where every paisa counts. */
export function formatINRExact(amount: number) {
  return Math.round(amount * 100) % 100 === 0 ? inrFull.format(amount) : inrPaise.format(amount);
}

/** ₹1.25 L / ₹2.4 Cr — the way site teams talk about money. */
export function formatINRCompact(amount: number) {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "−" : "";
  if (abs >= 1_00_00_000) return `${sign}₹${trim(abs / 1_00_00_000)} Cr`;
  if (abs >= 1_00_000) return `${sign}₹${trim(abs / 1_00_000)} L`;
  if (abs >= 1_000) return `${sign}₹${trim(abs / 1_000)}k`;
  return `${sign}₹${abs}`;
}

function trim(n: number) {
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1).replace(/\.0$/, "") : n.toFixed(2).replace(/\.?0+$/, "");
}

export function formatMoney(amount: number, style: NumberStyle) {
  return style === "compact" ? formatINRCompact(amount) : formatINR(amount);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(iso: string, format: DateFormat) {
  const [y, m, d] = iso.split("-");
  switch (format) {
    case "dd/MM/yyyy":
      return `${d}/${m}/${y}`;
    case "yyyy-MM-dd":
      return iso;
    default:
      return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  }
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * "Tuesday, 20 October". Built by hand: Intl output differs between
 * Node and browsers, which breaks hydration.
 */
export function longDate(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS_LONG[d.getUTCMonth()]}`;
}

/** Short label for chart axes: "14 Oct". */
export function shortDate(iso: string) {
  const [, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

export function monthLabel(yyyyMm: string) {
  const [y, m] = yyyyMm.split("-");
  return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`;
}

export function formatFileSize(bytes: number) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

export function percent(part: number, whole: number) {
  return whole <= 0 ? 0 : Math.round((part / whole) * 100);
}
