import "server-only";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { expenseCategories, expenseItems, expenses, labourWorkers, suppliers, users } from "@/db/schema";
import type { Category, Expense, ExpenseSource, ExpenseStatus, Page, PaymentMode } from "@/lib/types";
import { accessibleSites, can, requireSitePermission, scopeSiteIds, siteRoleFor, type Actor, type SitePermission, type SiteRole } from "../authz";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import {
  expenseBatchInput,
  expenseFilters,
  expenseInput,
  expenseReopenInput,
  expenseReviewInput,
  expenseUpdateInput,
  myExpensesInput,
  reviewQueueInput,
  uuid,
  type ExpenseFilters,
} from "../validation";
import { audit } from "./audit";
import {
  REVIEWABLE_SOURCES,
  canReopenExpense,
  canReviewExpense,
  canSeeExpense,
  canSubmitExpense,
  changeRefusal,
} from "./expense-rules";
import { approversOf, notify } from "./notifications";
import { receiptCounts } from "./receipts";
import { categoryId, decodeCursor, encodeCursor, enteredApproved, num, supplierIdByName, today, workerIdByName, type Conn } from "./shared";

type ParsedExpense = ReturnType<typeof expenseInput.parse>;

// ---- Writes -----------------------------------------------------------------

async function recomputeTotal(expenseId: string, conn: Conn) {
  await conn
    .update(expenses)
    .set({
      totalAmount: sql`(select coalesce(sum(${expenseItems.amount}), 0) from ${expenseItems} where ${expenseItems.expenseId} = ${expenseId})`,
    })
    .where(eq(expenses.id, expenseId));
}

async function insertItems(expenseId: string, items: ParsedExpense["items"], conn: Conn) {
  await conn.insert(expenseItems).values(
    items.map((it, position) => ({
      expenseId,
      position,
      description: it.description,
      quantity: it.quantity,
      unit: it.unit,
      unitPrice: it.unitPrice,
    })),
  );
}

function assertNotFuture(date: string) {
  if (date > today()) {
    const message = "Date can't be in the future.";
    throw new ValidationError(message, { expenseDate: message });
  }
}

const money = (v: string) => `₹${v}`;

/** Tells a site's reviewers about entries just sent for approval. Same transaction as the change. */
async function notifySubmitted(conn: Conn, actor: Actor, entries: { id: string; siteId: string; description: string; total: string }[]) {
  for (const e of entries) {
    await notify(conn, actor, await approversOf(e.siteId, actor.userId, conn), {
      kind: "expense.submitted",
      siteId: e.siteId,
      expenseId: e.id,
      title: `${actor.name} sent an expense for approval`,
      body: `${e.description}: ${money(e.total)}`,
    });
  }
}

/**
 * The status a new expense starts in. Decided here from the actor's role on the site,
 * never taken from input: anyone but an assistant engineer is approved at once; an
 * assistant's entry is a draft, or waits for approval when they submit it.
 */
function initialState(actor: Actor, role: SiteRole, submit: boolean | undefined, at: Date) {
  if (can(role, "expense:direct")) return enteredApproved(actor, at);
  return submit ? { status: "pending_approval" as const, submittedAt: at } : { status: "draft" as const };
}

/**
 * Inserts expenses with their items in a constant number of round trips:
 * one role check per site, one category lookup, bulk inserts, and one
 * UPDATE that sets every total from its items. Must run in a transaction.
 */
