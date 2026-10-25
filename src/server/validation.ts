import { z } from "zod";
import { SITE_ROLES } from "@/lib/permissions";
import { MAX_RECEIPT_BYTES } from "@/lib/types";

/**
 * Shared input schemas. Money and quantities stay strings end to end so no
 * float rounding ever touches a stored amount; Postgres does the arithmetic.
 */

export const CATEGORY_CODES = ["materials", "labour", "transport", "equipment", "other"] as const;
export const PAYMENT_METHODS = ["cash", "upi", "bank", "cheque", "credit"] as const;
export const SITE_STATUSES = ["active", "on_hold", "completed"] as const;
export const EXPENSE_SOURCES = ["manual", "voice", "bill_payment", "import", "purchase"] as const;
export const LABOUR_KINDS = ["wage", "advance"] as const;

const MAX_MONEY = 1_00_00_00_000; // ₹100 crore per value is a sanity ceiling, not a business rule.

export const moneyString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim().replace(/,/g, ""))
  .refine((v) => /^\d{1,12}(\.\d{1,2})?$/.test(v), "Enter an amount in rupees with at most 2 decimals.")
  .refine((v) => Number(v) <= MAX_MONEY, "That amount is too large.");

export const positiveMoney = moneyString.refine((v) => Number(v) > 0, "Enter an amount above ₹0.");

export const quantityString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim().replace(/,/g, ""))
  .refine((v) => /^\d{1,9}(\.\d{1,3})?$/.test(v), "Quantity can have at most 3 decimals.")
  .refine((v) => Number(v) > 0, "Quantity must be above 0.");

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the yyyy-mm-dd date format.")
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "That date doesn't exist.");

export const uuid = z.uuid("Invalid id.");

const trimmed = (max: number, label: string) =>
  z.string().trim().min(1, `${label} is required.`).max(max, `${label} is too long.`);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

// ---- Sites ------------------------------------------------------------------

export const siteInput = z.object({
  name: trimmed(120, "Site name"),
  location: trimmed(200, "Location"),
  clientName: optionalText(120),
  budget: moneyString,
  startDate: isoDate,
  status: z.enum(SITE_STATUSES).default("active"),
  /** Org member assigned as site engineer; optional. */
  engineerUserId: z.string().min(1).optional(),
});
export type SiteInput = z.input<typeof siteInput>;

export const siteUpdateInput = siteInput.extend({ id: uuid });

// ---- People ------------------------------------------------------------------

export const siteMemberRoleInput = z.object({
  siteId: uuid,
  userId: z.string().min(1).max(100),
  role: z.enum(SITE_ROLES),
});

const email = z.email("Enter a valid email address.").max(254).transform((v) => v.trim().toLowerCase());
const siteIdList = z
  .array(uuid)
  .max(100)
  .transform((ids) => [...new Set(ids)]);

/** An assistant engineer account the admin creates. They set their own password through a link. */
export const accountInput = z.object({
  name: trimmed(80, "Full name"),
  email,
  siteIds: siteIdList.refine((ids) => ids.length > 0, "Pick at least one site."),
});

export const accountSitesInput = z.object({ userId: z.string().min(1).max(100), siteIds: siteIdList });

export const accountActiveInput = z.object({ userId: z.string().min(1).max(100), active: z.boolean() });

/** Password links carry 32 random bytes, base64url: exactly 43 characters. */
export const passwordLinkToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "This link is invalid.");

export const newPassword = z
  .string()
  .min(8, "Use at least 8 characters.")
  .max(128, "Use at most 128 characters.");

