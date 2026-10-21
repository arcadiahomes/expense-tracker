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

export type DateFormat = "dd/MM/yyyy" | "d MMM yyyy" | "yyyy-MM-dd";
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
