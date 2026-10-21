import { shiftDate } from "./dates";
import type { Category, PaymentMode } from "./types";
import { draftKey, paiseToRupees, toPaise, type VoiceDraft } from "./voice";

/**
 * Rule-based reader that turns a spoken sentence (English, Malayalam, or the two
 * mixed, in either script) into draft expenses. It only ever copies what was
 * said: a missing amount, category or payment mode stays null for the user to
 * fill in. Runs on the server, and in the browser when the server is unreachable.
 */

type SiteRef = { id: string; name: string };

export type ParseContext = {
  today: string;
  sites: SiteRef[];
  /** The site picked on screen; entries go here unless another site is spoken. */
  defaultSiteId: string;
  workers: string[];
  suppliers: string[];
};

// ---- Normalization ------------------------------------------------------------

const CHILLU: Record<string, string> = { "ൺ": "ണ്", "ൻ": "ന്", "ർ": "ര്", "ൽ": "ല്", "ൾ": "ള്", "ൿ": "ക്" };

/** One spelling for everything: NFC, atomic chillus, ASCII digits, lowercase, "8,000" → "8000". */
export function normalize(text: string) {
  let s = text
    .normalize("NFC")
    .replace(/[‌‍]/g, "")
    .replace(/[ൺൻർൽൾൿ]/g, (c) => CHILLU[c])
    .replace(/[൦-൯]/g, (c) => String(c.charCodeAt(0) - 0x0d66))
    .toLowerCase()
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Indian and western digit grouping: 1,00,000 and 100,000. A comma followed by a space separates clauses.
  while (/\d,\d{2,3}(?!\d)/.test(s)) s = s.replace(/(\d),(\d{2,3})(?!\d)/, "$1$2");
  return s;
}

const L = "\\p{L}\\p{M}";
const isLatin = (w: string) => /^[a-z0-9 .\-/&]+$/.test(w);
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Alternation of words. Latin words need a boundary on both sides; Malayalam
 * words are stems, because suffixes attach to them (സിമന്റിന്, കൂലിയും).
 */
function words(list: string[], opts: { afterDigit?: boolean } = {}) {
  const before = opts.afterDigit ? `(?<![${L}])` : `(?<![${L}\\p{N}])`;
  const latin = list.filter(isLatin).map((w) => `${esc(w)}(?![${L}])`);
  const ml = list.filter((w) => !isLatin(w)).map((w) => esc(normalize(w)));
  return `${before}(?:${[...latin, ...ml].sort((a, b) => b.length - a.length).join("|")})`;
}
const re = (list: string[], flags = "u") => new RegExp(words(list), flags);

// ---- Number words ---------------------------------------------------------------

type NumWord = { value: number; mult?: boolean; tens?: boolean; small?: boolean };

const NUMBER_WORDS: Record<string, NumWord> = {};
const add = (value: number, keys: string[], extra: Partial<NumWord> = {}) => {
  for (const k of keys) NUMBER_WORDS[normalize(k)] = { value, ...extra };
};
// English.
["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"].forEach((w, i) => add(i, [w], { small: true }));
["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"].forEach((w, i) => add(10 + i, [w]));
["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"].forEach((w, i) => add(20 + i * 10, [w], { tens: true }));
add(100, ["hundred", "nooru", "നൂറ്"], { mult: true });
add(1000, ["thousand", "k", "aayiram", "ayiram", "ആയിരം"], { mult: true });
add(100000, ["lakh", "lakhs", "lac", "lacs", "laksham", "ലക്ഷം"], { mult: true });
add(10000000, ["crore", "crores", "kodi", "കോടി"], { mult: true });
// Malayalam (script and common romanizations).
add(1, ["ഒന്ന്", "ഒരു", "onnu", "oru"], { small: true });
add(2, ["രണ്ട്", "randu"], { small: true });
add(3, ["മൂന്ന്", "moonnu"], { small: true });
add(4, ["നാല്", "naalu"], { small: true });
add(5, ["അഞ്ച്", "anchu"], { small: true });
add(6, ["ആറ്", "aaru"], { small: true });
add(7, ["ഏഴ്", "ezhu"], { small: true });
add(8, ["എട്ട്", "ettu"], { small: true });
add(9, ["ഒമ്പത്", "ഒന്പത്", "ombathu"], { small: true });
add(10, ["പത്ത്", "pathu"]);
add(20, ["ഇരുപത്", "irupathu"], { tens: true });
add(30, ["മുപ്പത്", "muppathu"], { tens: true });
add(40, ["നാല്പത്", "nalpathu"], { tens: true });
add(50, ["അമ്പത്", "അന്പത്", "ambathu"], { tens: true });
add(60, ["അറുപത്"], { tens: true });
add(70, ["എഴുപത്"], { tens: true });
add(80, ["എണ്പത്"], { tens: true });
add(90, ["തൊണ്ണൂറ്"], { tens: true });
add(200, ["ഇരുനൂറ്"]);
add(300, ["മുന്നൂറ്"]);
add(400, ["നാനൂറ്"]);
add(500, ["അഞ്ഞൂറ്", "anjooru"]);
add(600, ["അറുനൂറ്"]);
add(700, ["എഴുനൂറ്"]);
add(800, ["എണ്ണൂറ്", "ennooru"]);
add(900, ["തൊള്ളായിരം"]);
add(2000, ["രണ്ടായിരം", "randayiram"]);
add(3000, ["മൂവായിരം", "moovayiram"]);
add(4000, ["നാലായിരം", "naalayiram"]);
add(5000, ["അയ്യായിരം", "ayyayiram"]);
add(6000, ["ആറായിരം"]);
add(7000, ["ഏഴായിരം"]);
add(8000, ["എണ്ണായിരം", "ennayiram"]);
add(9000, ["ഒമ്പതിനായിരം"]);
add(10000, ["പതിനായിരം", "pathinayiram"]);