export const setPasswordInput = z
  .object({ token: passwordLinkToken, password: newPassword, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { message: "The passwords don't match.", path: ["confirm"] });

export const bootstrapAdminInput = z.object({
  email,
  name: trimmed(80, "Admin name"),
  organizationName: trimmed(120, "Organization name"),
});

// ---- Expenses ---------------------------------------------------------------

export const expenseItemInput = z.object({
  description: trimmed(200, "Item description"),
  quantity: quantityString.default("1"),
  unit: z.string().trim().min(1).max(20).default("nos"),
  unitPrice: moneyString,
});

export const expenseInput = z
  .object({
    siteId: uuid,
    categoryCode: z.enum(CATEGORY_CODES),
    expenseDate: isoDate,
    description: trimmed(200, "Description"),
    paymentMethod: z.enum(PAYMENT_METHODS).default("cash"),
    source: z.enum(["manual", "voice"]).default("manual"),
    supplierName: optionalText(120),
    workerName: optionalText(120),
    labourKind: z.enum(["wage", "advance"]).optional(),
    voiceTranscript: optionalText(4000),
    notes: optionalText(1000),
    items: z.array(expenseItemInput).min(1, "Add at least one item.").max(50),
    /** For an assistant engineer: send it for approval now instead of keeping a draft. Ignored for everyone else. */
    submit: z.boolean().optional(),
  })
  .refine((e) => e.items.some((i) => Number(i.quantity) * Number(i.unitPrice) > 0), {
    message: "The expense total must be above ₹0.",
    path: ["items"],
  });
export type ExpenseInput = z.input<typeof expenseInput>;

export const expenseUpdateInput = z.intersection(expenseInput, z.object({ id: uuid }));

export const expenseBatchInput = z.object({
  expenses: z.array(expenseInput).min(1).max(25),
});

// ---- Voice entry --------------------------------------------------------------

export const VOICE_LANGUAGES = ["ml", "en"] as const;
const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

export const voiceParseInput = z.object({
  siteId: uuid,
  transcript: z.string().trim().min(1, "Say or type what you paid for.").max(4000, "That's too long. Split it into a few entries."),
  language: z.enum(VOICE_LANGUAGES),
});

/** A draft as the user left it after review. Missing values stay null; the data layer decides if it can be saved. */
export const voiceDraftInput = z.object({
  key: z.string().max(64),
  siteId: z.string().max(64),
  date: isoDate,
  dateSaid: z.boolean(),
  category: z.enum(CATEGORY_CODES).nullable(),
  description: z.string().trim().max(200, "Description is too long."),
  amount: nullableText(20),
  amountChoices: z.array(z.string().max(20)).max(10),
  quantity: nullableText(20),
  unit: nullableText(20),
  worker: nullableText(120),
  labourKind: z.enum(LABOUR_KINDS).nullable().default(null),
  supplier: nullableText(120),
  paymentMode: z.enum(PAYMENT_METHODS).nullable(),
  shareGroup: nullableText(64),
  shareTotal: nullableText(20),
  siteHeard: nullableText(120),
  siteConfirmed: z.boolean(),
  heard: z.string().max(4000),
});

export const voiceReviewInput = z.object({
  transcript: z.string().trim().max(4000).optional().transform((v) => v || undefined),
  language: z.enum(VOICE_LANGUAGES),
  extractor: z.enum(["rules", "claude", "manual"]),
  /** The transcript came from the microphone (saved as source "voice"), not typed. */
  spoken: z.boolean(),
  entries: z.array(voiceDraftInput).min(1, "There's nothing to save yet.").max(25, "Save at most 25 entries at a time."),
});

export const voiceSaveInput = voiceReviewInput.extend({
  /** One per review; retries reuse it so a save happens at most once. */
  clientKey: uuid,
  /** Indexes of entries the user chose to save even though they look like duplicates. */
  acknowledgedDuplicates: z.array(z.number().int().min(0).max(24)).max(25).default([]),
  /** When the entries were captured on the device (an offline draft may sync much later). */
  capturedAt: z.iso.datetime({ offset: true }).optional(),
  /** For an assistant engineer: confirmed voice entries go for approval unless kept as drafts. */
  submit: z.boolean().default(true),
});

export const pageInput = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const expenseFilters = pageInput.extend({
  siteId: uuid.optional(),
  categoryCode: z.enum(CATEGORY_CODES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  workerName: optionalText(120),
  supplierName: optionalText(120),
  source: z.enum(EXPENSE_SOURCES).optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  q: optionalText(100),
  sort: z.enum(["date_desc", "date_asc", "amount_desc", "amount_asc"]).default("date_desc"),
});
export type ExpenseFilters = z.input<typeof expenseFilters>;

// ---- Approvals ----------------------------------------------------------------

export const EXPENSE_STATUSES = ["draft", "pending_approval", "approved", "rejected"] as const;

export const myExpensesInput = pageInput.extend({ status: z.enum(EXPENSE_STATUSES).optional() });

export const reviewQueueInput = pageInput.extend({
  siteId: uuid.optional(),
  status: z.enum(["pending_approval", "rejected"]).default("pending_approval"),
});

export const expenseReviewInput = z
  .object({
    id: uuid,
    decision: z.enum(["approve", "reject"]),
    /** The reason when rejecting (required), or an optional note when approving. */
    note: optionalText(500),
  })
  .refine((r) => r.decision === "approve" || !!r.note, { message: "Give a reason for rejecting it.", path: ["note"] });

export const expenseReopenInput = z.object({ id: uuid, reason: trimmed(500, "Reason") });

// ---- Budgets ----------------------------------------------------------------

export const budgetInput = z.object({
  siteId: uuid,
  categoryCode: z.enum(CATEGORY_CODES).nullable().default(null),
  amount: moneyString,
  /** Alert once spending reaches this percentage of the budget. */
  alertPercent: z.coerce.number().int("Use a whole percentage.").min(1, "Use 1 to 100%.").max(100, "Use 1 to 100%.").default(80),
  note: optionalText(500),
});

export const budgetRemoveInput = z.object({ siteId: uuid, categoryCode: z.enum(CATEGORY_CODES) });

/** Dashboard filters: a date range (default this month), one site or all, and a search. */
export const analyticsFilters = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    siteId: uuid.optional(),
    q: optionalText(100),
  })
  .refine((f) => !f.from || !f.to || f.from <= f.to, { message: "The start date is after the end date.", path: ["from"] });