export async function insertExpenses(actor: Actor, inputs: ParsedExpense[], conn: Conn): Promise<string[]> {
  const roles = new Map<string, SiteRole>();
  for (const siteId of new Set(inputs.map((i) => i.siteId))) roles.set(siteId, await requireSitePermission(actor, siteId, "expense:create", conn));
  for (const input of inputs) assertNotFuture(input.expenseDate);
  const now = new Date();
  const states = inputs.map((input) => initialState(actor, roles.get(input.siteId)!, input.submit, now));

  const cats = await conn
    .select({ id: expenseCategories.id, code: expenseCategories.code })
    .from(expenseCategories)
    .where(eq(expenseCategories.organizationId, actor.orgId));
  const catId = new Map(cats.map((c) => [c.code, c.id]));
  const supplierId = new Map<string, string | null>();
  const workerId = new Map<string, string | null>();
  for (const name of new Set(inputs.map((i) => i.supplierName).filter(Boolean) as string[]))
    supplierId.set(name, await supplierIdByName(actor, name, conn));
  for (const name of new Set(inputs.map((i) => i.workerName).filter(Boolean) as string[]))
    workerId.set(name, await workerIdByName(actor, name, conn));

  const rows = await conn
    .insert(expenses)
    .values(
      inputs.map((input, i) => {
        const category = catId.get(input.categoryCode);
        if (!category) throw new NotFoundError("Category");
        return {
          siteId: input.siteId,
          categoryId: category,
          expenseDate: input.expenseDate,
          description: input.description,
          paymentMethod: input.paymentMethod,
          source: input.source,
          supplierId: input.supplierName ? supplierId.get(input.supplierName) : null,
          labourWorkerId: input.workerName ? workerId.get(input.workerName) : null,
          // A labour expense naming a worker is a payment to them; it settles their balance.
          labourKind: input.workerName && input.categoryCode === "labour" ? (input.labourKind ?? "wage") : null,
          voiceTranscript: input.source === "voice" ? input.voiceTranscript : undefined,
          notes: input.notes,
          createdBy: actor.userId,
          ...states[i],
        };
      }),
    )
    .returning({ id: expenses.id });
  const ids = rows.map((r) => r.id);

  await conn.insert(expenseItems).values(
    inputs.flatMap((input, i) =>
      input.items.map((it, position) => ({
        expenseId: ids[i],
        position,
        description: it.description,
        quantity: it.quantity,
        unit: it.unit,
        unitPrice: it.unitPrice,
      })),
    ),
  );
  const totals = (await conn.execute(sql`
    update expenses e set total_amount = s.total
    from (select expense_id, sum(amount) as total from expense_items where expense_id in ${ids} group by expense_id) s
    where e.id = s.expense_id
    returning e.id, e.total_amount::text as total
  `)) as unknown as { id: string; total: string }[];
  const totalOf = new Map(totals.map((t) => [t.id, t.total]));
  const stateNote = { approved: "", draft: ", saved as a draft", pending_approval: ", sent for approval" } as const;
  await audit(
    conn,
    actor,
    inputs.map((input, i) => ({
      siteId: input.siteId,
      action: "expense.create",
      entityType: "expense",
      entityId: ids[i],
      summary: `${input.description}: ₹${totalOf.get(ids[i])}${input.source === "voice" ? " (voice)" : ""}${stateNote[states[i].status]}`,
      data: { ...input, voiceTranscript: undefined, submit: undefined, total: totalOf.get(ids[i]), status: states[i].status },
    })),
  );
  await notifySubmitted(
    conn,
    actor,
    inputs.flatMap((input, i) => (states[i].status === "pending_approval" ? [{ id: ids[i], siteId: input.siteId, description: input.description, total: totalOf.get(ids[i]) ?? "0" }] : [])),
  );
  return ids;
}

/** One expense; total is always recomputed from its items on the server. */
export async function createExpense(actor: Actor, raw: unknown): Promise<Expense> {
  const input = expenseInput.parse(raw);
  const [id] = await db.transaction((tx) => insertExpenses(actor, [input], tx));
  return getExpense(actor, id);
}

/** Several expenses at once (voice entry), all or nothing. */
export async function createExpenses(actor: Actor, raw: unknown): Promise<Expense[]> {
  const { expenses: inputs } = expenseBatchInput.parse(raw);
  const ids = await db.transaction((tx) => insertExpenses(actor, inputs, tx));
  return getExpenses(actor, ids);
}

const stateColumns = {
  siteId: expenses.siteId,
  createdBy: expenses.createdBy,
  source: expenses.source,
  deletedAt: expenses.deletedAt,
  totalAmount: expenses.totalAmount,
  description: expenses.description,
  status: expenses.status,
  reviewedBy: expenses.reviewedBy,
};

/**
 * Locks an expense row for a status change or edit and returns it with the actor's role.
 * Invisible to the actor (another site, someone else's draft) → NotFound, so ids don't leak.
 */
async function lockForChange(actor: Actor, id: string, conn: Conn) {
  if (!uuid.safeParse(id).success) throw new NotFoundError("Expense");
  const [row] = await conn.select(stateColumns).from(expenses).where(eq(expenses.id, id)).limit(1).for("update");
  if (!row) throw new NotFoundError("Expense");
  const role = await siteRoleFor(actor, row.siteId, conn);
  if (!role || !canSeeExpense(actor, role, row)) throw new NotFoundError("Expense");
  return { row, role };
}