/** Malayalam "and more" forms: ആയിരത്തി (1000 +), നൂറ്റി (100 +), ഇരുപത്തി (20 +). */
function numberWord(token: string): (NumWord & { additive?: boolean }) | null {
  const direct = NUMBER_WORDS[token];
  if (direct) return direct;
  for (const [suffix, stems] of [
    ["ത്തി", ["ം", "ത്"]],
    ["റ്റി", ["റ്"]],
  ] as const) {
    if (!token.endsWith(suffix)) continue;
    for (const stem of stems) {
      const w = NUMBER_WORDS[token.slice(0, -suffix.length) + stem];
      if (w) return { ...w, additive: true };
    }
  }
  return null;
}

const TOKEN_RE = new RegExp(`[${L}]+|\\d+(?:\\.\\d+)?|\\s+|[^\\s${L}\\d]`, "gu");

/** Replaces spoken numbers ("five thousand", "അയ്യായിരത്തി അഞ്ഞൂറ്", "1.5 lakh", "8k") with digits. */
export function digitsFor(text: string) {
  const tokens = text.match(TOKEN_RE) ?? [];
  const out: string[] = [];
  let group: { total: number; cur: number; prev: "digit" | "mult" | "tens" | "additive" | "plain" | null; ws: string } | null = null;

  const flush = () => {
    if (!group) return;
    const value = group.total + group.cur;
    out.push(Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100), group.ws);
    group = null;
  };

  for (const t of tokens) {
    if (/^\s+$/.test(t)) {
      if (group) group.ws = t;
      else out.push(t);
      continue;
    }
    const digit = /^\d/.test(t) ? Number(t) : null;
    const w = digit === null ? numberWord(t) : null;
    if (digit === null && !w) {
      flush();
      out.push(t);
      continue;
    }
    // "k" is only a number right after one: "8k", not "k" in a name.
    if (w && t === "k" && (!group || group.prev !== "digit")) {
      flush();
      out.push(t);
      continue;
    }
    if (w?.mult) {
      if (!group) group = { total: 0, cur: 0, prev: null, ws: "" };
      group.cur = (group.cur || 1) * w.value;
      if (w.value >= 1000) {
        group.total += group.cur;
        group.cur = 0;
      }
      group.prev = w.additive ? "additive" : "mult";
      group.ws = "";
      continue;
    }
    const value = digit ?? w!.value;
    // Two plain numbers in a row are two numbers ("20 8000"), not one.
    const joins =
      group &&
      (group.prev === "mult" || group.prev === "additive" || (group.prev === "tens" && !!w?.small && value < 10));
    if (!joins) flush();
    if (!group) group = { total: 0, cur: 0, prev: null, ws: "" };
    group.cur += value;
    group.prev = digit !== null ? "digit" : w!.additive ? "additive" : w!.tens ? "tens" : "plain";
    group.ws = "";
  }
  flush();
  return out.join("");
}

// ---- Vocabulary ------------------------------------------------------------------

type ItemRule = { category: Category; label: string; words: string[] };