// ---- Bills, payments, receipts ---------------------------------------------

export const billInput = z
  .object({
    siteId: uuid,
    supplierName: trimmed(120, "Supplier"),
    billNumber: z.string().trim().max(60).optional().transform((v) => v || undefined),
    billDate: isoDate,
    dueDate: isoDate,
    amount: positiveMoney,
    categoryCode: z.enum(CATEGORY_CODES).default("materials"),
    description: optionalText(500),
  })
  .refine((b) => b.dueDate >= b.billDate, { message: "Due date is before the bill date.", path: ["dueDate"] });

export const paymentInput = z.object({
  billId: uuid,
  amount: positiveMoney,
  paidOn: isoDate,
  method: z.enum(PAYMENT_METHODS).default("bank"),
  reference: optionalText(120),
});

export const billFilters = pageInput.extend({
  siteId: uuid.optional(),
  status: z.enum(["all", "pending", "partial", "overdue", "paid"]).default("all"),
  q: optionalText(100),
});

// ---- Invoices ---------------------------------------------------------------

export const GST_RATES = ["0", "5", "12", "18", "28"] as const;

/** An invoice to the client for work on a site. The number is generated when left blank. */
export const clientInvoiceInput = z
  .object({
    siteId: uuid,
    invoiceNumber: z.string().trim().max(40).optional().transform((v) => v || undefined),
    invoiceDate: isoDate,
    dueDate: isoDate,
    clientName: trimmed(120, "Client name"),
    clientAddress: optionalText(300),
    clientPhone: optionalText(30),
    clientEmail: z
      .string()
      .trim()
      .max(254)
      .optional()
      .transform((v) => v?.toLowerCase() || undefined)
      .refine((v) => !v || z.email().safeParse(v).success, "Enter a valid email address."),
    clientGstin: z
      .string()
      .trim()
      .toUpperCase()
      .optional()
      .transform((v) => v || undefined)
      .refine((v) => !v || /^[0-9A-Z]{15}$/.test(v), "GSTIN has 15 letters and digits."),
    gstPercent: z.enum(GST_RATES, "Pick a GST rate.").default("0"),
    notes: optionalText(1000),
    items: z.array(expenseItemInput).min(1, "Add at least one item.").max(50),
  })
  .refine((i) => i.dueDate >= i.invoiceDate, { message: "Due date is before the invoice date.", path: ["dueDate"] })
  .refine((i) => i.items.some((x) => Number(x.quantity) * Number(x.unitPrice) > 0), {
    message: "The invoice total must be above ₹0.",
    path: ["items"],
  });

const receivedBy = z.enum(PAYMENT_METHODS).refine((m) => m !== "credit", "Pick how the client paid.").default("bank");

/** The invoice's whole remaining balance, received at once. */
export const invoicePaidInput = z.object({
  id: uuid,
  paidOn: isoDate,
  method: receivedBy,
  reference: optionalText(120),
  clientKey: uuid.optional(),
});

export const invoiceCancelInput = z.object({ id: uuid, reason: trimmed(300, "Reason") });

export const INVOICE_STATUSES = ["all", "unpaid", "overdue", "paid", "cancelled"] as const;

export const invoiceFilters = pageInput.extend({
  siteId: uuid.optional(),
  status: z.enum(INVOICE_STATUSES).default("all"),
  q: optionalText(100),
});

// ---- Client payments (receipts) --------------------------------------------------

/** Money received from the client against an invoice. `clientKey` makes a retried submit return the same receipt. */
export const clientPaymentInput = z.object({
  invoiceId: uuid,
  amount: positiveMoney,
  paidOn: isoDate,
  method: receivedBy,
  reference: optionalText(120),
  notes: optionalText(500),
  clientKey: uuid,
});

