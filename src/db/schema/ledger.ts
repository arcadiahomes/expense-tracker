import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { constructionSites, organizations } from "./tenancy";

// Money is numeric(14,2) and travels as a string; sum it in SQL, never in JS floats.
const money = () => numeric({ precision: 14, scale: 2 });
const quantity = () => numeric({ precision: 12, scale: 3 });

export const paymentMethod = pgEnum("payment_method", ["cash", "upi", "bank", "cheque", "credit"]);
export const expenseSource = pgEnum("expense_source", ["manual", "voice", "bill_payment", "import", "purchase"]);
/** What a payment to a worker was: wages for work done, or an advance against future work. */
export const labourPaymentKind = pgEnum("labour_payment_kind", ["wage", "advance"]);
export const attendanceStatus = pgEnum("attendance_status", ["present", "half_day", "absent"]);
/**
 * An assistant engineer's expense is a draft until submitted, then waits for a site owner.
 * Only approved expenses are spend: every total, budget, balance and report filters on it.
 */
export const EXPENSE_STATUSES = ["draft", "pending_approval", "approved", "rejected"] as const;
export const expenseStatus = pgEnum("expense_status", EXPENSE_STATUSES);

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const expenseCategories = pgTable(
  "expense_categories",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    code: text().notNull(), // materials | labour | transport | equipment | other
    name: text().notNull(),
    sortOrder: smallint().notNull().default(0),
  },
  (t) => [unique().on(t.organizationId, t.code)],
);

/** One row per (site, category); category null is the site's overall budget. */
export const siteBudgets = pgTable(
  "site_budgets",
  {
    id: uuid().primaryKey().defaultRandom(),
    siteId: uuid()
      .notNull()
      .references(() => constructionSites.id, { onDelete: "cascade" }),
    categoryId: uuid().references(() => expenseCategories.id, { onDelete: "restrict" }),
    amount: money().notNull(),
    // Warn when spending reaches this share of the budget; over 100% is always an alert.
    alertPercent: smallint().notNull().default(80),
    note: text(),
    updatedBy: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique().on(t.siteId, t.categoryId).nullsNotDistinct(),
    check("site_budgets_amount_nonnegative", sql`${t.amount} >= 0`),
    check("site_budgets_alert_percent_range", sql`${t.alertPercent} between 1 and 100`),
  ],
);

export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text().notNull(),
    gstin: text(),
    phone: text(),
    address: text(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.organizationId, t.name)],
);

export const labourWorkers = pgTable(
  "labour_workers",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text().notNull(),
    trade: text(),
    phone: text(),
    dailyWage: money(),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.organizationId, t.name)],
);

export const supplierBills = pgTable(
  "supplier_bills",
  {
    id: uuid().primaryKey().defaultRandom(),
    siteId: uuid()
      .notNull()
      .references(() => constructionSites.id, { onDelete: "cascade" }),
    supplierId: uuid()
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    categoryId: uuid()
      .notNull()
      .references(() => expenseCategories.id, { onDelete: "restrict" }),
    billNumber: text().notNull(),
    billDate: date({ mode: "string" }).notNull(),
    dueDate: date({ mode: "string" }).notNull(),
    amount: money().notNull(),
    description: text(),
    createdBy: text()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique().on(t.supplierId, t.billNumber),
    index().on(t.siteId, t.dueDate),
    check("supplier_bills_amount_positive", sql`${t.amount} > 0`),
    check("supplier_bills_due_after_bill", sql`${t.dueDate} >= ${t.billDate}`),
  ],
);

