/**
 * Text that came from users (descriptions, names, references) is made safe before it
 * goes into a spreadsheet or PDF.
 */

// C0/C1 controls (except tab and newline) and bidi overrides that can disguise text.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** Strips control and bidi-override characters and caps the length. */
export function cleanText(v: unknown, max = 500): string {
  const s = String(v ?? "").replace(CONTROL, "").replace(/\r\n?/g, "\n");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Spreadsheet formula injection: text starting with = + - @ (or a tab or CR, or
 * their full-width forms) is run as a formula by Excel, LibreOffice and Sheets,
 * including after the file is re-saved as CSV. Such text gets a leading apostrophe,
 * so it's shown, never evaluated.
 */
const FORMULA_START = /^[=+\-@\t\r＝＋－＠]/;

export function safeSheetText(v: unknown): string {
  const s = cleanText(v, 32_000);
  // Judge the original too: cleaning turns a leading CR into a newline.
  return FORMULA_START.test(String(v ?? "")) || FORMULA_START.test(s) ? `'${s}` : s;
}

/** Excel sheet names: at most 31 characters, none of []:*?/\ . */
export function sheetName(title: string, used: Set<string>) {
  const base = title.replace(/[[\]:*?/\\]/g, " ").slice(0, 31).trim() || "Sheet";
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 28)} ${i}`;
  used.add(name.toLowerCase());
  return name;
}

/** Download filename: ASCII letters, digits and dashes only. */
export function fileSlug(...parts: string[]) {
  return parts
    .join("-")
    .normalize("NFKD")
    .replace(/[^\w-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 120);
}