// Checked in order: the vehicle or machine beats the goods it moved ("tractor for bricks" is transport).
const ITEMS = ([
  { category: "transport", label: "Lorry hire", words: ["lorry", "truck", "tipper", "ലോറി", "ടിപ്പര്"] },
  { category: "transport", label: "Tractor trolley", words: ["tractor", "ട്രാക്ടര്"] },
  { category: "transport", label: "Pickup van", words: ["pickup", "van", "tempo", "ടെമ്പോ", "പിക്കപ്പ്"] },
  { category: "transport", label: "Auto fare", words: ["auto", "autorickshaw", "ഓട്ടോ"] },
  { category: "transport", label: "Transport charges", words: ["transport", "delivery", "freight", "loading", "unloading", "vandi", "vandi kooli", "വണ്ടി", "ട്രാന്സ്പോര്ട്ട്", "കയറ്റിറക്ക്"] },
  { category: "equipment", label: "JCB hire", words: ["jcb", "ജെസിബി", "ജെ സി ബി"] },
  { category: "equipment", label: "Concrete mixer rental", words: ["mixer", "മിക്സര്"] },
  { category: "equipment", label: "Needle vibrator rental", words: ["vibrator", "വൈബ്രേറ്റര്"] },
  { category: "equipment", label: "Diesel", words: ["diesel", "petrol", "fuel", "ഡീസല്", "പെട്രോള്"] },
  { category: "equipment", label: "Generator rental", words: ["generator", "ജനറേറ്റര്"] },
  { category: "equipment", label: "Scaffolding rent", words: ["scaffolding", "scaffold", "സ്കാഫോള്ഡിംഗ്"] },
  { category: "equipment", label: "Equipment hire", words: ["crane", "hire", "rent", "rental", "ക്രെയിന്"] },
  { category: "labour", label: "Mason wages", words: ["mason", "masons", "kalppani", "മേസണ്", "മേസ്തിരി", "കല്പ്പണി"] },
  { category: "labour", label: "Helper wages", words: ["helper", "helpers", "ഹെല്പ്പര്"] },
  { category: "labour", label: "Carpenter wages", words: ["carpenter", "carpenters", "aashari", "ആശാരി"] },
  { category: "labour", label: "Plumber charges", words: ["plumber", "plumbers", "പ്ലംബര്"] },
  { category: "labour", label: "Electrician charges", words: ["electrician", "electricians", "ഇലക്ട്രീഷ്യന്"] },
  { category: "labour", label: "Labour wages", words: ["labour", "labor", "labours", "wage", "wages", "salary", "coolie", "kooli", "kuli", "panikkar", "ലേബര്", "കൂലി", "പണിക്കാര്", "പണിക്കൂലി", "ശമ്പളം", "വേതനം"] },
  { category: "materials", label: "Cement", words: ["cement", "simant", "സിമന്റ്", "സിമെന്റ്"] },
  { category: "materials", label: "TMT steel bars", words: ["steel", "tmt", "rod", "rods", "kambi", "കമ്പി", "സ്റ്റീല്"] },
  { category: "materials", label: "M-sand", words: ["m-sand", "msand", "m sand", "എം സാന്ഡ്", "എംസാന്ഡ്"] },
  { category: "materials", label: "Sand", words: ["sand", "manal", "മണല്", "സാന്ഡ്", "മണ്ണ്"] },
  { category: "materials", label: "Aggregate (jelly)", words: ["jelly", "aggregate", "metal", "ജെല്ലി", "മെറ്റല്"] },
  { category: "materials", label: "Bricks", words: ["brick", "bricks", "ishtika", "ഇഷ്ടിക", "ബ്രിക്സ്"] },
  { category: "materials", label: "Blocks", words: ["block", "blocks", "hollow block", "katta", "കട്ട", "ബ്ലോക്ക്"] },
  { category: "materials", label: "Tiles", words: ["tile", "tiles", "ടൈല്"] },
  { category: "materials", label: "Pipes and fittings", words: ["pipe", "pipes", "fitting", "fittings", "പൈപ്പ്"] },
  { category: "materials", label: "Binding wire and nails", words: ["wire", "nails", "nail", "aani", "ആണി", "വയര്"] },
  { category: "materials", label: "Paint and putty", words: ["paint", "putty", "primer", "പെയിന്റ്", "പുട്ടി"] },
  { category: "materials", label: "Wood and plywood", words: ["plywood", "shuttering", "wood", "timber", "maram", "പ്ലൈവുഡ്", "മരം", "തടി"] },
  { category: "other", label: "Tea and snacks", words: ["tea", "snacks", "food", "lunch", "chaya", "chai", "ചായ", "ഭക്ഷണം", "ഊണ്"] },
  { category: "other", label: "Permit fee", words: ["permit", "panchayat", "corporation", "പെര്മിറ്റ്", "പഞ്ചായത്ത്"] },
  { category: "other", label: "Site security", words: ["security", "watchman", "വാച്ച്മാന്"] },
  { category: "other", label: "Safety gear", words: ["helmet", "helmets", "gloves", "safety"] },
] satisfies ItemRule[]).map((r) => ({ ...r, test: re(r.words) }));