/** Loads an expense for a write and checks the actor may change it. */
async function editable(actor: Actor, id: string, conn: Conn) {
  const { row, role } = await lockForChange(actor, id, conn);
  const refusal = changeRefusal(actor, role, row);
  if (refusal) throw new ForbiddenError(refusal);
  if (row.source === "bill_payment") {
    throw new ValidationError("This expense was created by a bill payment. Change the bill payment instead.");
  }
  if (row.source === "purchase") {
    throw new ValidationError("This expense belongs to a material purchase. Void the purchase on the Materials page instead.");
  }
  return { ...row, role };
}

export async function updateExpense(actor: Actor, raw: unknown): Promise<Expense> {
  const input = expenseUpdateInput.parse(raw);
  await db.transaction(async (tx) => {
    const existing = await editable(actor, input.id, tx);
    if (existing.deletedAt) throw new NotFoundError("Expense");
    if (input.siteId !== existing.siteId) await requireSitePermission(actor, input.siteId, "expense:create", tx);
    assertNotFuture(input.expenseDate);
    const [catId, supplierId, workerId] = await Promise.all([
      categoryId(actor, input.categoryCode, tx),
      supplierIdByName(actor, input.supplierName, tx),
      workerIdByName(actor, input.workerName, tx),
    ]);
    await tx
      .update(expenses)
      .set({
        siteId: input.siteId,
        categoryId: catId,
        expenseDate: input.expenseDate,
        description: input.description,
        paymentMethod: input.paymentMethod,
        supplierId,
        labourWorkerId: workerId,
        // Editing an advance in the general form keeps it an advance unless a kind is sent.
        labourKind:
          workerId && input.categoryCode === "labour"
            ? (input.labourKind ?? sql`coalesce(${expenses.labourKind}, 'wage')`)
            : null,
        notes: input.notes,
      })
      .where(eq(expenses.id, input.id));
    await tx.delete(expenseItems).where(eq(expenseItems.expenseId, input.id));
    await insertItems(input.id, input.items, tx);
    await recomputeTotal(input.id, tx);
    const [after] = await tx.select({ total: expenses.totalAmount }).from(expenses).where(eq(expenses.id, input.id));
    await audit(tx, actor, {
      siteId: input.siteId,
      action: "expense.update",
      entityType: "expense",
      entityId: input.id,
      summary: `Edited ${input.description}: now ₹${after.total}`,
      data: { before: { siteId: existing.siteId, total: existing.totalAmount, status: existing.status }, after: { ...input, submit: undefined, total: after.total } },
    });
    // "Save and send": a corrected draft or rejected entry goes for approval in the same transaction.
    if (input.submit && canSubmitExpense(actor, existing.role, existing)) {
      const role = input.siteId === existing.siteId ? existing.role : await requireSitePermission(actor, input.siteId, "expense:create", tx);
      await submitLocked(actor, role, { ...existing, siteId: input.siteId, description: input.description, totalAmount: after.total }, input.id, tx);
    }
  });
  return getExpense(actor, input.id);
}

/** Soft delete so the UI's Undo can restore it. */
export async function deleteExpense(actor: Actor, id: string) {
  await db.transaction(async (tx) => {
    const row = await editable(actor, id, tx);
    if (row.deletedAt) return;
    await tx.update(expenses).set({ deletedAt: new Date() }).where(eq(expenses.id, id));
    await audit(tx, actor, { siteId: row.siteId, action: "expense.delete", entityType: "expense", entityId: id, summary: `Deleted an expense of ₹${row.totalAmount}` });
  });
}

export async function restoreExpense(actor: Actor, id: string): Promise<Expense> {
  await db.transaction(async (tx) => {
    const row = await editable(actor, id, tx);
    await tx.update(expenses).set({ deletedAt: null }).where(eq(expenses.id, id));
    await audit(tx, actor, { siteId: row.siteId, action: "expense.restore", entityType: "expense", entityId: id, summary: `Restored an expense of ₹${row.totalAmount}` });
  });
  return getExpense(actor, id);
}

// ---- Approval -----------------------------------------------------------------

type Locked = Awaited<ReturnType<typeof lockForChange>>["row"];

