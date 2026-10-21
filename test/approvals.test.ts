import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { readFileSync } from "node:fs";
import { db } from "@/db";
import { auditLog, expenses, notifications, siteMemberships } from "@/db/schema";
import type { Actor } from "@/server/authz";
import { loadActor } from "@/server/authz";
import { getAnalytics } from "@/server/data/analytics";
import { listAudit } from "@/server/data/audit";
import { getBill, listBills } from "@/server/data/bills";
import { getBudgets, upsertBudget } from "@/server/data/budgets";
import { getDashboard } from "@/server/data/dashboard";
import {
  createExpense,
  deleteExpense,
  getExpense,
  listExpenses,
  listMyExpenses,
  listReviewQueue,
  myStatusCounts,
  pendingSummary,
  reopenExpense,
  reviewExpense,
  submitExpense,
  updateExpense,
} from "@/server/data/expenses";
import { createWorker, listWorkers, recordAttendance, recordLabourPayment } from "@/server/data/labour";
import { createMaterial, listMaterials, recordPurchase } from "@/server/data/materials";
import { listNotifications, markNotificationsRead } from "@/server/data/notifications";
import { addReceipt, listReceipts, readReceipt, removeReceipt } from "@/server/data/receipts";
import { getReport, reportRows } from "@/server/data/reports";
import { getSite, listSites } from "@/server/data/sites";
import { listSuppliers, supplierDetail, supplierDirectory } from "@/server/data/suppliers";
import { reviewVoice, saveVoice } from "@/server/data/voice";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { buildReport } from "@/server/reports/build";
import { expense, newUser, world } from "./fixtures";

// Route handlers ask the session who is calling; tests swap in actors to attack them directly.
const session = vi.hoisted(() => ({ actor: null as Actor | null }));
vi.mock("@/server/session", () => ({
  getActor: async () => session.actor,
  getSessionUser: async () => null,
  requireActor: async () => session.actor,
}));
const receiptRoute = await import("@/app/api/receipts/[id]/route");
const reportRoute = await import("@/app/api/reports/download/route");

/**
 * Org A from the shared fixtures, plus two assistant engineers: asst1 on site 1, asst2 on site 2.
 * The org owner (and site 1's site owner) is the main engineer who reviews.
 */
let w: Awaited<ReturnType<typeof world>>;
let asst1: Actor;
let asst2: Actor;
let ownerEntry: string; // the owner's approved expense on site 1
let billId: string;

const item = (description: string, unitPrice: string) => ({ description, items: [{ description, unitPrice }] });
const spentOn = async (siteId: string) => (await getSite(w.a.owner, siteId)).summary.spent;
const statusOf = async (id: string) => (await db.select({ s: expenses.status }).from(expenses).where(eq(expenses.id, id)))[0].s;
const pdf = (tag: string) => new TextEncoder().encode(`%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n% ${tag}\n%%EOF`);

beforeAll(async () => {
  w = await world();
  const a1 = await newUser("Assistant One");
  const a2 = await newUser("Assistant Two");
  await db.execute(sql`insert into organization_members (organization_id, user_id, role) values (${w.orgA}, ${a1.id}, 'member'), (${w.orgA}, ${a2.id}, 'member')`);
  await db.insert(siteMemberships).values([
    { siteId: w.site1, userId: a1.id, role: "assistant" },
    { siteId: w.site2, userId: a2.id, role: "assistant" },
  ]);
  asst1 = await loadActor(a1.id);
  asst2 = await loadActor(a2.id);
  ownerEntry = (await createExpense(w.a.owner, expense(w.site1, item("Owner cement", "10000")))).id;
  await createWorker(w.a.owner, { name: "Secret Wage Worker", dailyWage: "1200", phone: "9999999999" });
  billId = (
    await (await import("@/server/data/bills")).createBill(w.a.owner, {
      siteId: w.site1,
      supplierName: "Confidential Supplier",
      billNumber: "CS-1",
      billDate: "2026-10-10",
      dueDate: "2026-10-30",
      amount: "7000",
    })
  ).id;
  await upsertBudget(w.a.owner, { siteId: w.site1, categoryCode: "materials", amount: "20000", alertPercent: 80 });
}, 600_000);