export const expenses = pgTable(
  "expenses",
  {
    id: uuid().primaryKey().defaultRandom(),
    siteId: uuid()
      .notNull()
      .references(() => constructionSites.id, { onDelete: "cascade" }),
    categoryId: uuid()
      .notNull()
      .references(() => expenseCategories.id, { onDelete: "restrict" }),
    expenseDate: date({ mode: "string" }).notNull(),
    description: text().notNull(),
    // Always the sum of expense_items.amount; written by the server in the same transaction.
    totalAmount: money().notNull().default("0"),
    paymentMethod: paymentMethod().notNull().default("cash"),
    source: expenseSource().notNull().default("manual"),
    supplierId: uuid().references(() => suppliers.id, { onDelete: "set null" }),
    labourWorkerId: uuid().references(() => labourWorkers.id, { onDelete: "set null" }),
    // Set on payments to a worker; the worker's balance is attendance earned minus these.
    labourKind: labourPaymentKind(),
    supplierBillId: uuid().references(() => supplierBills.id, { onDelete: "set null" }),
    voiceTranscript: text(),
    notes: text(),
    createdBy: text()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Soft delete so "Undo" can restore; every read filters deleted_at is null.
    deletedAt: timestamp({ withTimezone: true }),
    // Set by the server only, never from input. Existing and directly entered expenses are approved.
    status: expenseStatus().notNull().default("approved"),
    submittedAt: timestamp({ withTimezone: true }),
    reviewedBy: text().references(() => users.id, { onDelete: "restrict" }),
    reviewedAt: timestamp({ withTimezone: true }),
    rejectionReason: text(),
    approvalNote: text(),
  },
  (t) => [
    index("expenses_site_date_idx").on(t.siteId, t.expenseDate.desc(), t.createdAt.desc()),
    // The approval queue, and each person's own submissions.
    index("expenses_pending_idx").on(t.siteId, t.submittedAt).where(sql`${t.status} = 'pending_approval' and ${t.deletedAt} is null`),
    index("expenses_creator_status_idx").on(t.createdBy, t.status),
    index().on(t.siteId, t.categoryId, t.expenseDate),
    index().on(t.supplierId),
    index().on(t.labourWorkerId),
    index().on(t.createdBy),
    check("expenses_total_nonnegative", sql`${t.totalAmount} >= 0`),
    // Each status carries what it means: submitted ones have a time, reviewed ones a reviewer, rejections a reason.
    check("expenses_submitted_has_time", sql`${t.status} = 'draft' or ${t.submittedAt} is not null`),
    check("expenses_reviewed_has_reviewer", sql`${t.status} not in ('approved', 'rejected') or (${t.reviewedBy} is not null and ${t.reviewedAt} is not null)`),
    check("expenses_rejected_has_reason", sql`${t.status} <> 'rejected' or length(btrim(${t.rejectionReason})) > 0`),
  ],
);

export const expenseItems = pgTable(
  "expense_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    expenseId: uuid()
      .notNull()
      .references(() => expenses.id, { onDelete: "cascade" }),
    position: smallint().notNull().default(0),
    description: text().notNull(),
    quantity: quantity().notNull().default("1"),
    unit: text().notNull().default("nos"),
    unitPrice: money().notNull(),
    amount: money()
      .notNull()
      .generatedAlwaysAs(
        (): SQL => sql`round(${expenseItems.quantity} * ${expenseItems.unitPrice}, 2)`,
      ),
  },
  (t) => [
    index().on(t.expenseId),
    check("expense_items_quantity_positive", sql`${t.quantity} > 0`),
    check("expense_items_unit_price_nonnegative", sql`${t.unitPrice} >= 0`),
  ],
);

export const labourAttendance = pgTable(
  "labour_attendance",
  {
    id: uuid().primaryKey().defaultRandom(),
    siteId: uuid()
      .notNull()
      .references(() => constructionSites.id, { onDelete: "cascade" }),
    workerId: uuid()
      .notNull()
      .references(() => labourWorkers.id, { onDelete: "restrict" }),
    workDate: date({ mode: "string" }).notNull(),
    status: attendanceStatus().notNull().default("present"),
    workType: text(),
    // Rate for a full day; wage_amount is derived from it and the status on the server.
    dayRate: money(),
    hours: numeric({ precision: 4, scale: 1 }),
    wageAmount: money().notNull().default("0"),
    // Legacy link, unused: wages are settled by balance (earned minus labour payments), not per day.
    expenseId: uuid().references(() => expenses.id, { onDelete: "set null" }),
    recordedBy: text()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.siteId, t.workerId, t.workDate),
    index().on(t.siteId, t.workDate),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: uuid().primaryKey().defaultRandom(),
    siteId: uuid()
      .notNull()
      .references(() => constructionSites.id, { onDelete: "cascade" }),
    supplierBillId: uuid().references(() => supplierBills.id, { onDelete: "cascade" }),
    expenseId: uuid().references(() => expenses.id, { onDelete: "set null" }),
    amount: money().notNull(),
    paidOn: date({ mode: "string" }).notNull(),
    method: paymentMethod().notNull(),
    reference: text(),
    createdBy: text()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.supplierBillId),
    index().on(t.siteId, t.paidOn),
    check("payments_amount_positive", sql`${t.amount} > 0`),
  ],
);