/** Draft or rejected → waiting for approval (or straight to approved for someone who enters directly). */
async function submitLocked(actor: Actor, role: SiteRole, row: Locked, id: string, conn: Conn) {
  const now = new Date();
  const next = can(role, "expense:direct") ? enteredApproved(actor, now) : { status: "pending_approval" as const, submittedAt: now };
  const done = await conn
    .update(expenses)
    .set(next)
    .where(and(eq(expenses.id, id), inArray(expenses.status, ["draft", "rejected"]), isNull(expenses.deletedAt)))
    .returning({ id: expenses.id });
  if (!done.length) throw new ValidationError("This expense can't be sent for approval now. Reload to see its status.");
  await audit(conn, actor, {
    siteId: row.siteId,
    action: "expense.submit",
    entityType: "expense",
    entityId: id,
    summary: `${row.status === "rejected" ? "Resubmitted" : "Submitted"} ${row.description}: ₹${row.totalAmount}${next.status === "approved" ? " (counted at once)" : " for approval"}`,
    data: { from: row.status, to: next.status },
  });
  if (next.status === "pending_approval") await notifySubmitted(conn, actor, [{ id, siteId: row.siteId, description: row.description, total: row.totalAmount }]);
}

/**
 * Sends the actor's own draft or rejected expense for approval. Submitting again while
 * it's already waiting does nothing, so a double tap can't notify twice.
 */
export async function submitExpense(actor: Actor, id: string): Promise<Expense> {
  await db.transaction(async (tx) => {
    const { row, role } = await lockForChange(actor, id, tx);
    if (row.deletedAt) throw new NotFoundError("Expense");
    if (row.createdBy !== actor.userId || !can(role, "expense:create")) throw new ForbiddenError("Only the person who entered an expense can send it for approval.");
    if (row.status === "pending_approval") return;
    if (row.status === "approved") throw new ValidationError("This expense is already approved.");
    await submitLocked(actor, role, row, id, tx);
  });
  return getExpense(actor, id);
}

const reviewedState = { approved: "approved", rejected: "rejected" } as const;

/**
 * A site owner approves or rejects a waiting expense. The row is locked, so of two
 * reviewers acting at once one wins and the other is told it's already been reviewed.
 */
export async function reviewExpense(actor: Actor, raw: unknown): Promise<Expense> {
  const input = expenseReviewInput.parse(raw);
  await db.transaction(async (tx) => {
    const { row, role } = await lockForChange(actor, input.id, tx);
    if (row.deletedAt) throw new NotFoundError("Expense");
    if (!can(role, "expense:approve")) throw new ForbiddenError("Only a site owner can approve or reject expenses.");
    if (row.createdBy === actor.userId) throw new ForbiddenError("You can't review an expense you entered.");
    if (row.status !== "pending_approval") {
      throw new ValidationError(row.status === "draft" ? "This expense hasn't been sent for approval." : `This expense was already ${reviewedState[row.status]}.`);
    }
    const approve = input.decision === "approve";
    const now = new Date();
    await tx
      .update(expenses)
      .set(
        approve
          ? { status: "approved", reviewedBy: actor.userId, reviewedAt: now, approvalNote: input.note ?? null, rejectionReason: null }
          : { status: "rejected", reviewedBy: actor.userId, reviewedAt: now, rejectionReason: input.note!, approvalNote: null },
      )
      .where(and(eq(expenses.id, input.id), eq(expenses.status, "pending_approval")));
    await audit(tx, actor, {
      siteId: row.siteId,
      action: approve ? "expense.approve" : "expense.reject",
      entityType: "expense",
      entityId: input.id,
      summary: `${approve ? "Approved" : "Rejected"} ${row.description}: ₹${row.totalAmount}${approve ? "" : `. Reason: ${input.note}`}`,
      data: { from: row.status, to: approve ? "approved" : "rejected", note: input.note ?? null, enteredBy: row.createdBy },
    });
    await notify(tx, actor, [row.createdBy], {
      kind: approve ? "expense.approved" : "expense.rejected",
      siteId: row.siteId,
      expenseId: input.id,
      title: approve ? `Approved: ${row.description}` : `Rejected: ${row.description}`,
      body: approve ? (input.note ?? `${money(row.totalAmount)} now counts in the site's totals.`) : `Reason: ${input.note}`,
    });
  });
  return getExpense(actor, input.id);
}

/**
 * The controlled way to correct an approved expense someone else entered: a site owner
 * sends it back with a reason. It leaves the totals (status rejected) until the person
 * who entered it corrects and resubmits it, and it's approved again.
 */