describe("assistant engineers see only their own entries", () => {
  it("get no totals, budgets, reports, other people's entries, or worker and supplier records", async () => {
    expect(await listSites(asst1)).toEqual([]);
    await expect(getSite(asst1, w.site1)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getAnalytics(asst1, { siteId: w.site1 })).rejects.toBeInstanceOf(ForbiddenError);
    expect(Number((await getAnalytics(asst1, {})).totals.month)).toBe(0);
    const dash = await getDashboard(asst1);
    expect(dash.sites).toEqual([]);
    expect(dash.recent).toEqual([]);
    await expect(listExpenses(asst1, { siteId: w.site1 })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listExpenses(asst1, {})).items).toEqual([]);
    await expect(getExpense(asst1, ownerEntry)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getBudgets(asst1, w.site1)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getReport(asst1, { siteId: w.site1, from: "2026-10-01", to: "2026-10-20" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reportRows(asst1, { from: "2026-10-01", to: "2026-10-20" }).next()).rejects.toBeInstanceOf(ForbiddenError);
    await expect(buildReport(asst1, { kind: "expenses", from: "2026-10-01", to: "2026-10-20" })).rejects.toThrow();
    await expect(listWorkers(asst1)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listSuppliers(asst1)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listMaterials(asst1)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await supplierDirectory(asst1)).toEqual([]);
    const supplierId = (await listSuppliers(w.a.owner)).find((s) => s.name === "Confidential Supplier")!.id;
    await expect(supplierDetail(asst1, supplierId)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listBills(asst1, {})).items).toEqual([]);
    await expect(getBill(asst1, billId)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listAudit(asst1, {})).items).toEqual([]);
    await expect(listAudit(asst1, { siteId: w.site1 })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await pendingSummary(asst1)).toMatchObject({ count: 0 });
  });

  it("can't record field work, change shared records or reach other sites", async () => {
    const workerId = (await listWorkers(w.a.owner))[0].id;
    await expect(recordAttendance(asst1, { siteId: w.site1, workerId, workDate: "2026-10-20", status: "present" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordLabourPayment(asst1, { siteId: w.site1, workerId, kind: "wage", amount: "100", paidOn: "2026-10-20", method: "cash" })).rejects.toBeInstanceOf(ForbiddenError);
    const cement = await createMaterial(w.a.owner, { name: "Approvals cement", unit: "bags" });
    await expect(
      recordPurchase(asst1, { siteId: w.site1, purchaseDate: "2026-10-20", paymentMethod: "cash", items: [{ materialId: cement.id, quantity: "1", unitPrice: "100" }] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createWorker(asst1, { name: "Sneaky" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(upsertBudget(asst1, { siteId: w.site1, amount: "1" })).rejects.toBeInstanceOf(ForbiddenError);
    // Unassigned sites, in their org or another, don't exist for them.
    await expect(createExpense(asst1, expense(w.site2, item("Wrong site", "100")))).rejects.toBeInstanceOf(NotFoundError);
    await expect(createExpense(asst1, expense(w.siteB, item("Other org", "100")))).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("the approval workflow", () => {
  it("starts assistant entries as drafts or submissions and ignores any status sent by the client", async () => {
    const draft = await createExpense(asst1, { ...expense(w.site1, item("Asst draft", "111")), status: "approved", reviewedBy: w.a.owner.userId });
    expect(draft.status).toBe("draft");
    const sent = await createExpense(asst1, { ...expense(w.site1, item("Asst sent", "222")), submit: true });
    expect(sent.status).toBe("pending_approval");
    expect(sent.submittedAt).toBeTruthy();
    // The main engineer's and an engineer's own entries count at once.
    expect((await getExpense(w.a.owner, ownerEntry)).status).toBe("approved");
    const eng = await createExpense(w.a.eng1, { ...expense(w.site1, item("Engineer entry", "333")), submit: false });
    expect(eng.status).toBe("approved");
  });

  it("counts only approved expenses in totals, budgets, reports and lists", async () => {
    const before = await spentOn(w.site1);
    const before2 = (await getAnalytics(w.a.owner, { siteId: w.site1 })).totals.month;
    const sent = await createExpense(asst1, { ...expense(w.site1, item("Pending sand", "5000")), submit: true });
    expect(await spentOn(w.site1)).toBe(before);
    expect((await getAnalytics(w.a.owner, { siteId: w.site1 })).totals.month).toBe(before2);
    const report = await getReport(w.a.owner, { siteId: w.site1, from: "2026-10-01", to: "2026-10-20" });
    expect(report.page.items.some((e) => e.id === sent.id)).toBe(false);
    expect((await listExpenses(w.a.owner, { siteId: w.site1, limit: 100 })).items.some((e) => e.id === sent.id)).toBe(false);
    const budget = () => getAnalytics(w.a.owner, { siteId: w.site1 }).then((a) => a.budgetLines.find((b) => b.category === "materials")!.spent);
    const budgetBefore = await budget();

    const pending = await pendingSummary(w.a.owner, w.site1);
    expect(pending.count).toBeGreaterThanOrEqual(1);

    await reviewExpense(w.a.siteOwner, { id: sent.id, decision: "approve", note: "Matches the bill" });
    expect(await spentOn(w.site1)).toBe(before + 5000);
    expect(Number(await budget())).toBe(Number(budgetBefore) + 5000);
    expect((await listExpenses(w.a.owner, { siteId: w.site1, limit: 100 })).items.some((e) => e.id === sent.id)).toBe(true);
    const approved = await getExpense(asst1, sent.id);
    expect(approved).toMatchObject({ status: "approved", reviewedBy: "Site Owner", approvalNote: "Matches the bill", canEdit: false });
  });

  it("only lets site owners review, never their own entry, and needs a reason to reject", async () => {
    const e = await createExpense(asst1, { ...expense(w.site1, item("Review rights", "400")), submit: true });
    // Those who can see a waiting entry but don't review are refused; to everyone else it doesn't exist.
    for (const who of [asst1, w.a.accountant]) await expect(reviewExpense(who, { id: e.id, decision: "approve" })).rejects.toBeInstanceOf(ForbiddenError);
    for (const who of [asst2, w.a.eng1, w.a.viewer]) await expect(reviewExpense(who, { id: e.id, decision: "approve" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(reviewExpense(w.b.owner, { id: e.id, decision: "approve" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(reviewExpense(w.a.owner, { id: e.id, decision: "reject" })).rejects.toBeInstanceOf(ZodError);
    await expect(reviewExpense(w.a.owner, { id: e.id, decision: "reject", note: "   " })).rejects.toBeInstanceOf(ZodError);
    expect(await statusOf(e.id)).toBe("pending_approval");
    // An owner's own entry is approved at once; there is nothing for them to review.
    await expect(reviewExpense(w.a.owner, { id: ownerEntry, decision: "approve" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("approves once however many reviewers press at the same time", async () => {
    const e = await createExpense(asst1, { ...expense(w.site1, item("Race", "700")), submit: true });
    const results = await Promise.allSettled([
      reviewExpense(w.a.owner, { id: e.id, decision: "approve" }),
      reviewExpense(w.a.siteOwner, { id: e.id, decision: "approve" }),
      reviewExpense(w.a.owner, { id: e.id, decision: "reject", note: "Too late" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ValidationError);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.entityId, e.id), sql`${auditLog.action} in ('expense.approve', 'expense.reject')`));
    expect(audits).toHaveLength(1);
  });

  it("submits once however often it's sent", async () => {
    const e = await createExpense(asst1, expense(w.site1, item("Double tap", "650")));
    await Promise.all([submitExpense(asst1, e.id), submitExpense(asst1, e.id)]);
    await submitExpense(asst1, e.id);
    expect(await statusOf(e.id)).toBe("pending_approval");
    const notes = await db.select().from(notifications).where(and(eq(notifications.expenseId, e.id), eq(notifications.userId, w.a.owner.userId)));
    expect(notes).toHaveLength(1);
    // Only the author submits.
    const other = await createExpense(asst1, expense(w.site1, item("Not yours", "10")));
    await expect(submitExpense(w.a.owner, other.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects with a reason, lets the author correct and resubmit, then approves", async () => {
    const e = await createExpense(asst1, { ...expense(w.site1, item("Steel rods", "9000")), submit: true });
    // While waiting, the author can't change it.
    await expect(updateExpense(asst1, { id: e.id, ...expense(w.site1, item("Steel rods", "1")) })).rejects.toBeInstanceOf(ForbiddenError);

    await reviewExpense(w.a.owner, { id: e.id, decision: "reject", note: "Bill says 8500" });
    const rejected = await getExpense(asst1, e.id);
    expect(rejected).toMatchObject({ status: "rejected", rejectionReason: "Bill says 8500", reviewedBy: "Owner A", canEdit: true, canSubmit: true });
    expect((await listNotifications(asst1)).items[0]).toMatchObject({ kind: "expense.rejected", body: "Reason: Bill says 8500" });

    const corrected = await updateExpense(asst1, { id: e.id, ...expense(w.site1, item("Steel rods", "8500")), submit: true });
    expect(corrected).toMatchObject({ status: "pending_approval", amount: 8500 });
    await reviewExpense(w.a.owner, { id: e.id, decision: "approve" });
    expect(await statusOf(e.id)).toBe("approved");

    // Entries written in one transaction share a timestamp, so compare as a set plus the ends.
    const trail = (await listAudit(w.a.owner, { siteId: w.site1, entityId: e.id })).items.map((r) => `${r.action} by ${r.actorName}`).reverse();
    expect(trail[0]).toBe("expense.create by Assistant One");
    expect(trail.at(-1)).toBe("expense.approve by Owner A");
    expect([...trail].sort()).toEqual(
      ["expense.create by Assistant One", "expense.reject by Owner A", "expense.update by Assistant One", "expense.submit by Assistant One", "expense.approve by Owner A"].sort(),
    );
    const reject = (await listAudit(w.a.owner, { siteId: w.site1, entityId: e.id })).items.find((r) => r.action === "expense.reject")!;
    expect(reject.data).toMatchObject({ from: "pending_approval", to: "rejected", note: "Bill says 8500" });
  });

  it("keeps approved entries unchangeable except by reopening with a reason", async () => {
    const e = await createExpense(asst1, { ...expense(w.site1, item("Bricks", "3000")), submit: true });
    await reviewExpense(w.a.owner, { id: e.id, decision: "approve" });
    const spent = await spentOn(w.site1);
    // Nobody edits or deletes it in place, not even the owner or accountant.
    for (const who of [asst1, w.a.owner, w.a.accountant]) {
      await expect(updateExpense(who, { id: e.id, ...expense(w.site1, item("Bricks", "1")) })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deleteExpense(who, e.id)).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(submitExpense(asst1, e.id)).rejects.toBeInstanceOf(ValidationError);
    await expect(reopenExpense(asst1, { id: e.id, reason: "please" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reopenExpense(w.a.owner, { id: e.id, reason: "" })).rejects.toBeInstanceOf(ZodError);

    await reopenExpense(w.a.owner, { id: e.id, reason: "Wrong site" });
    expect(await spentOn(w.site1)).toBe(spent - 3000);
    expect(await getExpense(asst1, e.id)).toMatchObject({ status: "rejected", rejectionReason: "Wrong site", canEdit: true });
    await submitExpense(asst1, e.id);
    await reviewExpense(w.a.owner, { id: e.id, decision: "approve" });
    expect(await spentOn(w.site1)).toBe(spent);
    const actions = (await listAudit(w.a.owner, { siteId: w.site1, entityId: e.id })).items.map((r) => r.action);
    expect(actions).toContain("expense.reopen");
  });

  it("keeps drafts private and lists only what each person may see", async () => {
    const draft = await createExpense(asst1, expense(w.site1, item("Private draft", "50")));
    await expect(getExpense(w.a.owner, draft.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(reviewExpense(w.a.owner, { id: draft.id, decision: "approve" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(getExpense(asst2, draft.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getExpense(w.a.eng1, draft.id)).rejects.toBeInstanceOf(NotFoundError);

    const mine = await listMyExpenses(asst1, { limit: 100 });
    expect(mine.items.length).toBeGreaterThan(0);
    expect(mine.items.every((e) => e.enteredBy === "Assistant One")).toBe(true);
    expect((await listMyExpenses(asst2)).items).toEqual([]);
    const counts = await myStatusCounts(asst1);
    expect(counts.draft).toBeGreaterThan(0);

    const queue = await listReviewQueue(w.a.owner, { limit: 100 });
    expect(queue.items.every((e) => e.status === "pending_approval")).toBe(true);
    expect(queue.items.some((e) => e.id === draft.id)).toBe(false);
    await expect(listReviewQueue(asst1)).resolves.toEqual({ items: [], nextCursor: null });
    await expect(listReviewQueue(w.a.accountant, { siteId: w.site1 })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("tells reviewers about submissions and keeps each person's notices their own", async () => {
    const e = await createExpense(asst1, { ...expense(w.site1, item("Notify me", "60")), submit: true });
    for (const who of [w.a.owner, w.a.siteOwner]) {
      expect((await listNotifications(who)).items.some((n) => n.expenseId === e.id && n.kind === "expense.submitted")).toBe(true);
    }
    // Site 2's assistant and the site 1 engineer aren't reviewers.
    expect((await listNotifications(asst2)).items).toEqual([]);
    expect((await listNotifications(w.a.eng1)).items.some((n) => n.expenseId === e.id)).toBe(false);
    // Marking someone else's notice read does nothing.
    const ownerNotice = (await listNotifications(w.a.owner)).items.find((n) => n.expenseId === e.id)!;
    await markNotificationsRead(asst1, [ownerNotice.id]);
    expect((await listNotifications(w.a.owner)).items.find((n) => n.id === ownerNotice.id)!.read).toBe(false);
  });
});

describe("receipts and routes against direct attacks", () => {
  it("never serve someone else's receipt to an assistant, by id or by route", async () => {
    const theirs = await addReceipt(w.a.owner, { siteId: w.site1, expenseId: ownerEntry, fileName: "owner.pdf", contentType: "application/pdf", captureSource: "file" }, pdf("owner"));
    await expect(readReceipt(asst1, theirs.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listReceipts(asst1, { expenseId: ownerEntry })).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      addReceipt(asst1, { siteId: w.site1, expenseId: ownerEntry, fileName: "x.pdf", contentType: "application/pdf", captureSource: "file" }, pdf("smuggle")),
    ).rejects.toBeInstanceOf(NotFoundError);
    session.actor = asst1;
    const res = await receiptRoute.GET(new Request(`http://test/api/receipts/${theirs.id}`), { params: Promise.resolve({ id: theirs.id }) });
    expect(res.status).toBe(404);
    session.actor = w.a.owner;
    expect((await receiptRoute.GET(new Request(`http://test/api/receipts/${theirs.id}`), { params: Promise.resolve({ id: theirs.id }) })).status).toBe(302);
  });

  it("let an assistant manage files only on their own entries until approval", async () => {
    const e = await createExpense(asst1, expense(w.site1, item("With receipt", "75")));
    const file = await addReceipt(asst1, { siteId: w.site1, expenseId: e.id, fileName: "mine.pdf", contentType: "application/pdf", captureSource: "camera" }, pdf("mine"));
    expect((await readReceipt(asst1, file.id)).fileName).toBe("mine.pdf");
    await submitExpense(asst1, e.id);
    // The reviewer can see it; the author can't swap it while it waits.
    expect((await listReceipts(w.a.owner, { expenseId: e.id })).length).toBe(1);
    await expect(removeReceipt(asst1, { id: file.id, reason: "oops" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuse downloadable reports to assistants", async () => {
    session.actor = asst1;
    const res = await reportRoute.GET(new Request(`http://test/api/reports/download?kind=expenses&format=xlsx&from=2026-10-01&to=2026-10-20`));
    expect(res.status).toBe(403);
    const forSite = await reportRoute.GET(new Request(`http://test/api/reports/download?kind=expenses&format=xlsx&from=2026-10-01&to=2026-10-20&site=${w.site1}`));
    expect(forSite.status).toBe(403);
  });
});

describe("voice entry for assistants", () => {
  it("sends confirmed entries for approval and never reveals other people's entries as duplicates", async () => {
    // The owner already recorded exactly this payment.
    await createExpense(w.a.owner, expense(w.site1, item("Sand", "4321")));
    const draft = {
      key: "k1",
      siteId: w.site1,
      date: "2026-10-20",
      dateSaid: false,
      category: "materials" as const,
      description: "Sand",
      amount: "4321",
      amountChoices: [],
      quantity: null,
      unit: null,
      worker: null,
      labourKind: null,
      supplier: null,
      paymentMode: "cash" as const,
      shareGroup: null,
      shareTotal: null,
      siteHeard: null,
      siteConfirmed: true,
      heard: "sand 4321 cash",
    };
    const body = { entries: [draft], transcript: "sand 4321 cash", language: "en", extractor: "rules", spoken: false };
    // The owner, who reads the site's records, is warned; the assistant learns nothing about it.
    expect((await reviewVoice(w.a.owner, body)).duplicates).toHaveLength(1);
    expect((await reviewVoice(asst1, body)).duplicates).toEqual([]);
    const saved = await saveVoice(asst1, { ...body, clientKey: crypto.randomUUID() });
    expect(saved.expenses.map((e) => e.status)).toEqual(["pending_approval"]);
  });
});

describe("migration", () => {
  it("backfills expenses recorded before approvals as approved by their author, without changing totals", async () => {
    const backfill = readFileSync("drizzle/0009_expense_approvals_backfill.sql", "utf8");
    await db
      .transaction(async (tx) => {
        // Recreate a row as it was before 0008: approved by default, no review columns.
        await tx.execute(sql`alter table expenses drop constraint expenses_submitted_has_time, drop constraint expenses_reviewed_has_reviewer`);
        await tx.execute(sql`update expenses set submitted_at = null, reviewed_at = null, reviewed_by = null where id = ${ownerEntry}`);
        await tx.execute(sql.raw(backfill));
        const [row] = (await tx.execute(sql`select status, submitted_at = created_at as s, reviewed_at = created_at as r, reviewed_by = created_by as b from expenses where id = ${ownerEntry}`)) as unknown as {
          status: string;
          s: boolean;
          r: boolean;
          b: boolean;
        }[];
        expect(row).toEqual({ status: "approved", s: true, r: true, b: true });
        // The checks from 0010 hold for every row afterwards.
        const migration = readFileSync("drizzle/0010_expense_status_checks.sql", "utf8").split("--> statement-breakpoint");
        for (const stmt of migration.slice(0, 2)) await tx.execute(sql.raw(stmt));
        throw new Error("rollback");
      })
      .catch((err) => {
        if ((err as Error).message !== "rollback") throw err;
      });
  });
});