const ALL_ITEM_RE = re(ITEMS.flatMap((r) => r.words));
const ADVANCE_RE = re(["advance", "adv", "munkoor", "മുന്കൂര്", "അഡ്വാന്സ്"]);
/** "800 each": the amount is per worker, not shared. */
const EACH_RE = re(["each", "per head", "per person", "per worker", "aalukku", "orooruthar", "ഓരോരുത്തര്ക്കും", "ആളൊന്നിന്", "ആള്ക്ക്"]);

/** "advance" was said: the payment is an advance against future wages. */
export const advanceIn = (text: string) => ADVANCE_RE.test(normalize(text));
const LABOUR_WORDS = ITEMS.filter((r) => r.category === "labour").flatMap((r) => r.words);
const LABOUR_RE = re(LABOUR_WORDS, "gu");
const LABOUR_TEST = re(LABOUR_WORDS);

const UNITS: [string, string[]][] = [
  ["bags", ["bag", "bags", "bori", "chaakku", "chakku", "ചാക്ക്", "ബാഗ്", "ബോറി"]],
  ["loads", ["load", "loads", "ലോഡ്"]],
  ["tons", ["ton", "tons", "tonne", "tonnes", "t", "ടണ്"]],
  ["kg", ["kg", "kgs", "kilo", "kilos", "കിലോ"]],
  ["litres", ["litre", "litres", "liter", "liters", "l", "ltr", "ലിറ്റര്"]],
  ["cft", ["cft", "cubic feet", "cubic", "ക്യൂബിക്"]],
  ["sq ft", ["sqft", "sq ft", "square feet", "സ്ക്വയര് ഫീറ്റ്"]],
  ["ft", ["feet", "ft", "adi", "അടി"]],
  ["trips", ["trip", "trips", "ട്രിപ്പ്"]],
  ["days", ["day", "days", "divasam", "ദിവസം", "ദിവസത്തെ"]],
  ["hrs", ["hour", "hours", "hr", "hrs", "manikkoor", "മണിക്കൂര്"]],
  ["workers", ["workers", "people", "men", "persons", "aal", "aalukal", "ആള്", "ആളുകള്", "പേര്"]],
  ["nos", ["nos", "no", "numbers", "pieces", "piece", "pcs", "ennam", "എണ്ണം"]],
];
const UNIT_OF = new Map<string, string>();
for (const [unit, ws] of UNITS) for (const w of ws) UNIT_OF.set(normalize(w), unit);
const UNIT_SRC = words(UNITS.flatMap(([, w]) => w), { afterDigit: true });
const QTY_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT_SRC})`, "u");

const CURRENCY_BEFORE = `(?:₹|(?<![${L}])(?:rs\\.?|inr|rupees?))\\s*`;
const CURRENCY_AFTER = `\\s*(?:${words(["rupees", "rupee", "rs", "roopa", "rupa", "bucks", "രൂപ", "രൂപയ്ക്ക്"], { afterDigit: true })}|/-)`;
const MARKED_RE = new RegExp(`${CURRENCY_BEFORE}(\\d+(?:\\.\\d+)?)|(\\d+(?:\\.\\d+)?)${CURRENCY_AFTER}`, "gu");
const NUMBER_RE = /\d+(?:\.\d+)?/g;

const PAYMENTS: [PaymentMode, string[]][] = [
  ["upi", ["upi", "gpay", "g pay", "google pay", "phonepe", "phone pe", "paytm", "ജിപേ", "ഗൂഗിള് പേ", "യുപിഐ"]],
  ["cheque", ["cheque", "check", "ചെക്ക്"]],
  ["bank", ["neft", "rtgs", "imps", "bank", "transfer", "account", "ബാങ്ക്", "അക്കൗണ്ട്"]],
  ["credit", ["credit", "udhaar", "udhar", "kadam", "later", "pending", "കടം", "ക്രെഡിറ്റ്", "പിന്നീട്"]],
  ["cash", ["cash", "kaash", "rokkam", "ക്യാഷ്", "കാശ്", "രൊക്കം", "പണമായി"]],
];
const PAYMENT_RES = PAYMENTS.map(([mode, ws]) => [mode, re(ws)] as const);
const ALL_RE = re(["all", "everything", "ellam", "ellaam", "എല്ലാം", "എല്ലാ"]);

export function paymentIn(text: string): PaymentMode | null {
  const s = normalize(text);
  return PAYMENT_RES.find(([, r]) => r.test(s))?.[0] ?? null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const RELATIVE_DATES: [number, RegExp][] = [
  [-2, re(["day before yesterday", "minnale", "മിനിഞ്ഞാന്ന്", "മിനിയാന്ന്"])],
  [-1, re(["yesterday", "innale", "ഇന്നലെ"])],
  [0, re(["today", "innu", "ഇന്ന്"])],
];

/** A spoken date and the text it occupied. Day-only dates ("on the 18th") mean the latest such day not after today. */
export function dateIn(text: string, today: string): { date: string; text: string } | null {
  const s = normalize(text);
  for (const [days, r] of RELATIVE_DATES) {
    const m = s.match(r);
    if (m) return { date: shiftDate(today, days), text: m[0] };
  }
  const [ty, tm] = today.split("-").map(Number);
  const iso = (y: number, m: number, d: number) => {
    const v = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const t = new Date(`${v}T00:00:00Z`);
    return t.getUTCMonth() + 1 === m && t.getUTCDate() === d ? v : null;
  };
  const numeric = s.match(/(?<!\d)(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?(?!\d)/);
  if (numeric) {
    const [, d, m, y] = numeric;
    const year = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : Number(m) > tm ? ty - 1 : ty;
    const v = iso(year, Number(m), Number(d));
    if (v) return { date: v, text: numeric[0] };
  }
  const named = s.match(new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join("|")})[a-z]*|(${MONTHS.join("|")})[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)`));
  if (named) {
    const d = Number(named[1] ?? named[4]);
    const m = MONTHS.indexOf((named[2] ?? named[3]).slice(0, 3)) + 1;
    const v = iso(m > tm ? ty - 1 : ty, m, d);
    if (v) return { date: v, text: named[0] };
  }
  const dayOnly = s.match(/(?:on (?:the )?)(\d{1,2})(?:st|nd|rd|th)(?!\w)/);
  if (dayOnly) {
    const d = Number(dayOnly[1]);
    const [, , td] = today.split("-").map(Number);
    const v = d <= td ? iso(ty, tm, d) : iso(tm === 1 ? ty - 1 : ty, tm === 1 ? 12 : tm - 1, d);
    if (v) return { date: v, text: dayOnly[0] };
  }
  return null;
}