export async function reopenExpense(actor: Actor, raw: unknown): Promise<Expense> {
  const input = expenseReopenInput.parse(raw);
  await db.transaction(async (tx) => {
    const { row, role } = await lockForChange(actor, input.id, tx);
    if (row.deletedAt) throw new NotFoundError("Expense");
    if (!can(role, "expense:approve")) throw new ForbiddenError("Only a site owner can reopen an approved expense.");
    if (row.status !== "approved") throw new ValidationError("Only approved expenses can be reopened.");
    if (!REVIEWABLE_SOURCES.includes(row.source)) throw new ValidationError("Bill payments and purchases are corrected on their own pages.");
    if (row.createdBy === actor.userId) throw new ValidationError("This is your own entry. Edit it instead.");
    await tx
      .update(expenses)
      .set({ status: "rejected", reviewedBy: actor.userId, reviewedAt: new Date(), rejectionReason: input.reason, approvalNote: null })
      .where(and(eq(expenses.id, input.id), eq(expenses.status, "approved")));
    await audit(tx, actor, {
      siteId: row.siteId,
      action: "expense.reopen",
      entityType: "expense",
      entityId: input.id,
      summary: `Reopened ${row.description} (₹${row.totalAmount}) for correction. Reason: ${input.reason}`,
      data: { from: "approved", to: "rejected", reason: input.reason, enteredBy: row.createdBy },
    });
    await notify(tx, actor, [row.createdBy], {
      kind: "expense.reopened",
      siteId: row.siteId,
      expenseId: input.id,
      title: `Sent back for correction: ${row.description}`,
      body: `Reason: ${input.reason}`,
    });
  });
  return getExpense(actor, input.id);
}

// ---- Reads ------------------------------------------------------------------

const listColumns = {
  id: expenses.id,
  siteId: expenses.siteId,
  date: expenses.expenseDate,
  category: expenseCategories.code,
  description: expenses.description,
  amount: expenses.totalAmount,
  paymentMethod: expenses.paymentMethod,
  source: expenses.source,
  supplier: suppliers.name,
  worker: labourWorkers.name,
  enteredBy: users.name,
  createdBy: expenses.createdBy,
  // Full-precision text so keyset cursors never skip rows that share a millisecond.
  createdAtText: sql<string>`${expenses.createdAt}::text`,
  status: expenses.status,
  submittedAt: expenses.submittedAt,
  reviewedAt: expenses.reviewedAt,
  reviewedBy: expenses.reviewedBy,
  reviewerName: sql<string | null>`(select r.name from users r where r.id = ${expenses.reviewedBy})`,
  rejectionReason: expenses.rejectionReason,
  approvalNote: expenses.approvalNote,
};

type ListRow = {
  id: string;
  siteId: string;
  date: string;
  category: string;
  description: string;
  amount: string;
  paymentMethod: PaymentMode;
  source: ExpenseSource;
  supplier: string | null;
  worker: string | null;
  enteredBy: string;
  createdBy: string;
  createdAtText: string;
  status: ExpenseStatus;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  reviewerName: string | null;
  rejectionReason: string | null;
  approvalNote: string | null;
};

function baseQuery(conn: Conn, sortKey: SQL = sql`null`) {
  return conn
    .select({ ...listColumns, sortKeyText: sql<string | null>`(${sortKey})::text` })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
    .innerJoin(users, eq(users.id, expenses.createdBy))
    .leftJoin(suppliers, eq(suppliers.id, expenses.supplierId))
    .leftJoin(labourWorkers, eq(labourWorkers.id, expenses.labourWorkerId));
}

const trimQty = (q: string) => q.replace(/\.?0+$/, "");

