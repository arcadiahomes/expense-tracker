/** Date helpers on yyyy-mm-dd strings. Pure, so server and client agree. */

export function shiftDate(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string) {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

/** Monday of the week containing `iso`. */
export function weekStart(iso: string) {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return shiftDate(iso, -((day + 6) % 7));
}

export function monthStart(iso: string) {
  return `${iso.slice(0, 7)}-01`;
}

/** Today's date on Indian site clocks, regardless of where the server runs. */
export function todayInIndia(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