/** Money received without an invoice: a standalone receipt on one site, from whoever paid. */
export const standaloneReceiptInput = z.object({
  siteId: uuid,
  receivedFrom: trimmed(200, "Received from"),
  amount: positiveMoney,
  paidOn: isoDate,
  method: receivedBy,
  reference: optionalText(120),
  notes: optionalText(500),
  clientKey: uuid,
});

/** Money given back against one payment (refund, any part of it), or the whole payment undone (reversal). */
export const clientRefundInput = z
  .object({
    paymentId: uuid,
    kind: z.enum(["refund", "reversal"]),
    amount: positiveMoney.optional(),
    paidOn: isoDate,
    method: receivedBy,
    reference: optionalText(120),
    reason: trimmed(500, "Reason"),
    clientKey: uuid,
  })
  .refine((r) => r.kind === "reversal" || r.amount, { message: "Enter the amount refunded.", path: ["amount"] });

export const RECEIPT_STAGES = ["all", "advance", "part", "final", "general", "refund", "reversal"] as const;

export const receiptFilters = pageInput
  .extend({
    siteId: uuid.optional(),
    invoiceId: uuid.optional(),
    stage: z.enum(RECEIPT_STAGES).default("all"),
    from: isoDate.optional(),
    to: isoDate.optional(),
    q: optionalText(100),
  })
  .refine((f) => !f.from || !f.to || f.from <= f.to, { message: "The start date is after the end date.", path: ["from"] });

/** Company details printed on invoices and receipts. Blank clears a field. */
export const organizationProfileInput = z.object({
  address: optionalText(300),
  phone: optionalText(30),
  email: z
    .string()
    .trim()
    .max(254)
    .optional()
    .transform((v) => v?.toLowerCase() || undefined)
    .refine((v) => !v || z.email().safeParse(v).success, "Enter a valid email address."),
  website: optionalText(120),
});

/** A worker's wage invoice for a period on one site, built from attendance and payments. */
export const labourInvoiceInput = z
  .object({ siteId: uuid, workerId: uuid, from: isoDate, to: isoDate })
  .refine((f) => f.from <= f.to, { message: "The start date is after the end date.", path: ["from"] });

export const RECEIPT_TYPES =["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"] as const;
export { MAX_RECEIPT_BYTES };

export const receiptMeta = z
  .object({
    siteId: uuid,
    expenseId: uuid.optional(),
    supplierBillId: uuid.optional(),
    fileName: trimmed(200, "File name"),
    contentType: z.enum(RECEIPT_TYPES, "Upload a PDF, JPG, PNG, WebP or HEIC file."),
    sizeBytes: z.number().int().positive().max(MAX_RECEIPT_BYTES, "Files must be under 4 MB."),
    captureSource: z.enum(["camera", "file"]).optional(),
  })
  .refine((r) => r.expenseId || r.supplierBillId, { message: "A receipt must belong to an expense or a bill." })
  .refine((r) => !(r.expenseId && r.supplierBillId), { message: "A receipt belongs to an expense or a bill, not both." });

/** What a person confirms a receipt says. Every field optional: confirm only what you checked. */
export const receiptConfirmInput = z.object({
  id: uuid,
  supplier: optionalText(120),
  billNumber: optionalText(60),
  date: isoDate.optional(),
  amount: positiveMoney.optional(),
});

export const receiptRemoveInput = z.object({ id: uuid, reason: trimmed(300, "Reason") });

// ---- Labour, suppliers ------------------------------------------------------

export const workerInput = z.object({
  name: trimmed(120, "Name"),
  trade: optionalText(60),
  phone: optionalText(30),
  dailyWage: moneyString.optional(),
});

export const workerUpdateInput = workerInput.extend({ id: uuid, active: z.boolean().optional() });

// ---- Materials ----------------------------------------------------------------

export const materialInput = z.object({
  name: trimmed(120, "Material name"),
  unit: trimmed(20, "Unit"),
  defaultUnitPrice: moneyString.optional(),
});

export const materialUpdateInput = materialInput.extend({ id: uuid, active: z.boolean().default(true) });

