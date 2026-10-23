/**
 * View-model types shared by server data functions and client views.
 * Amounts are numbers for display only: every total is computed in Postgres
 * from numeric(14,2) columns and converted at the edge.
 */

import type { SiteRole } from "./permissions";

/**
 * Largest receipt or bill file. Vercel refuses request bodies over 4.5 MB, so server
 * actions are capped just above this (`serverActions.bodySizeLimit` in next.config.ts).
 * Larger photos are shrunk in the browser before upload (`prepareFile`).
 */
export const MAX_RECEIPT_BYTES = 4_000_000;

export const CATEGORIES = [
  "materials",
  "labour",
  "transport",
  "equipment",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export type SiteStatus = "active" | "on-hold" | "completed";
export type { SiteRole };
export type OrgRole = "owner" | "admin" | "member";

export type Site = {
  id: string;
  name: string;
  location: string;
  client: string;
  /** Display name of the first engineer on the site, or "" when none. */
  engineer: string;
  engineerUserId: string | null;
  budget: number;
  startDate: string; // yyyy-mm-dd
  status: SiteStatus;
  /** The signed-in user's effective role on this site. */
  role: SiteRole;
};

export type PaymentMode = "cash" | "upi" | "bank" | "cheque" | "credit";
export type ExpenseSource = "manual" | "voice" | "bill_payment" | "import" | "purchase";
/** Only approved expenses count in totals, budgets, balances and reports. */
export type ExpenseStatus = "draft" | "pending_approval" | "approved" | "rejected";

export const EXPENSE_STATUS_LABEL: Record<ExpenseStatus, string> = {
  draft: "Draft",
  pending_approval: "Waiting for approval",
  approved: "Approved",
  rejected: "Rejected",
};

export type ExpenseItem = {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  amount: string;
};

export type Expense = {
  id: string;
  siteId: string;
  date: string; // yyyy-mm-dd
  category: Category;
  description: string;
  amount: number;
  /** Short quantity label for lists, e.g. "100 bags". */
  quantity?: string;
  items: ExpenseItem[];
  worker?: string;
  supplier?: string;
  paymentMode: PaymentMode;
  enteredBy: string;
  source: ExpenseSource;
  viaVoice?: boolean;
  /** Whether the signed-in user may edit or delete it. */
  canEdit: boolean;
  /** Live receipt files attached. */
  receipts: number;
  /** Whether the signed-in user may attach, replace or remove its receipts. */
  canManageReceipts: boolean;
  status: ExpenseStatus;
  submittedAt?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  rejectionReason?: string;
  approvalNote?: string;
  /** Whether the signed-in user may send it for approval (their own draft or rejected entry). */
  canSubmit: boolean;
  /** Whether the signed-in user may approve or reject it (a site owner, not the person who entered it). */
  canReview: boolean;
  /** Whether the signed-in user may send an approved, reviewed entry back for correction. */
  canReopen: boolean;
};

export type BillStatus = "paid" | "pending" | "partial" | "overdue";

export type Attachment = {
  id: string;
  name: string;
  size: number;
  kind: "pdf" | "image";
  url: string;
};

export type Bill = {
  id: string;
  billNo: string;
  supplier: string;
  siteId: string;
  date: string;
  dueDate: string;
  amount: number;
  paid: number;
  status: BillStatus;
  category: Category;
  description: string;
  attachment?: Attachment;
  canManage: boolean;
};

/** Derived in SQL: cancelled and paid are recorded; overdue is unpaid past the due date. */
export type InvoiceStatus = "unpaid" | "overdue" | "paid" | "cancelled";

export type ClientInvoiceItem = {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  amount: string;
};

export type ClientInvoice = {
  id: string;
  siteId: string;
  siteName: string;
  invoiceNo: string;
  date: string;
  dueDate: string;
  client: string;
  clientAddress: string;
  clientGstin: string;
  clientPhone: string;
  clientEmail: string;
  gstPercent: number;
  subtotal: number;
  gst: number;
  total: number;
  /** Payments less refunds and reversals, from client_payments. */
  paid: number;
  /** total − paid; the invoice is paid when this reaches 0. */
  balance: number;
  receipts: number;
  status: InvoiceStatus;
  notes: string;
  items: ClientInvoiceItem[];
  /** The latest payment's details, once the invoice is paid. */
  paidOn?: string;
  paidMethod?: PaymentMode;
  paidReference?: string;
  cancelReason?: string;
  createdBy: string;
};

export type ClientPaymentKind = "payment" | "refund" | "reversal";
/**
 * What a receipt is, from the invoice's balance around it: the first payment that leaves a
 * balance is an advance, later ones are part payments, the one that clears it is final.
 */
export type ReceiptStage = "advance" | "part" | "final" | "refund" | "reversal";

/** One entry in the client payments ledger. Every figure is summed in SQL as of this entry. */
export type ClientReceipt = {
  id: string;
  receiptNo: string;
  kind: ClientPaymentKind;
  stage: ReceiptStage;
  date: string;
  method: PaymentMode;
  reference: string;
  notes: string;
  amount: number;
  invoiceId: string;
  invoiceNo: string;
  invoiceTotal: number;
  siteId: string;
  siteName: string;
  client: string;
  /** Net paid on the invoice before this entry, and including it. */
  paidBefore: number;
  paidToDate: number;
  balanceAfter: number;
  /** For a refund or reversal: the payment it gives back. */
  related?: { id: string; receiptNo: string };
  /** For a payment: refunded or reversed against it since, and whether it was reversed. */
  refunded: number;
  reversed: boolean;
  createdBy: string;
};

/** Collections per site (project): invoiced, collected, given back and still to receive. */
export type ProjectCollection = {
  siteId: string;
  siteName: string;
  client: string;
  invoices: number;
  receipts: number;
  value: number;
  collected: number;
  refunded: number;
  outstanding: number;
};

export type OrganizationProfile = { name: string; address: string; phone: string; email: string; website: string };

export type LabourInvoiceLine = {
  date: string;
  kind: "attendance" | "wage" | "advance";
  description: string;
  /** Wage earned that day (attendance) or the amount paid (wage, advance); never negative. */
  amount: string;
};

/** A worker's wages for a period on one site. Every figure comes from SQL. */
export type LabourInvoice = {
  site: { id: string; name: string; location: string; client: string };
  worker: { id: string; name: string; trade: string; phone: string };
  from: string;
  to: string;
  days: string;
  /** Balance before the period: earned minus paid (negative is an advance not yet worked off). */
  opening: string;
  earned: string;
  wagesPaid: string;
  advances: string;
  /** opening + earned − wages − advances: what the site owes the worker at the end of the period. */
  closing: string;
  attendance: { date: string; status: "present" | "half_day"; workType: string; dayRate: string; amount: string }[];
  payments: LabourInvoiceLine[];
};

export type DateFormat ="dd/MM/yyyy" | "d MMM yyyy" | "yyyy-MM-dd";
export type NumberStyle = "full" | "compact";
export type Language = "en" | "hi" | "ml" | "ta" | "kn";

export type Settings = {
  name: string;
  phone: string;
  email: string;
  role: string;
  company: string;
  language: Language;
  dateFormat: DateFormat;
  numberStyle: NumberStyle;
};

export type Page<T> = { items: T[]; nextCursor: string | null };

/** Result shape every server action returns to forms. */
export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };
