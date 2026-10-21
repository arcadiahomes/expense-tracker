import "server-only";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { constructionSites, expenses, receipts, supplierBills, suppliers, users } from "@/db/schema";
import { formatFileSize, formatINR } from "@/lib/format";
import { can, requireSitePermission, siteRoleFor, type Actor } from "../authz";
import { canSeeExpense, changeRefusal, type ExpenseState } from "./expense-rules";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { cleanFileName, inspectUpload, type ReceiptType } from "../files";
import { reportError } from "../monitoring";
import { enforce, LIMITS } from "../rate-limit";
import { OCR_TYPES, ocrAvailable, readReceipt as ocrRead, type OcrSuggestion } from "../receipt-ocr";
import { SIGNED_URL_TTL, storage } from "../storage";
import { fieldErrors, receiptConfirmInput, receiptMeta, receiptRemoveInput, uuid } from "../validation";
import { audit } from "./audit";
import { num, today, type Conn } from "./shared";

/**
 * Receipts and supplier-bill files. Files live in object storage under opaque keys and
 * are only ever reached through short-lived signed URLs issued after an access check.
 * Removing or replacing a file deletes the stored object but keeps the row (who, when,
 * why) for the audit trail. Possible duplicates are flagged for a person to look at;
 * nothing is removed automatically.
 */

const EXT: Record<ReceiptType, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

export type Confirmed = { supplier?: string; billNumber?: string; date?: string; amount?: string };

export type ReceiptView = {
  id: string;
  siteId: string;
  expenseId: string | null;
  supplierBillId: string | null;
  fileName: string;
  contentType: string;
  kind: "pdf" | "image";
  size: number;
  pages: number | null;
  sha256: string;
  uploadedBy: string;
  uploadedAt: string;
  captureSource: string | null;
  /** App route that checks access and redirects to a fresh signed URL. */
  previewUrl: string;
  downloadUrl: string;
  ocrStatus: "none" | "done" | "failed" | "unsupported";
  ocr: OcrSuggestion | null;
  confirmed: Confirmed | null;
  confirmedBy: string | null;
  duplicate: { ofId: string; reason: string; acknowledged: boolean } | null;
  replacesId: string | null;
  canManage: boolean;
  /** Set on removed receipts in a history listing. */
  removed: { at: string; reason: string | null } | null;
};

// ---- Access ---------------------------------------------------------------------

type Parent = { siteId: string; expenseId: string | null; supplierBillId: string | null; expense: ExpenseState | null; deleted: boolean };

async function parentOf(r: { expenseId: string | null; supplierBillId: string | null }, conn: Conn): Promise<Parent | null> {
  if (r.expenseId) {
    const [e] = await conn
      .select({ siteId: expenses.siteId, createdBy: expenses.createdBy, deletedAt: expenses.deletedAt, status: expenses.status, reviewedBy: expenses.reviewedBy, source: expenses.source })
      .from(expenses)
      .where(eq(expenses.id, r.expenseId));
    return e ? { siteId: e.siteId, expenseId: r.expenseId, supplierBillId: null, expense: e, deleted: !!e.deletedAt } : null;
  }
  if (r.supplierBillId) {
    const [b] = await conn.select({ siteId: supplierBills.siteId }).from(supplierBills).where(eq(supplierBills.id, r.supplierBillId));
    return b ? { siteId: b.siteId, expenseId: null, supplierBillId: r.supplierBillId, expense: null, deleted: false } : null;
  }
  return null;
}

type Role = Parameters<typeof can>[0];

/** A file is visible exactly when its bill or expense is (an assistant engineer sees only their own entries' files). */
function mayView(actor: Actor, role: Role, parent: Parent) {
  return parent.expense ? canSeeExpense(actor, role, parent.expense) : can(role, "site:read");
}

/**
 * Who may replace, remove or confirm a file: for a bill, finance roles; for an expense,
 * whoever may change that expense (its approval state included).
 */
function mayManage(actor: Actor, role: Role, parent: Parent) {
  if (!parent.expense) return can(role, "finance:manage");
  return !changeRefusal(actor, role, parent.expense);
}

async function loadLive(actor: Actor, id: string, conn: Conn = db) {
  if (!uuid.safeParse(id).success) throw new NotFoundError("Receipt");
  const [row] = await conn.select().from(receipts).where(eq(receipts.id, id));
  if (!row || row.deletedAt) throw new NotFoundError("Receipt");
  const role = await siteRoleFor(actor, row.siteId, conn);
  if (!role) throw new NotFoundError("Receipt");
  const parent = await parentOf(row, conn);
  if (!parent || !mayView(actor, role, parent)) throw new NotFoundError("Receipt");
  return { row, role, parent };
}

async function toViews(actor: Actor, rows: (typeof receipts.$inferSelect)[], conn: Conn = db): Promise<ReceiptView[]> {
  if (!rows.length) return [];
  const names = new Map(
    (await conn.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set(rows.flatMap((r) => [r.uploadedBy, r.confirmedBy].filter((v): v is string => !!v)))])))
      .map((u) => [u.id, u.name]),
  );
  const out: ReceiptView[] = [];
  for (const r of rows) {
    const role = await siteRoleFor(actor, r.siteId, conn);
    const parent = await parentOf(r, conn);
    out.push({
      id: r.id,
      siteId: r.siteId,
      expenseId: r.expenseId,
      supplierBillId: r.supplierBillId,
      fileName: r.fileName,
      contentType: r.contentType,
      kind: r.contentType === "application/pdf" ? "pdf" : "image",
      size: r.sizeBytes,
      pages: r.pageCount,
      sha256: r.sha256,
      uploadedBy: names.get(r.uploadedBy) ?? "Unknown",
      uploadedAt: r.createdAt.toISOString(),
      captureSource: r.captureSource,
      previewUrl: `/api/receipts/${r.id}`,
      downloadUrl: `/api/receipts/${r.id}?download=1`,
      ocrStatus: r.ocrStatus as ReceiptView["ocrStatus"],
      ocr: (r.ocr as OcrSuggestion | null) ?? null,
      confirmed: (r.confirmed as Confirmed | null) ?? null,
      confirmedBy: r.confirmedBy ? (names.get(r.confirmedBy) ?? null) : null,
      duplicate: r.duplicateOfId ? { ofId: r.duplicateOfId, reason: r.duplicateReason ?? "Possible duplicate", acknowledged: !!r.duplicateAckAt } : null,
      replacesId: r.replacesId,
      canManage: !r.deletedAt && !!parent && mayManage(actor, role, parent),
      removed: r.deletedAt ? { at: r.deletedAt.toISOString(), reason: r.deleteReason } : null,
    });
  }
  return out;
}

// ---- Duplicates -------------------------------------------------------------------

/**
 * The same file already uploaded anywhere in the organization, or a receipt confirmed
 * (or read) with the same supplier and bill number. Returns the earlier receipt and why.
 */
async function findDuplicate(actor: Actor, sha256: string, details: { supplier?: string | null; billNumber?: string | null }, exceptId: string | null, conn: Conn) {
  const live = and(isNull(receipts.deletedAt), eq(constructionSites.organizationId, actor.orgId), exceptId ? ne(receipts.id, exceptId) : undefined);
  const [same] = await conn
    .select({ id: receipts.id, site: constructionSites.name, at: receipts.createdAt })
    .from(receipts)
    .innerJoin(constructionSites, eq(constructionSites.id, receipts.siteId))
    .where(and(live, eq(receipts.sha256, sha256)))
    .orderBy(receipts.createdAt)
    .limit(1);
  if (same) return { id: same.id, reason: `Same file as one uploaded on ${same.at.toISOString().slice(0, 10)} for ${same.site}.` };
  const bill = details.billNumber?.trim().toLowerCase();
  const supplier = details.supplier?.trim().toLowerCase();
  if (!bill || !supplier) return null;
  const [match] = (await conn.execute(sql`
    select r.id, cs.name as site from receipts r join construction_sites cs on cs.id = r.site_id
    left join supplier_bills b on b.id = r.supplier_bill_id left join suppliers s on s.id = b.supplier_id
    where cs.organization_id = ${actor.orgId} and r.deleted_at is null ${exceptId ? sql`and r.id <> ${exceptId}` : sql``}
      and lower(coalesce(r.confirmed->>'billNumber', r.ocr->>'billNumber', b.bill_number)) = ${bill}
      and lower(coalesce(r.confirmed->>'supplier', r.ocr->>'supplier', s.name)) = ${supplier}
    order by r.created_at limit 1
  `)) as unknown as { id: string; site: string }[];
  return match ? { id: match.id, reason: `Same supplier and bill number (${details.billNumber}) as a receipt on ${match.site}.` } : null;
}

// ---- Upload, replace, remove ----------------------------------------------------------

type UploadMeta = { siteId: string; expenseId?: string; supplierBillId?: string; fileName: string; contentType: string; captureSource?: "camera" | "file" };

function parseMeta(meta: UploadMeta, size: number) {
  const parsed = receiptMeta.safeParse({ ...meta, sizeBytes: size });
  if (!parsed.success) {
    const errors = fieldErrors(parsed.error);
    throw new ValidationError(Object.values(errors)[0] ?? "That file can't be uploaded.", errors);
  }
  return parsed.data;
}

async function store(actor: Actor, input: ReturnType<typeof parseMeta>, bytes: Uint8Array, extra: { replacesId?: string; ocr?: OcrSuggestion | null }, conn: Conn) {
  const file = inspectUpload(bytes, input.contentType);
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const duplicate = await findDuplicate(actor, sha256, { supplier: extra.ocr?.supplier, billNumber: extra.ocr?.billNumber }, extra.replacesId ?? null, conn);
  const storageKey = `${actor.orgId}/${input.siteId}/${crypto.randomUUID()}.${EXT[file.type]}`;
  await storage.put(storageKey, file.bytes, file.type);
  try {
    const [row] = await conn
      .insert(receipts)
      .values({
        siteId: input.siteId,
        expenseId: input.expenseId,
        supplierBillId: input.supplierBillId,
        fileName: cleanFileName(input.fileName, file.type),
        contentType: file.type,
        sizeBytes: file.bytes.byteLength,
        pageCount: file.pages,
        sha256,
        storageKey,
        uploadedBy: actor.userId,
        captureSource: input.captureSource,
        replacesId: extra.replacesId,
        ocr: extra.ocr ?? null,
        ocrStatus: extra.ocr ? "done" : "none",
        duplicateOfId: duplicate?.id,
        duplicateReason: duplicate?.reason,
      })
      .returning();
    return { row, duplicate };
  } catch (err) {
    await storage.delete(storageKey);
    throw err;
  }
}

/**
 * Adds a receipt to an expense or bill on a site where the actor may add expenses.
 * `ocr` is a suggestion from scanUpload (shown before saving); it's kept as a
 * suggestion, not applied.
 */
export async function addReceipt(actor: Actor, meta: UploadMeta & { ocr?: OcrSuggestion | null }, bytes: Uint8Array) {
  const input = parseMeta(meta, bytes.byteLength);
  const role = await requireSitePermission(actor, input.siteId, "expense:create");
  // The parent must exist on the same site, or a receipt could be smuggled onto another site.
  const parent = await parentOf({ expenseId: input.expenseId ?? null, supplierBillId: input.supplierBillId ?? null }, db);
  if (!parent || parent.siteId !== input.siteId || parent.deleted || !mayView(actor, role, parent)) throw new NotFoundError(input.expenseId ? "Expense" : "Bill");
  // Site members who see the site's records may add files to any of them; an assistant engineer only to entries they can still change.
  if (!can(role, "site:read") && !mayManage(actor, role, parent)) throw new ForbiddenError("Files can only be added to your drafts and rejected entries.");
  return db.transaction(async (tx) => {
    const { row, duplicate } = await store(actor, input, bytes, { ocr: meta.ocr }, tx);
    await audit(tx, actor, {
      siteId: input.siteId,
      action: "receipt.upload",
      entityType: "receipt",
      entityId: row.id,
      summary: `Attached ${row.fileName} (${formatFileSize(row.sizeBytes)}) to ${input.expenseId ? "an expense" : "a bill"}${duplicate ? ", flagged as a possible duplicate" : ""}`,
      data: { expenseId: input.expenseId, supplierBillId: input.supplierBillId, sha256: row.sha256, contentType: row.contentType, captureSource: input.captureSource, duplicateOf: duplicate?.id },
    });
    return row;
  });
}

/** Swaps the file on an expense or bill, keeping the old row (marked replaced) for the record. */
export async function replaceReceipt(actor: Actor, id: string, meta: Pick<UploadMeta, "fileName" | "contentType" | "captureSource">, bytes: Uint8Array) {
  const { row: old, role, parent } = await loadLive(actor, id);
  if (!mayManage(actor, role, parent)) throw new ForbiddenError("You can't replace this file.");
  const input = parseMeta({ ...meta, siteId: old.siteId, expenseId: old.expenseId ?? undefined, supplierBillId: old.supplierBillId ?? undefined }, bytes.byteLength);
  const fresh = await db.transaction(async (tx) => {
    const [locked] = await tx.select({ deletedAt: receipts.deletedAt }).from(receipts).where(eq(receipts.id, old.id)).for("update");
    if (locked.deletedAt) throw new NotFoundError("Receipt");
    const { row } = await store(actor, input, bytes, { replacesId: old.id }, tx);
    await tx.update(receipts).set({ deletedAt: new Date(), deletedBy: actor.userId, deleteReason: "Replaced" }).where(eq(receipts.id, old.id));
    await audit(tx, actor, {
      siteId: old.siteId,
      action: "receipt.replace",
      entityType: "receipt",
      entityId: row.id,
      summary: `Replaced ${old.fileName} with ${row.fileName}`,
      data: { replaced: old.id, oldSha256: old.sha256, newSha256: row.sha256 },
    });
    return row;
  });
  // The old object goes only after the swap committed.
  await storage.delete(old.storageKey);
  return fresh;
}

/** Removes a file: the stored object is deleted, the row stays with who removed it and why. */
export async function removeReceipt(actor: Actor, raw: unknown) {
  const input = receiptRemoveInput.parse(raw);
  const { row, role, parent } = await loadLive(actor, input.id);
  if (!mayManage(actor, role, parent)) {
    throw new ForbiddenError(parent.supplierBillId ? "Only the site owner or accountant can remove a bill's file." : "Only whoever can edit this expense can remove its receipt.");
  }
  await db.transaction(async (tx) => {
    await tx.update(receipts).set({ deletedAt: new Date(), deletedBy: actor.userId, deleteReason: input.reason }).where(and(eq(receipts.id, row.id), isNull(receipts.deletedAt)));
    await audit(tx, actor, { siteId: row.siteId, action: "receipt.remove", entityType: "receipt", entityId: row.id, summary: `Removed ${row.fileName}: ${input.reason}`, data: { sha256: row.sha256 } });
  });
  await storage.delete(row.storageKey);
}

/** Kept for older callers: removal with a generic reason. */
export async function deleteReceipt(actor: Actor, receiptId: string) {
  return removeReceipt(actor, { id: receiptId, reason: "Removed" });
}

// ---- Reading ---------------------------------------------------------------------

/** Live files on one expense or bill (plus removed and replaced ones when asked, for the history). */
export async function listReceipts(actor: Actor, parent: { expenseId?: string; supplierBillId?: string }, opts: { history?: boolean } = {}) {
  const p = await parentOf({ expenseId: parent.expenseId ?? null, supplierBillId: parent.supplierBillId ?? null }, db);
  const role = p ? await siteRoleFor(actor, p.siteId) : null;
  if (!p || !mayView(actor, role, p)) throw new NotFoundError(parent.expenseId ? "Expense" : "Bill");
  const rows = await db
    .select()
    .from(receipts)
    .where(and(parent.expenseId ? eq(receipts.expenseId, parent.expenseId) : eq(receipts.supplierBillId, parent.supplierBillId!), opts.history ? undefined : isNull(receipts.deletedAt)))
    .orderBy(desc(receipts.createdAt));
  return toViews(actor, rows);
}

export async function getReceipt(actor: Actor, id: string) {
  const { row } = await loadLive(actor, id);
  return (await toViews(actor, [row]))[0];
}

/** A short-lived signed URL for someone who can see the site. Preview opens inline; download saves. */
export async function receiptLink(actor: Actor, id: string, mode: "preview" | "download" = "preview") {
  const { row } = await loadLive(actor, id);
  const url = await storage.signedUrl(row.storageKey, {
    disposition: mode === "download" ? "attachment" : "inline",
    fileName: row.fileName,
    contentType: row.contentType,
    expiresIn: SIGNED_URL_TTL,
  });
  return { url, expiresIn: SIGNED_URL_TTL };
}

/** The bytes, for server-side use (OCR, tests). Same access rule as links. */
export async function readReceipt(actor: Actor, receiptId: string) {
  const { row } = await loadLive(actor, receiptId);
  const bytes = await storage.get(row.storageKey);
  if (!bytes) throw new NotFoundError("Receipt file");
  return { bytes, fileName: row.fileName, contentType: row.contentType };
}

// ---- Duplicates, OCR and confirmation -----------------------------------------------

export async function acknowledgeDuplicate(actor: Actor, id: string) {
  const { row, role, parent } = await loadLive(actor, id);
  if (!mayManage(actor, role, parent)) throw new ForbiddenError();
  if (!row.duplicateOfId || row.duplicateAckAt) return getReceipt(actor, id);
  await db.transaction(async (tx) => {
    await tx.update(receipts).set({ duplicateAckAt: new Date(), duplicateAckBy: actor.userId }).where(eq(receipts.id, id));
    await audit(tx, actor, { siteId: row.siteId, action: "receipt.duplicate_ok", entityType: "receipt", entityId: id, summary: `Marked ${row.fileName} as not a duplicate`, data: { duplicateOf: row.duplicateOfId } });
  });
  return getReceipt(actor, id);
}

/**
 * Reads a file before it's saved (e.g. while filling in a new bill) so the form can be
 * pre-filled for the user to check. Nothing is stored.
 */
export async function scanUpload(actor: Actor, siteId: string, contentType: string, bytes: Uint8Array) {
  await requireSitePermission(actor, siteId, "expense:create");
  if (!ocrAvailable()) throw new ValidationError("Reading bills automatically isn't set up. Fill in the details yourself.");
  const file = inspectUpload(bytes, contentType);
  if (!OCR_TYPES.includes(file.type)) throw new ValidationError("HEIC photos can't be read automatically. Fill in the details yourself.");
  await enforce(`ai:${actor.userId}`, LIMITS.aiRead);
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const suggestion = await ocrRead(file.bytes, file.type, today());
  const duplicate = await findDuplicate(actor, sha256, suggestion, null, db);
  return { suggestion, duplicate: duplicate ? { reason: duplicate.reason } : null };
}

/** Reads a stored file and keeps the suggestions on it. Values are only shown, never applied. */
export async function extractReceiptDetails(actor: Actor, id: string) {
  const { row, role, parent } = await loadLive(actor, id);
  if (!can(role, "expense:create") || (!can(role, "site:read") && !mayManage(actor, role, parent))) throw new ForbiddenError();
  if (!ocrAvailable()) throw new ValidationError("Reading receipts automatically isn't set up.");
  await enforce(`ai:${actor.userId}`, LIMITS.aiRead);
  let status: "done" | "failed" | "unsupported" = "done";
  let suggestion: OcrSuggestion | null = null;
  if (!OCR_TYPES.includes(row.contentType as ReceiptType)) status = "unsupported";
  else {
    try {
      const bytes = await storage.get(row.storageKey);
      if (!bytes) throw new NotFoundError("Receipt file");
      suggestion = await ocrRead(bytes, row.contentType as ReceiptType, today());
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      void reportError(err, { source: "receipt-ocr", userId: actor.userId });
      status = "failed";
    }
  }
  const duplicate = suggestion && !row.duplicateOfId ? await findDuplicate(actor, row.sha256, suggestion, row.id, db) : null;
  await db.transaction(async (tx) => {
    await tx
      .update(receipts)
      .set({ ocr: suggestion, ocrStatus: status, ...(duplicate && { duplicateOfId: duplicate.id, duplicateReason: duplicate.reason }) })
      .where(eq(receipts.id, id));
    await audit(tx, actor, { siteId: row.siteId, action: "receipt.ocr", entityType: "receipt", entityId: id, summary: `Read ${row.fileName} automatically (${status})`, data: { suggestion } });
  });
  return getReceipt(actor, id);
}

/**
 * A person confirms what the receipt says. Stored on the receipt only; the expense or
 * bill is never changed here. Differences from the record are returned so the UI can
 * point them out.
 */
export async function confirmReceiptDetails(actor: Actor, raw: unknown) {
  const input = receiptConfirmInput.parse(raw);
  const { row, role, parent } = await loadLive(actor, input.id);
  if (!can(role, "expense:create") || (!can(role, "site:read") && !mayManage(actor, role, parent))) throw new ForbiddenError();
  if (input.date && input.date > today()) throw new ValidationError("The bill date can't be in the future.", { date: "Pick today or earlier." });
  const confirmed: Confirmed = Object.fromEntries(Object.entries({ supplier: input.supplier, billNumber: input.billNumber, date: input.date, amount: input.amount }).filter(([, v]) => v));
  await db.transaction(async (tx) => {
    await tx.update(receipts).set({ confirmed, confirmedAt: new Date(), confirmedBy: actor.userId }).where(eq(receipts.id, row.id));
    await audit(tx, actor, { siteId: row.siteId, action: "receipt.confirm", entityType: "receipt", entityId: row.id, summary: `Confirmed the details on ${row.fileName}`, data: { confirmed, suggestion: row.ocr } });
  });
  return { receipt: await getReceipt(actor, row.id), differences: await differences(row, confirmed) };
}

/** Where confirmed receipt details disagree with the expense or bill they're attached to. */
async function differences(row: typeof receipts.$inferSelect, c: Confirmed) {
  const out: string[] = [];
  if (row.expenseId) {
    const [e] = await db.select({ amount: expenses.totalAmount, date: expenses.expenseDate }).from(expenses).where(eq(expenses.id, row.expenseId));
    if (c.amount && e && Number(c.amount) !== num(e.amount)) out.push(`The receipt says ${formatINR(Number(c.amount))}; the expense is ${formatINR(num(e.amount))}.`);
    if (c.date && e && c.date !== e.date) out.push(`The receipt is dated ${c.date}; the expense is dated ${e.date}.`);
  }
  if (row.supplierBillId) {
    const [b] = await db
      .select({ amount: supplierBills.amount, number: supplierBills.billNumber, date: supplierBills.billDate, supplier: suppliers.name })
      .from(supplierBills)
      .innerJoin(suppliers, eq(suppliers.id, supplierBills.supplierId))
      .where(eq(supplierBills.id, row.supplierBillId));
    if (b) {
      if (c.amount && Number(c.amount) !== num(b.amount)) out.push(`The bill file says ${formatINR(Number(c.amount))}; the bill is recorded as ${formatINR(num(b.amount))}.`);
      if (c.billNumber && c.billNumber.toLowerCase() !== b.number.toLowerCase()) out.push(`The file's bill number is ${c.billNumber}; the bill is recorded as ${b.number}.`);
      if (c.date && c.date !== b.date) out.push(`The file is dated ${c.date}; the bill is dated ${b.date}.`);
      if (c.supplier && c.supplier.toLowerCase() !== b.supplier.toLowerCase()) out.push(`The file names ${c.supplier}; the bill is from ${b.supplier}.`);
    }
  }
  return out;
}

/** Live receipt counts per expense, for lists and reports. */
export async function receiptCounts(expenseIds: string[], conn: Conn = db) {
  if (!expenseIds.length) return new Map<string, number>();
  const rows = await conn
    .select({ id: receipts.expenseId, n: sql<number>`count(*)::int` })
    .from(receipts)
    .where(and(inArray(receipts.expenseId, expenseIds), isNull(receipts.deletedAt)))
    .groupBy(receipts.expenseId);
  return new Map(rows.map((r) => [r.id!, Number(r.n)]));
}