export const purchaseInput = z
  .object({
    siteId: uuid,
    supplierName: optionalText(120),
    purchaseDate: isoDate,
    invoiceNumber: optionalText(60),
    deliveryRef: optionalText(60),
    /** "credit" records a supplier bill to pay later; anything else is paid now and saved as an expense. */
    paymentMethod: z.enum(PAYMENT_METHODS),
    dueDate: isoDate.optional(),
    notes: optionalText(500),
    items: z
      .array(z.object({ materialId: uuid, quantity: quantityString, unitPrice: moneyString }))
      .min(1, "Add at least one material.")
      .max(50),
  })
  .refine((p) => p.paymentMethod !== "credit" || p.supplierName, { message: "A purchase on credit needs the supplier.", path: ["supplierName"] })
  .refine((p) => p.paymentMethod !== "credit" || p.invoiceNumber, { message: "A purchase on credit needs the invoice number.", path: ["invoiceNumber"] })
  .refine((p) => !p.dueDate || p.dueDate >= p.purchaseDate, { message: "Due date is before the purchase date.", path: ["dueDate"] })
  .refine((p) => new Set(p.items.map((i) => i.materialId)).size === p.items.length, {
    message: "Each material can appear once per purchase.",
    path: ["items"],
  })
  .refine((p) => p.items.some((i) => Number(i.quantity) * Number(i.unitPrice) > 0), { message: "The purchase total must be above ₹0.", path: ["items"] });

export const voidInput = z.object({ id: uuid, reason: trimmed(300, "Reason") });

export const usageInput = z.object({
  siteId: uuid,
  materialId: uuid,
  usedOn: isoDate,
  quantity: quantityString,
  purpose: optionalText(200),
});

export const auditFilters = pageInput.extend({
  siteId: uuid.optional(),
  entityType: z.string().max(40).optional(),
  entityId: z.string().max(64).optional(),
});

const ATTENDANCE_STATUSES = ["present", "half_day", "absent"] as const;

/** One worker's day. The wage is never sent: the server derives it from the status and day rate. */
export const attendanceInput = z.object({
  siteId: uuid,
  workerId: uuid,
  workDate: isoDate,
  status: z.enum(ATTENDANCE_STATUSES).default("present"),
  workType: optionalText(60),
  /** Full-day rate; defaults to the worker's daily wage. */
  dayRate: moneyString.optional(),
  hours: z.string().regex(/^\d{1,2}(\.\d)?$/, "Hours like 8 or 7.5.").optional(),
});

export const attendanceBatchInput = z.object({
  siteId: uuid,
  workDate: isoDate,
  entries: z
    .array(attendanceInput.omit({ siteId: true, workDate: true }))
    .min(1, "Mark at least one worker.")
    .max(200)
    .refine((list) => new Set(list.map((e) => e.workerId)).size === list.length, "Each worker can be marked once per day."),
});

/** Cash to a worker: wages for work done, or an advance. Saved as a labour expense. */
export const labourPaymentInput = z.object({
  siteId: uuid,
  workerId: uuid,
  kind: z.enum(LABOUR_KINDS),
  amount: positiveMoney,
  paidOn: isoDate,
  method: z.enum(PAYMENT_METHODS).refine((m) => m !== "credit", "A payment to a worker can't be on credit.").default("cash"),
  note: optionalText(300),
});

export const supplierInput = z.object({
  name: trimmed(120, "Supplier name"),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9A-Z]{15}$/, "GSTIN has 15 letters and digits.")
    .optional(),
  phone: optionalText(30),
  address: optionalText(300),
});

// ---- Reports, preferences ---------------------------------------------------

export const reportFilters = expenseFilters.extend({
  from: isoDate,
  to: isoDate,
});

export const REPORT_KINDS = ["expenses", "categories", "purchases", "labour", "suppliers", "budget", "payments"] as const;
export const REPORT_FORMATS = ["xlsx", "pdf"] as const;

/** A downloadable report. Every filter is optional except the period; each report applies the ones that fit it. */
export const exportFilters = z
  .object({
    kind: z.enum(REPORT_KINDS),
    format: z.enum(REPORT_FORMATS),
    from: isoDate,
    to: isoDate,
    siteId: uuid.optional(),
    categoryCode: z.enum(CATEGORY_CODES).optional(),
    workerName: optionalText(120),
    supplierName: optionalText(120),
    paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  })
  .refine((f) => f.from <= f.to, { message: "The start date is after the end date.", path: ["from"] });
export type ExportFilters = z.infer<typeof exportFilters>;

export const preferencesInput = z.object({
  name: trimmed(80, "Name").optional(),
  phone: z
    .string()
    .trim()
    .refine((v) => v === "" || v.replace(/\D/g, "").length >= 10, "Enter a 10-digit mobile number.")
    .optional(),
  jobTitle: optionalText(80),
  language: z.enum(["en", "hi", "ml", "ta", "kn"]).optional(),
  dateFormat: z.enum(["dd/MM/yyyy", "d MMM yyyy", "yyyy-MM-dd"]).optional(),
  numberStyle: z.enum(["full", "compact"]).optional(),
});

/** First error message per field, for inline form errors. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