async function hydrate(actor: Actor, rows: ListRow[], roles: Map<string, SiteRole>, conn: Conn): Promise<Expense[]> {
  if (rows.length === 0) return [];
  const items = await conn
    .select({
      expenseId: expenseItems.expenseId,
      description: expenseItems.description,
      quantity: expenseItems.quantity,
      unit: expenseItems.unit,
      unitPrice: expenseItems.unitPrice,
      amount: expenseItems.amount,
    })
    .from(expenseItems)
    .where(inArray(expenseItems.expenseId, rows.map((r) => r.id)))
    .orderBy(asc(expenseItems.expenseId), asc(expenseItems.position));
  const counts = await receiptCounts(rows.map((r) => r.id), conn);
  const byExpense = new Map<string, Expense["items"]>();
  for (const it of items) {
    const list = byExpense.get(it.expenseId) ?? [];
    list.push({ description: it.description, quantity: it.quantity, unit: it.unit, unitPrice: it.unitPrice, amount: it.amount });
    byExpense.set(it.expenseId, list);
  }
  return rows.map((r) => {
    const role = roles.get(r.siteId);
    const its = byExpense.get(r.id) ?? [];
    const only = its.length === 1 ? its[0] : undefined;
    const showQty = only && !(Number(only.quantity) === 1 && (only.unit === "nos" || only.unit === "lot"));
    return {
      id: r.id,
      siteId: r.siteId,
      date: r.date,
      category: r.category as Category,
      description: r.description,
      amount: num(r.amount),
      quantity: showQty ? `${trimQty(only.quantity)} ${only.unit}` : its.length > 1 ? `${its.length} items` : undefined,
      items: its,
      worker: r.worker ?? undefined,
      supplier: r.supplier ?? undefined,
      paymentMode: r.paymentMethod,
      enteredBy: r.enteredBy,
      source: r.source,
      viaVoice: r.source === "voice" || undefined,
      canEdit: r.source !== "bill_payment" && r.source !== "purchase" && !changeRefusal(actor, role, r),
      receipts: counts.get(r.id) ?? 0,
      canManageReceipts: !changeRefusal(actor, role, r),
      status: r.status,
      submittedAt: r.submittedAt?.toISOString(),
      // Directly entered expenses are "approved" by their author; only a real review is shown.
      reviewedBy: r.reviewedBy && r.reviewedBy !== r.createdBy ? (r.reviewerName ?? undefined) : undefined,
      reviewedAt: r.reviewedBy && r.reviewedBy !== r.createdBy ? r.reviewedAt?.toISOString() : undefined,
      rejectionReason: r.rejectionReason ?? undefined,
      approvalNote: r.approvalNote ?? undefined,
      canSubmit: canSubmitExpense(actor, role, r),
      canReview: canReviewExpense(actor, role, r),
      canReopen: canReopenExpense(actor, role, r),
    };
  });
}

export async function getExpense(actor: Actor, id: string, conn: Conn = db): Promise<Expense> {
  const [row] = await baseQuery(conn)
    .where(and(eq(expenses.id, id), isNull(expenses.deletedAt)))
    .limit(1);
  if (!row) throw new NotFoundError("Expense");
  const role = await siteRoleFor(actor, row.siteId, conn);
  if (!role || !canSeeExpense(actor, role, row as ListRow)) throw new NotFoundError("Expense");
  const [dto] = await hydrate(actor, [row as ListRow], new Map([[row.siteId, role]]), conn);
  return dto;
}

/** Several expenses by id, in the given order, in two queries. */
export async function getExpenses(actor: Actor, ids: string[]): Promise<Expense[]> {
  const rows = (await baseQuery(db).where(and(inArray(expenses.id, ids), isNull(expenses.deletedAt)))) as ListRow[];
  const roles = await accessibleSites(actor);
  const visible = rows.filter((r) => canSeeExpense(actor, roles.get(r.siteId), r));
  const dtos = new Map((await hydrate(actor, visible, roles, db)).map((e) => [e.id, e]));
  return ids.map((id) => dtos.get(id)).filter((e): e is Expense => !!e);
}

type Cursor = { k: string; c?: string; i: string };

/** Spend: live, approved expenses. Every total, budget, balance and report counts only these. */
export const countedExpense = and(isNull(expenses.deletedAt), eq(expenses.status, "approved"))!;

/** Shared WHERE for lists, reports and exports. Always scoped to visible sites, and approved expenses only. */
export function expenseConditions(siteIds: string[], f: ReturnType<typeof expenseFilters.parse>): SQL[] {
  const conds: SQL[] = [inArray(expenses.siteId, siteIds), countedExpense];
  if (f.categoryCode) conds.push(eq(expenseCategories.code, f.categoryCode));
  if (f.from) conds.push(gte(expenses.expenseDate, f.from));
  if (f.to) conds.push(lte(expenses.expenseDate, f.to));
  if (f.workerName) conds.push(eq(labourWorkers.name, f.workerName));
  if (f.supplierName) conds.push(eq(suppliers.name, f.supplierName));
  if (f.source) conds.push(eq(expenses.source, f.source));
  if (f.paymentMethod) conds.push(eq(expenses.paymentMethod, f.paymentMethod));
  if (f.q) {
    // Callers join suppliers and labour_workers (baseQuery, reports), so names are searchable too.
    const like = `%${f.q.replace(/[%_\\]/g, "\\$&")}%`;
    conds.push(or(ilike(expenses.description, like), ilike(expenses.notes, like), ilike(suppliers.name, like), ilike(labourWorkers.name, like))!);
  }
  return conds;
}