export const receipts = pgTable(
  "receipts",
  {
    id: uuid().primaryKey().defaultRandom(),
    siteId: uuid()
      .notNull()
      .references(() => constructionSites.id, { onDelete: "cascade" }),
    expenseId: uuid().references(() => expenses.id, { onDelete: "cascade" }),
    supplierBillId: uuid().references(() => supplierBills.id, { onDelete: "cascade" }),
    fileName: text().notNull(),
    contentType: text().notNull(),
    sizeBytes: integer().notNull(),
    sha256: text().notNull(),
    storageKey: text().notNull().unique(),
    uploadedBy: text()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    /** camera | file: how it was captured on the device. */
    captureSource: text(),
    pageCount: integer(),
    // Removed or replaced: the row stays for the audit trail, the stored file is deleted.
    deletedAt: timestamp({ withTimezone: true }),
    deletedBy: text().references(() => users.id, { onDelete: "set null" }),
    deleteReason: text(),
    replacesId: uuid().references((): AnyPgColumn => receipts.id, { onDelete: "set null" }),
    /** Suggestions read from the file (OCR). Never applied to records without a person confirming. */
    ocr: jsonb(),
    ocrStatus: text().notNull().default("none"), // none | done | failed | unsupported
    /** What a person confirmed the receipt says. */
    confirmed: jsonb(),
    confirmedAt: timestamp({ withTimezone: true }),
    confirmedBy: text().references(() => users.id, { onDelete: "set null" }),
    /** Possible duplicate of another receipt in the organization; flagged, never auto-removed. */
    duplicateOfId: uuid().references((): AnyPgColumn => receipts.id, { onDelete: "set null" }),
    duplicateReason: text(),
    duplicateAckAt: timestamp({ withTimezone: true }),
    duplicateAckBy: text().references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index().on(t.expenseId),
    index().on(t.supplierBillId),
    index().on(t.siteId),
    index().on(t.sha256),
    check(
      "receipts_has_parent",
      sql`${t.expenseId} is not null or ${t.supplierBillId} is not null`,
    ),
    check("receipts_size_positive", sql`${t.sizeBytes} > 0`),
  ],
);

/**
 * One confirmed voice entry save. The client sends the same key on every retry of
 * a review, so a double tap or a retry after a dropped connection returns the
 * expenses saved the first time instead of saving them again.
 */
export const voiceBatches = pgTable(
  "voice_batches",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdBy: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientKey: uuid().notNull(),
    // SHA-256 of the confirmed entries; a reused key with different entries is rejected.
    payloadHash: text().notNull(),
    transcript: text(),
    language: text().notNull(),
    extractor: text().notNull(), // rules | claude | manual
    /** When the entries were captured on the device; later than created_at never, earlier for synced offline drafts. */
    capturedAt: timestamp({ withTimezone: true }),
    expenseIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.createdBy, t.clientKey)],
);

// ---- Materials --------------------------------------------------------------

/** Org-wide catalog of materials, each measured in one unit. */
export const materials = pgTable(
  "materials",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text().notNull(),
    unit: text().notNull(),
    defaultUnitPrice: money(),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.organizationId, t.name), check("materials_price_nonnegative", sql`${t.defaultUnitPrice} >= 0`)],
);

/**
 * A delivery of materials to a site. The money lives elsewhere, exactly once:
 * paid on the spot it links an expense; on credit it links a supplier bill, and
 * the bill's payments become expenses.
 */
export const materialPurchases = pgTable(
  "material_purchases",
  {
    id: uuid().primaryKey().defaultRandom(),
    siteId: uuid()
      .notNull()
      .references(() => constructionSites.id, { onDelete: "cascade" }),
    supplierId: uuid().references(() => suppliers.id, { onDelete: "restrict" }),
    purchaseDate: date({ mode: "string" }).notNull(),
    invoiceNumber: text(),
    deliveryRef: text(),
    paymentMethod: paymentMethod().notNull(),
    totalAmount: money().notNull(),
    expenseId: uuid().references(() => expenses.id, { onDelete: "restrict" }),
    supplierBillId: uuid().references(() => supplierBills.id, { onDelete: "restrict" }),
    notes: text(),
    createdBy: text()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    voidedAt: timestamp({ withTimezone: true }),
    voidedBy: text().references(() => users.id, { onDelete: "restrict" }),
    voidReason: text(),
  },
  (t) => [
    index().on(t.siteId, t.purchaseDate),
    index().on(t.supplierId),
    // Exactly one money record while live; a voided credit purchase drops its (unpaid, deleted) bill.
    check(
      "material_purchases_money_link",
      sql`(${t.expenseId} is null) <> (${t.supplierBillId} is null) or (${t.voidedAt} is not null and ${t.expenseId} is null)`,
    ),
    check("material_purchases_total_positive", sql`${t.totalAmount} > 0`),
  ],
);

export const materialPurchaseItems = pgTable(
  "material_purchase_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    purchaseId: uuid()
      .notNull()
      .references(() => materialPurchases.id, { onDelete: "cascade" }),
    materialId: uuid()
      .notNull()
      .references(() => materials.id, { onDelete: "restrict" }),
    position: smallint().notNull().default(0),
    quantity: quantity().notNull(),
    unitPrice: money().notNull(),
    amount: money()
      .notNull()
      .generatedAlwaysAs((): SQL => sql`round(${materialPurchaseItems.quantity} * ${materialPurchaseItems.unitPrice}, 2)`),
  },
  (t) => [
    index().on(t.purchaseId),
    index().on(t.materialId),
    check("material_purchase_items_quantity_positive", sql`${t.quantity} > 0`),
    check("material_purchase_items_price_nonnegative", sql`${t.unitPrice} >= 0`),
  ],
);

/** Material taken out of a site's stock for work. Quantities only; the money was counted at purchase. */
export const materialUsage = pgTable(
  "material_usage",
  {
    id: uuid().primaryKey().defaultRandom(),
    siteId: uuid()
      .notNull()
      .references(() => constructionSites.id, { onDelete: "cascade" }),
    materialId: uuid()
      .notNull()
      .references(() => materials.id, { onDelete: "restrict" }),
    usedOn: date({ mode: "string" }).notNull(),
    quantity: quantity().notNull(),
    purpose: text(),
    createdBy: text()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    deletedAt: timestamp({ withTimezone: true }),
    deletedBy: text().references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [index().on(t.siteId, t.materialId), check("material_usage_quantity_positive", sql`${t.quantity} > 0`)],
);

// ---- Audit ------------------------------------------------------------------

/** Append-only record of every change to money, stock and people, written in the same transaction. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: uuid().references(() => constructionSites.id, { onDelete: "cascade" }),
    actorId: text().references(() => users.id, { onDelete: "set null" }),
    actorName: text().notNull(),
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: text().notNull(),
    summary: text().notNull(),
    data: jsonb(),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.organizationId, t.createdAt.desc()),
    index().on(t.siteId, t.createdAt.desc()),
    index().on(t.entityType, t.entityId),
  ],
);

/**
 * In-app notices: a submission waiting for a site owner, or a review result for the
 * person who submitted. Only ever read by their recipient.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    siteId: uuid().references(() => constructionSites.id, { onDelete: "cascade" }),
    kind: text().notNull(), // expense.submitted | expense.approved | expense.rejected | expense.reopened
    expenseId: uuid().references(() => expenses.id, { onDelete: "cascade" }),
    title: text().notNull(),
    body: text(),
    readAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.userId, t.organizationId, t.createdAt.desc()), index().on(t.expenseId)],
);

// ---- Client invoices --------------------------------------------------------

/**
 * What the company bills its client for work on a site. Money owed *to* the company,
 * so it never touches expenses, budgets or spend. Status (unpaid, overdue, paid,
 * cancelled) is derived in SQL from paid_on, cancelled_at and the due date.
 * Issued invoices aren't edited: cancel one (with a reason) and issue a new one.
 */
export const clientInvoices = pgTable(
  "client_invoices",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: uuid()
      .notNull()
      .references(() => constructionSites.id, { onDelete: "cascade" }),
    invoiceNumber: text().notNull(),
    invoiceDate: date({ mode: "string" }).notNull(),
    dueDate: date({ mode: "string" }).notNull(),
    clientName: text().notNull(),
    clientAddress: text(),
    clientGstin: text(),
    clientPhone: text(),
    clientEmail: text(),
    /** A rate the user entered (0 for none); the tax amount is worked out in SQL from the items. */
    gstPercent: numeric({ precision: 5, scale: 2 }).notNull().default("0"),
    notes: text(),
    createdBy: text()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    /**
     * Before client payments (migration 0015) an invoice was only ever paid in full, recorded
     * here. Those payments were copied into client_payments; nothing reads or writes these now.
     */
    paidOn: date({ mode: "string" }),
    paidMethod: paymentMethod(),
    paidReference: text(),
    paidBy: text().references(() => users.id, { onDelete: "set null" }),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelledBy: text().references(() => users.id, { onDelete: "set null" }),
    cancelReason: text(),
  },
  (t) => [
    unique().on(t.organizationId, t.invoiceNumber),
    index().on(t.siteId, t.invoiceDate),
    check("client_invoices_due_after_invoice", sql`${t.dueDate} >= ${t.invoiceDate}`),
    check("client_invoices_gst_range", sql`${t.gstPercent} between 0 and 28`),
    check("client_invoices_paid_has_method", sql`${t.paidOn} is null or ${t.paidMethod} is not null`),
    check("client_invoices_cancel_has_reason", sql`${t.cancelledAt} is null or length(btrim(${t.cancelReason})) > 0`),
    check("client_invoices_paid_or_cancelled", sql`${t.paidOn} is null or ${t.cancelledAt} is null`),
  ],
);

export const clientInvoiceItems = pgTable(
  "client_invoice_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    invoiceId: uuid()
      .notNull()
      .references(() => clientInvoices.id, { onDelete: "cascade" }),
    position: smallint().notNull().default(0),
    description: text().notNull(),
    quantity: quantity().notNull().default("1"),
    unit: text().notNull().default("nos"),
    unitPrice: money().notNull(),
    amount: money()
      .notNull()
      .generatedAlwaysAs((): SQL => sql`round(${clientInvoiceItems.quantity} * ${clientInvoiceItems.unitPrice}, 2)`),
  },
  (t) => [
    index().on(t.invoiceId),
    check("client_invoice_items_quantity_positive", sql`${t.quantity} > 0`),
    check("client_invoice_items_unit_price_nonnegative", sql`${t.unitPrice} >= 0`),
  ],
);

// ---- Client payments (receipts) ---------------------------------------------

/**
 * What a client paid against an invoice, or what was given back. Append-only: a trigger
 * (migration 0016) refuses updates and direct deletes, so a mistake is corrected with a
 * linked reversal, never by changing the record. Paid, balance and the invoice's "paid"
 * status are all summed from here in SQL. Income only: nothing here touches expenses.
 * - payment: money received; gets a receipt number (RCT/2026-27/0001).
 * - refund: money given back against one payment, up to what's left of it.
 * - reversal: the whole payment didn't happen (bounced cheque, entered twice); once per payment.
 * Refunds and reversals get their own series (RFD/2026-27/0001) and name the payment in related_id.
 */
export const CLIENT_PAYMENT_KINDS = ["payment", "refund", "reversal"] as const;
export const clientPaymentKind = pgEnum("client_payment_kind", CLIENT_PAYMENT_KINDS);

export const clientPayments = pgTable(
  "client_payments",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Entry order. Each receipt's "paid before" and "balance after" are as of its own seq. */
    seq: bigint({ mode: "number" }).generatedAlwaysAsIdentity().notNull().unique(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: uuid()
      .notNull()
      .references(() => constructionSites.id, { onDelete: "cascade" }),
    invoiceId: uuid()
      .notNull()
      .references(() => clientInvoices.id, { onDelete: "cascade" }),
    kind: clientPaymentKind().notNull(),
    receiptNumber: text().notNull(),
    amount: money().notNull(),
    paidOn: date({ mode: "string" }).notNull(),
    method: paymentMethod().notNull(),
    reference: text(),
    notes: text(),
    relatedId: uuid().references((): AnyPgColumn => clientPayments.id, { onDelete: "cascade" }),
    /** Sent by the form that recorded it, so a retried or double submit returns the same receipt. */
    clientKey: uuid().notNull(),
    createdBy: text()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.organizationId, t.receiptNumber),
    unique().on(t.organizationId, t.clientKey),
    index().on(t.invoiceId, t.seq),
    index().on(t.siteId, t.paidOn),
    index().on(t.relatedId),
    uniqueIndex("client_payments_one_reversal").on(t.relatedId).where(sql`kind = 'reversal'`),
    check("client_payments_amount_positive", sql`${t.amount} > 0`),
    check("client_payments_not_credit", sql`${t.method} <> 'credit'`),
    check("client_payments_related", sql`(${t.kind} = 'payment') = (${t.relatedId} is null)`),
    check("client_payments_refund_has_reason", sql`${t.kind} = 'payment' or length(btrim(${t.notes})) > 0`),
  ],
);