/** Every number in the text, as rupee strings, after spoken numbers become digits. Used to ground AI output. */
export function numbersIn(text: string): string[] {
  return [...digitsFor(normalize(text)).matchAll(NUMBER_RE)].map((m) => m[0]);
}

const STOP = new Set(
  [
    "for", "to", "the", "a", "an", "of", "paid", "pay", "gave", "give", "given", "and", "with", "by", "in", "on", "at",
    "is", "was", "rupees", "rupee", "rs", "site", "today", "yesterday", "amount", "total", "each", "per", "from", "also",
    "kodutthu", "koduthu", "kodukkanam", "nu", "inu", "kku", "um", "aanu", "ee", "aa",
    "കൊടുത്തു", "കൊടുക്കണം", "ആണ്", "ഈ", "ആ", "നു", "രൂപ", "സൈറ്റ്", "വാങ്ങി", "വാങ്ങിയത്",
  ].map(normalize),
);

const title = (s: string) => (isLatin(s) ? s.replace(/(^|[\s.])([a-z])/g, (_, p, c) => p + c.toUpperCase()) : s);

function findKnown(text: string, names: string[]) {
  for (const n of names) {
    const lower = normalize(n);
    if (new RegExp(words([lower]), "u").test(text)) return n;
  }
  for (const n of names) {
    const parts = normalize(n).split(/[\s(]+/).filter((p) => p.length > 3 && !GENERIC_NAME.has(p));
    if (parts.length && parts.some((p) => new RegExp(words([p]), "u").test(text))) return n;
  }
  return null;
}
const GENERIC_NAME = new Set(["traders", "trading", "sons", "hardware", "hardwares", "agencies", "enterprises", "stores", "suppliers", "builders", "steels", "cements", "co.", "company", "sri", "shree"]);

const isWordToken = (w: string) =>
  w.length >= 2 &&
  new RegExp(`^[${L}.]+$`, "u").test(w) &&
  !STOP.has(w) &&
  !ALL_ITEM_RE.test(w) &&
  !ADVANCE_RE.test(w) &&
  !EACH_RE.test(w) &&
  !UNIT_OF.has(w) &&
  !paymentIn(w) &&
  !dateIn(w, "2000-01-01") &&
  !numberWord(w) &&
  !ALL_RE.test(w);

/** "അനുവിന്" (to Anu) → "അനു". */
const stripCase = (w: string) => (isLatin(w) ? w : w.replace(/(?:വിന്|യിന്|ിന്|ക്ക്|യ്ക്ക്|ന്)$/u, "") || w);

/**
 * The people a labour payment went to: known workers named in the text, else the
 * words right before "labour"/"കൂലി" ("anu akhil labour"), else the word after it.
 */
function findWorkers(text: string, ctx: ParseContext): string[] {
  const known = ctx.workers
    .map((n) => ({ n, at: text.search(new RegExp(words([normalize(n), ...normalize(n).split(/[\s(]+/).filter((p) => p.length > 2).slice(0, 1)]), "u")) }))
    .filter((k) => k.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((k) => k.n);
  if (known.length) return [...new Set(known)];
  const to = text.match(new RegExp(`(?:^|\\s)to\\s+([${L}]+)`, "u"));
  if (to && isWordToken(to[1])) return [title(to[1])];
  const clean = (w: string) => stripCase(w.replace(/[^\p{L}\p{M}.]/gu, ""));
  for (const m of text.matchAll(LABOUR_RE)) {
    const before = text.slice(0, m.index).trim().split(/\s+/).map(clean);
    const names: string[] = [];
    for (let i = before.length - 1; i >= 0 && names.length < 6 && isWordToken(before[i]); i--) names.unshift(title(before[i]));
    if (names.length) return names;
    const after = clean(text.slice(m.index! + m[0].length).replace(/^[^\s]*\s*/, "").split(/\s+/)[0] ?? "");
    if (isWordToken(after)) return [title(after)];
  }
  if (ADVANCE_RE.test(text)) {
    const names = text.split(/\s+/).map(clean).filter(isWordToken);
    if (names.length) return [title(names[0])];
  }
  return [];
}

function findSupplier(text: string, ctx: ParseContext) {
  const known = findKnown(text, ctx.suppliers);
  if (known) return known;
  const m = text.match(new RegExp(`(?:^|\\s)(?:from|to)\\s+((?:[${L}.&]+\\s*){1,3})`, "u"));
  if (!m) return null;
  const name: string[] = [];
  for (const w of m[1].trim().split(/\s+/)) {
    if (!isWordToken(w)) break;
    name.push(w);
  }
  return name.length ? title(name.join(" ")) : null;
}

const GENERIC_SITE = new Set(["site", "house", "villa", "project", "building", "road", "phase", "home", "flat", "nagar"]);
const SITE_WORD_RE = new RegExp(`(?<![${L}])(?:site|സൈറ്റ്|സൈറ്റില്|സൈറ്റിലെ)\\s+([${L}\\d]+)`, "u");

/** A site named in the text: one of the user's sites, or the words heard if it matches none. */
function findSite(text: string, sites: SiteRef[]): { id?: string; heard: string; text: string } | null {
  // Text has had number words turned into digits, so "Site One" is heard as "site 1".
  for (const s of sites) {
    const n = normalize(s.name);
    const m = text.match(new RegExp(words([n, digitsFor(n)]), "u"));
    if (m) return { id: s.id, heard: s.name, text: m[0] };
  }
  for (const s of sites) {
    const parts = normalize(s.name).split(/\s+/).filter((w) => w.length > 3 && !GENERIC_SITE.has(w));
    for (const p of parts) {
      const m = text.match(new RegExp(words([p]), "u"));
      if (m) return { id: s.id, heard: s.name, text: m[0] };
    }
  }
  const m = text.match(SITE_WORD_RE);
  return m ? { heard: title(m[0].trim()), text: m[0] } : null;
}

// ---- Fragments -------------------------------------------------------------------

type Analysis = {
  raw: string;
  sentence: number;
  site: { id?: string; heard: string; text: string } | null;
  date: string | null;
  /** The date opened the fragment ("yesterday, cement…"), so it carries on to what follows. */
  dateLeads: boolean;
  payment: PaymentMode | null;
  paymentForAll: boolean;
  item: { category: Category; label: string } | null;
  quantity: string | null;
  unit: string | null;
  marked: string[];
  numbers: string[];
  workers: string[];
  /** The amount is per worker ("each"). */
  each: boolean;
  advance: boolean;
  supplier: string | null;
  leftover: string;
  /** The fragment is only names ("anu, akhil and…"), waiting for the labour entry they belong to. */
  namesOnly: string[];
};

const SENTENCE_SPLIT = /(?:[.!?;।]+(?=\s|$)|\n)+/u;
const CONJ_SPLIT = new RegExp(
  `\\s+(?:${["and then", "and also", "and", "then", "also", "plus", "pinne", "koodathe", "പിന്നെ", "കൂടാതെ", "അതുപോലെ"].map((w) => esc(normalize(w))).join("|")})\\s+|\\s*&\\s*|\\s*,\\s*`,
  "u",
);

const money = (n: string) => paiseToRupees(toPaise(n) ?? 0);

function analyze(raw: string, sentence: number, ctx: ParseContext): Analysis {
  let s = digitsFor(raw);
  const site = findSite(s, ctx.sites);
  if (site) s = s.replace(site.text, " ");
  const date = dateIn(s, ctx.today);
  const dateLeads = !!date && s.trimStart().startsWith(date.text);
  if (date) s = s.replace(date.text, " ");

  const qty = s.match(QTY_RE);
  if (qty) s = s.replace(qty[0], " ");

  const marked: string[] = [];
  s = s.replace(MARKED_RE, (_, a, b) => {
    marked.push(a ?? b);
    return " ";
  });
  const numbers: string[] = [];
  s = s.replace(NUMBER_RE, (n) => {
    numbers.push(n);
    return " ";
  });

  const advance = ADVANCE_RE.test(s);
  const item = ITEMS.find((r) => r.test.test(s)) ?? (advance ? { category: "labour" as const, label: "Advance" } : null);
  const payment = paymentIn(s);
  const workers = item?.category === "labour" || (!item && LABOUR_TEST.test(s)) ? findWorkers(s, ctx) : [];
  const supplier = item && item.category !== "labour" ? findSupplier(s, ctx) : null;

  const tokens = s.split(/\s+/).filter(isWordToken);
  const named = new Set(workers.map((w) => normalize(w)));
  const leftover = tokens.filter((w) => !named.has(w) && !(supplier && normalize(supplier).includes(w))).join(" ");
  const bare = !item && !numbers.length && !marked.length && !qty && !site && !date && !payment;
  const namesOnly = bare && tokens.length >= 1 && tokens.length <= 3 ? tokens.map((t) => findKnown(t, ctx.workers) ?? title(stripCase(t))) : [];

  return {
    raw,
    sentence,
    site,
    date: date?.date ?? null,
    dateLeads,
    payment,
    paymentForAll: !!payment && ALL_RE.test(s),
    item: item && { category: item.category, label: item.label },
    quantity: qty ? qty[1] : null,
    unit: qty ? (UNIT_OF.get(qty[2]) ?? qty[2]) : null,
    marked: marked.filter((n) => toPaise(n)),
    numbers: numbers.filter((n) => toPaise(n)),
    workers,
    each: EACH_RE.test(s),
    advance,
    supplier,
    leftover,
    namesOnly,
  };
}

/** Splits "anu labour 1000 akhil labour 800" after each amount that is followed by another item or name. */
function splitRuns(fragment: string, ctx: ParseContext): string[] {
  const s = digitsFor(fragment);
  const amountEnd = new RegExp(`(?:${CURRENCY_BEFORE})?\\d+(?:\\.\\d+)?(?![\\d.])(?!\\s*(?:${UNIT_SRC}))(?:${CURRENCY_AFTER})?`, "gu");
  const cuts: number[] = [];
  for (const m of s.matchAll(amountEnd)) {
    const end = m.index! + m[0].length;
    const rest = s.slice(end);
    if (!/\d/.test(rest)) continue;
    if (ALL_ITEM_RE.test(rest) || findKnown(rest, ctx.workers) || findKnown(rest, ctx.suppliers)) cuts.push(end);
  }
  if (!cuts.length) return [s];
  const parts: string[] = [];
  let start = 0;
  for (const c of cuts) {
    parts.push(s.slice(start, c));
    start = c;
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

export function parseTranscript(transcript: string, ctx: ParseContext): VoiceDraft[] {
  const text = normalize(transcript);
  const fragments: { raw: string; sentence: number }[] = [];
  text.split(SENTENCE_SPLIT).forEach((sentence, i) => {
    for (const part of sentence.split(CONJ_SPLIT)) {
      if (!part?.trim()) continue;
      for (const run of splitRuns(part.trim(), ctx)) fragments.push({ raw: run, sentence: i });
    }
  });

  type Building = VoiceDraft & { sentence: number; awaitingAmount: boolean; workers: string[]; each: boolean };
  const out: Building[] = [];
  /** Names said before the labour entry they belong to: "Anu, Akhil and Ravi labour 900 each". */
  let pendingNames: string[] = [];
  const context: { siteId?: string; siteHeard?: string; date?: string; payment?: PaymentMode } = {};

  const siteFor = (a: Analysis) => {
    const site = a.site ?? (context.siteHeard ? { id: context.siteId, heard: context.siteHeard } : null);
    if (!site) return { siteId: ctx.defaultSiteId, siteHeard: null };
    // Saying the site that is already picked needs no confirmation; anything else does.
    if (site.id === ctx.defaultSiteId) return { siteId: ctx.defaultSiteId, siteHeard: null };
    return { siteId: site.id ?? ctx.defaultSiteId, siteHeard: site.heard };
  };

  for (const f of fragments) {
    const a = analyze(f.raw, f.sentence, ctx);
    const amounts = a.marked.length ? a.marked : a.numbers;
    const last = out.at(-1);
    const sameSentence = last && last.sentence === a.sentence;

    // Context only: a site, a date, a payment mode or names on their own.
    if (!a.item && !amounts.length && !a.quantity) {
      if (a.namesOnly.length) pendingNames.push(...a.namesOnly);
      if (a.each && last) last.each = true;
      if (a.site) {
        context.siteId = a.site.id;
        context.siteHeard = a.site.heard;
      }
      if (a.date) {
        if (sameSentence && !last.dateSaid) Object.assign(last, { date: a.date, dateSaid: true });
        else context.date = a.date;
      }
      if (a.payment) {
        if (a.paymentForAll) {
          for (const d of out) d.paymentMode ??= a.payment;
          context.payment = a.payment;
        } else if (sameSentence && !last.paymentMode) last.paymentMode = a.payment;
        else context.payment = a.payment;
      }
      continue;
    }

    const amount = amounts.length === 1 ? money(amounts[0]) : null;
    const choices = amounts.length > 1 ? [...new Set(amounts.map(money))] : [];

    // "20 bags cement, 8,000 rupees": the amount arrives in the next fragment.
    if (last?.awaitingAmount && !a.item && amounts.length) {
      Object.assign(last, {
        amount,
        amountChoices: choices,
        awaitingAmount: false,
        heard: `${last.heard}, ${a.raw}`,
      });
      last.paymentMode ??= a.payment;
      last.quantity ??= a.quantity;
      last.unit ??= a.unit;
      last.each ||= a.each;
      if (a.date && !last.dateSaid) Object.assign(last, { date: a.date, dateSaid: true });
      continue;
    }
    // "8000 for cement": the item arrives after the amount.
    if (last && !last.category && !last.description && last.amount && a.item && !amounts.length && sameSentence) {
      Object.assign(last, {
        category: a.item.category,
        description: a.item.label,
        workers: a.workers,
        labourKind: a.advance ? "advance" : null,
        supplier: a.supplier,
        heard: `${last.heard}, ${a.raw}`,
      });
      last.quantity ??= a.quantity;
      last.unit ??= a.unit;
      continue;
    }
    if (!a.item && !amounts.length) continue;

    const site = siteFor(a);
    // A site, or a date that opens the sentence, holds for the entries after it.
    if (a.site) {
      context.siteId = a.site.id;
      context.siteHeard = a.site.heard;
    }
    if (a.date && a.dateLeads) context.date = a.date;
    const workers = a.item?.category === "labour" ? [...new Set([...pendingNames, ...a.workers])] : [];
    pendingNames = [];
    out.push({
      key: draftKey(),
      siteId: site.siteId,
      siteHeard: site.siteHeard,
      siteConfirmed: false,
      date: a.date ?? context.date ?? ctx.today,
      dateSaid: !!(a.date ?? context.date),
      category: a.item?.category ?? null,
      description: a.item?.label ?? capitalise(a.leftover),
      amount,
      amountChoices: choices,
      quantity: a.quantity,
      unit: a.unit,
      worker: null,
      workers,
      each: a.each,
      labourKind: a.advance ? "advance" : null,
      supplier: a.supplier,
      paymentMode: a.payment ?? context.payment ?? null,
      shareGroup: null,
      shareTotal: null,
      heard: a.raw,
      sentence: a.sentence,
      awaitingAmount: !!a.item && !amounts.length,
    });
  }

  // One entry per worker. "800 each" repeats the amount; one amount for several
  // people is a shared total that the user splits, because how it splits wasn't said.
  return out.flatMap((d) => {
    const { sentence, awaitingAmount, workers, each, ...draft } = d;
    void sentence;
    void awaitingAmount;
    const kind = draft.category === "labour" ? (draft.labourKind ?? (workers.length ? "wage" : null)) : null;
    if (workers.length <= 1) return [{ ...draft, worker: workers[0] ?? null, labourKind: kind }];
    const shared = !each && (draft.amount || draft.amountChoices.length);
    const group = shared ? draft.key : null;
    return workers.map((worker, i) => ({
      ...draft,
      key: i === 0 ? draft.key : draftKey(),
      worker,
      labourKind: kind,
      amount: shared ? null : draft.amount,
      amountChoices: shared ? [] : draft.amountChoices,
      shareGroup: group,
      shareTotal: shared ? draft.amount : null,
    }));
  });
}

function capitalise(s: string) {
  const t = s.trim();
  return t ? title(t[0]) + t.slice(1) : "";
}

/** A site named anywhere in the text (see findSite). */
export function siteIn(text: string, sites: SiteRef[]) {
  return findSite(digitsFor(normalize(text)), sites);
}