/** Keyset-paginated, filtered list across the actor's sites. */
export async function listExpenses(actor: Actor, raw: ExpenseFilters = {}): Promise<Page<Expense>> {
  return pageExpenses(actor, raw, "site:read");
}

/** listExpenses limited to sites where the actor has `permission` (exports use "report:export"). */
export async function pageExpenses(actor: Actor, raw: ExpenseFilters, permission: SitePermission): Promise<Page<Expense>> {
  const f = expenseFilters.parse(raw);
  const siteIds = await scopeSiteIds(actor, f.siteId, db, permission);
  if (siteIds.length === 0) return { items: [], nextCursor: null };
  const roles = await accessibleSites(actor);

  const conds = expenseConditions(siteIds, f);
  const cursor = decodeCursor<Cursor>(f.cursor);
  const byAmount = f.sort.startsWith("amount");
  const descending = f.sort.endsWith("desc");
  const cmp = descending ? sql`<` : sql`>`;
  if (cursor) {
    conds.push(
      byAmount
        ? sql`(${expenses.totalAmount}, ${expenses.id}) ${cmp} (${cursor.k}::numeric, ${cursor.i}::uuid)`
        : sql`(${expenses.expenseDate}, ${expenses.createdAt}, ${expenses.id}) ${cmp} (${cursor.k}::date, ${cursor.c}::timestamptz, ${cursor.i}::uuid)`,
    );
  }
  const dir = descending ? desc : asc;
  const order = byAmount
    ? [dir(expenses.totalAmount), dir(expenses.id)]
    : [dir(expenses.expenseDate), dir(expenses.createdAt), dir(expenses.id)];

  const rows = (await baseQuery(db)
    .where(and(...conds))
    .orderBy(...order)
    .limit(f.limit + 1)) as ListRow[];
  const page = rows.slice(0, f.limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > f.limit && last
      ? encodeCursor(byAmount ? { k: last.amount, i: last.id } : { k: last.date, c: last.createdAtText, i: last.id })
      : null;
  return { items: await hydrate(actor, page, roles, db), nextCursor };
}

/** Distinct worker and supplier names used on the actor's sites, for filter pickers. */
export async function expenseFilterOptions(actor: Actor) {
  const siteIds = await scopeSiteIds(actor);
  if (siteIds.length === 0) return { workers: [] as string[], suppliers: [] as string[] };
  const scope = and(inArray(expenses.siteId, siteIds), countedExpense);
  const [w, s] = await Promise.all([
    db
      .selectDistinct({ name: labourWorkers.name })
      .from(expenses)
      .innerJoin(labourWorkers, eq(labourWorkers.id, expenses.labourWorkerId))
      .where(and(scope, isNotNull(expenses.labourWorkerId)))
      .orderBy(asc(labourWorkers.name)),
    db
      .selectDistinct({ name: suppliers.name })
      .from(expenses)
      .innerJoin(suppliers, eq(suppliers.id, expenses.supplierId))
      .where(and(scope, isNotNull(expenses.supplierId)))
      .orderBy(asc(suppliers.name)),
  ]);
  return { workers: w.map((r) => r.name), suppliers: s.map((r) => r.name) };
}

// ---- Submissions and the approval queue -------------------------------------------

type SubmissionCursor = { c: string; i: string };

async function keysetPage(actor: Actor, conds: SQL[], order: { key: SQL; dir: "asc" | "desc" }, f: { cursor?: string; limit: number }) {
  const cursor = decodeCursor<SubmissionCursor>(f.cursor);
  const cmp = order.dir === "desc" ? sql`<` : sql`>`;
  if (cursor) conds.push(sql`(${order.key}, ${expenses.id}) ${cmp} (${cursor.c}::timestamptz, ${cursor.i}::uuid)`);
  const dir = order.dir === "desc" ? desc : asc;
  // The sort key comes back as full-precision text so pages never skip rows.
  const rows = (await baseQuery(db, order.key)
    .where(and(...conds))
    .orderBy(dir(order.key), dir(expenses.id))
    .limit(f.limit + 1)) as (ListRow & { sortKeyText: string | null })[];
  const page = rows.slice(0, f.limit);
  const last = page.at(-1);
  const roles = await accessibleSites(actor);
  return {
    items: await hydrate(actor, page, roles, db),
    nextCursor: rows.length > f.limit && last ? encodeCursor({ c: last.sortKeyText, i: last.id }) : null,
  };
}

/**
 * The actor's own entries in every state (drafts, waiting, approved, rejected) on sites
 * where they can still add expenses. All an assistant engineer ever sees of the ledger.
 */
export async function listMyExpenses(actor: Actor, raw: unknown = {}): Promise<Page<Expense>> {
  const f = myExpensesInput.parse(raw);
  const roles = await accessibleSites(actor);
  const siteIds = [...roles].filter(([, r]) => can(r, "expense:create")).map(([id]) => id);
  if (!siteIds.length) return { items: [], nextCursor: null };
  const conds: SQL[] = [inArray(expenses.siteId, siteIds), eq(expenses.createdBy, actor.userId), isNull(expenses.deletedAt)];
  if (f.status) conds.push(eq(expenses.status, f.status));
  return keysetPage(actor, conds, { key: sql`${expenses.createdAt}`, dir: "desc" }, f);
}

/**
 * Expenses waiting for (or sent back by) review on sites the actor approves for, oldest
 * submission first. Other people's drafts are never included.
 */
export async function listReviewQueue(actor: Actor, raw: unknown = {}): Promise<Page<Expense>> {
  const f = reviewQueueInput.parse(raw);
  const siteIds = await scopeSiteIds(actor, f.siteId, db, "expense:approve");
  if (!siteIds.length) return { items: [], nextCursor: null };
  const conds: SQL[] = [inArray(expenses.siteId, siteIds), isNull(expenses.deletedAt), eq(expenses.status, f.status)];
  const pending = f.status === "pending_approval";
  const key = pending ? sql`${expenses.submittedAt}` : sql`${expenses.reviewedAt}`;
  return keysetPage(actor, conds, { key, dir: pending ? "asc" : "desc" }, f);
}

/** What's waiting for review on sites the actor approves for: never counted in spend until approved. */
export async function pendingSummary(actor: Actor, siteId?: string | null) {
  const siteIds = await scopeSiteIds(actor, siteId, db, "expense:approve");
  if (!siteIds.length) return { count: 0, amount: 0, bySite: [] as { siteId: string; count: number; amount: number }[] };
  // Grouping sets give each site and the overall total (site null) in one pass, summed in SQL.
  const rows = await db
    .select({ siteId: sql<string | null>`${expenses.siteId}`, count: sql<number>`count(*)::int`, amount: sql<string>`coalesce(sum(${expenses.totalAmount}), 0)::text` })
    .from(expenses)
    .where(and(inArray(expenses.siteId, siteIds), isNull(expenses.deletedAt), eq(expenses.status, "pending_approval"), ne(expenses.createdBy, actor.userId)))
    .groupBy(sql`grouping sets ((${expenses.siteId}), ())`);
  const total = rows.find((r) => r.siteId === null);
  const bySite = rows.flatMap((r) => (r.siteId === null ? [] : [{ siteId: r.siteId, count: r.count, amount: num(r.amount) }]));
  return { count: total?.count ?? 0, amount: num(total?.amount), bySite };
}

/** How many of the actor's own entries are in each state, for the status tabs. */
export async function myStatusCounts(actor: Actor): Promise<Record<ExpenseStatus, number>> {
  const roles = await accessibleSites(actor);
  const siteIds = [...roles].filter(([, r]) => can(r, "expense:create")).map(([id]) => id);
  const counts: Record<ExpenseStatus, number> = { draft: 0, pending_approval: 0, approved: 0, rejected: 0 };
  if (!siteIds.length) return counts;
  const rows = await db
    .select({ status: expenses.status, n: sql<number>`count(*)::int` })
    .from(expenses)
    .where(and(inArray(expenses.siteId, siteIds), eq(expenses.createdBy, actor.userId), isNull(expenses.deletedAt)))
    .groupBy(expenses.status);
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}
