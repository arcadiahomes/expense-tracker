import "server-only";
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { constructionSites, expenseCategories, expenses, labourWorkers, suppliers, users, voiceBatches } from "@/db/schema";
import type { Category, Expense } from "@/lib/types";
import { parseTranscript, type ParseContext } from "@/lib/voice-parser";
import { draftsIssues, draftItem, draftTotalPaise, hasErrors, paiseToRupees, toPaise, type DraftIssue, type VoiceDraft } from "@/lib/voice";
import { accessibleSites, can, requireSitePermission, type Actor } from "../authz";
import { ForbiddenError, ValidationError } from "../errors";
import { reportError } from "../monitoring";
import { hit, LIMITS } from "../rate-limit";
import { aiExtractionAvailable, extractWithClaude, groundEntries } from "../voice-ai";
import { expenseInput, voiceParseInput, voiceReviewInput, voiceSaveInput } from "../validation";
import { getExpenses, insertExpenses } from "./expenses";
import { today, type Conn } from "./shared";

// ---- Consent -------------------------------------------------------------------

export type VoiceSetup = { consentedAt: string | null; aiAvailable: boolean };

export async function getVoiceSetup(actor: Actor): Promise<VoiceSetup> {
  const [u] = await db.select({ at: users.voiceConsentAt }).from(users).where(eq(users.id, actor.userId)).limit(1);
  return { consentedAt: u?.at?.toISOString() ?? null, aiAvailable: aiExtractionAvailable() };
}

/** Records that the user read the voice notice and agreed. Only ever the actor's own row. */
export async function recordVoiceConsent(actor: Actor): Promise<VoiceSetup> {
  await db.update(users).set({ voiceConsentAt: new Date() }).where(eq(users.id, actor.userId));
  return getVoiceSetup(actor);
}

export async function withdrawVoiceConsent(actor: Actor): Promise<VoiceSetup> {
  await db.update(users).set({ voiceConsentAt: null }).where(eq(users.id, actor.userId));
  return getVoiceSetup(actor);
}

// ---- Reading a transcript -----------------------------------------------------

/** Sites the actor can add expenses to right now: the permission, and not completed. */
async function writableSites(actor: Actor, conn: Conn = db) {
  const roles = await accessibleSites(actor, conn);
  const ids = [...roles].filter(([, role]) => can(role, "expense:create")).map(([id]) => id);
  if (!ids.length) return [];
  const rows = await conn
    .select({ id: constructionSites.id, name: constructionSites.name, status: constructionSites.status })
    .from(constructionSites)
    .where(inArray(constructionSites.id, ids));
  return rows.filter((s) => s.status !== "completed").map(({ id, name }) => ({ id, name }));
}

/**
 * Worker and supplier names, to recognise them in speech. Names only (no wages, phones or
 * balances), so an assistant engineer can name who they paid without seeing their records.
 */
export async function knownNames(actor: Actor) {
  const [workers, supplierRows] = await Promise.all([
    db
      .select({ name: labourWorkers.name })
      .from(labourWorkers)
      .where(and(eq(labourWorkers.organizationId, actor.orgId), eq(labourWorkers.active, true)))
      .orderBy(asc(labourWorkers.name)),
    db.select({ name: suppliers.name }).from(suppliers).where(eq(suppliers.organizationId, actor.orgId)).orderBy(asc(suppliers.name)),
  ]);
  return { workers: workers.map((w) => w.name), suppliers: supplierRows.map((s) => s.name) };
}

export type ParsedVoice = {
  entries: VoiceDraft[];
  extractor: "rules" | "claude";
  /** Set when AI reading was expected but the basic reader was used instead. */
  notice?: string;
};

/**
 * Transcript → drafts for review. Nothing is saved. Uses Claude when it's set up
 * and the user agreed to the voice notice; otherwise, or if Claude fails, the
 * rule-based reader.
 */
export async function parseVoice(actor: Actor, raw: unknown): Promise<ParsedVoice> {
  const input = voiceParseInput.parse(raw);
  await requireSitePermission(actor, input.siteId, "expense:create");
  const [sites, known, setup] = await Promise.all([writableSites(actor), knownNames(actor), getVoiceSetup(actor)]);
  if (!sites.some((s) => s.id === input.siteId)) throw new ForbiddenError("This site is completed. Expenses can't be added to it.");

  const ctx: ParseContext = { today: today(), sites, defaultSiteId: input.siteId, ...known };
  if (setup.aiAvailable && setup.consentedAt) {
    if (!(await hit(`ai:${actor.userId}`, LIMITS.aiRead)).allowed) {
      return {
        entries: parseTranscript(input.transcript, ctx),
        extractor: "rules",
        notice: "You've used AI reading a lot in the last hour, so a basic reader was used. Check each entry carefully.",
      };
    }
    try {
      const out = await extractWithClaude(input.transcript, ctx);
      return { entries: groundEntries(out, input.transcript, ctx), extractor: "claude" };
    } catch (err) {
      // The user still gets the basic reader; the failure is reported for follow-up.
      void reportError(err, { source: "voice-ai", userId: actor.userId });
      return {
        entries: parseTranscript(input.transcript, ctx),
        extractor: "rules",
        notice: "AI reading is unavailable right now, so a basic reader was used. Check each entry carefully.",
      };
    }
  }
  return { entries: parseTranscript(input.transcript, ctx), extractor: "rules" };
}

// ---- Review and save -------------------------------------------------------------

export type VoiceDuplicate = {
  index: number;
  /** "batch": the same as an earlier entry in this list. "saved": matches an expense already recorded. */
  kind: "batch" | "saved";
  otherIndex?: number;
  description?: string;
  amount?: string;
  date?: string;
  enteredBy?: string;
  createdAt?: string;
};

export type VoiceReview = {
  issues: DraftIssue[][];
  duplicates: VoiceDuplicate[];
  /** Server-computed total of the entries, in rupees. */
  total: string;
  ready: boolean;
};

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/** Two payments look like the same one: same site, day, category and amount, and the same worker or item. */
function looksSame(
  a: { siteId: string; date: string; category: Category | null; paise: number | null; worker: string | null; description: string },
  b: typeof a,
) {
  if (a.siteId !== b.siteId || a.date !== b.date || a.category !== b.category || a.paise === null || a.paise !== b.paise) return false;
  return a.category === "labour" ? same(a.worker, b.worker) : same(a.description, b.description);
}

/**
 * Earlier entries the actor could see that look the same: their own in any state, and
 * other people's non-drafts on sites whose records they read. An assistant engineer is
 * only ever compared with their own entries, so nothing of anyone else's is revealed.
 */
async function findDuplicates(actor: Actor, entries: VoiceDraft[], conn: Conn): Promise<VoiceDuplicate[]> {
  const keyed = entries.map((d) => ({ ...d, paise: toPaise(d.amount) }));
  const out: VoiceDuplicate[] = [];
  keyed.forEach((d, i) => {
    const j = keyed.findIndex((o, k) => k < i && looksSame(o, d));
    if (j >= 0) out.push({ index: i, kind: "batch", otherIndex: j });
  });

  const candidates = keyed.filter((d) => d.paise !== null && d.category);
  if (!candidates.length) return out;
  const roles = await accessibleSites(actor, conn);
  const readable = [...roles].filter(([, role]) => can(role, "site:read")).map(([id]) => id);
  const rows = await conn
    .select({
      siteId: expenses.siteId,
      date: expenses.expenseDate,
      category: expenseCategories.code,
      amount: expenses.totalAmount,
      description: expenses.description,
      worker: labourWorkers.name,
      enteredBy: users.name,
      createdAt: expenses.createdAt,
    })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
    .innerJoin(users, eq(users.id, expenses.createdBy))
    .leftJoin(labourWorkers, eq(labourWorkers.id, expenses.labourWorkerId))
    .where(
      and(
        inArray(expenses.siteId, [...new Set(candidates.map((d) => d.siteId))]),
        inArray(expenses.expenseDate, [...new Set(candidates.map((d) => d.date))]),
        inArray(expenses.totalAmount, [...new Set(candidates.map((d) => (d.paise! / 100).toFixed(2)))]),
        isNull(expenses.deletedAt),
        or(
          eq(expenses.createdBy, actor.userId),
          readable.length ? and(inArray(expenses.siteId, readable), ne(expenses.status, "draft")) : undefined,
        ),
      ),
    );
  keyed.forEach((d, i) => {
    if (out.some((o) => o.index === i)) return;
    const hit = rows.find((r) =>
      looksSame(d, { ...r, category: r.category as Category, paise: toPaise(r.amount), worker: r.worker }),
    );
    if (hit) {
      out.push({
        index: i,
        kind: "saved",
        description: hit.description,
        amount: paiseToRupees(toPaise(hit.amount) ?? 0),
        date: hit.date,
        enteredBy: hit.enteredBy,
        createdAt: hit.createdAt.toISOString(),
      });
    }
  });
  return out;
}

async function review(actor: Actor, entries: VoiceDraft[], conn: Conn): Promise<VoiceReview> {
  const [sites, known] = await Promise.all([writableSites(actor, conn), knownNames(actor)]);
  const ctx = { today: today(), siteIds: sites.map((s) => s.id), ...known };
  const issues = draftsIssues(entries, ctx);
  const duplicates = await findDuplicates(actor, entries, conn);
  return { issues, duplicates, total: paiseToRupees(draftTotalPaise(entries)), ready: !issues.some(hasErrors) };
}

/** Checks reviewed drafts without saving: what still needs fixing, likely duplicates, and the total. */
export async function reviewVoice(actor: Actor, raw: unknown): Promise<VoiceReview> {
  const input = voiceReviewInput.parse(raw);
  return review(actor, input.entries, db);
}

export type SavedVoice = { expenses: Expense[]; total: string; replayed: boolean };

const hashEntries = (entries: VoiceDraft[]) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        entries.map((d) => [d.siteId, d.date, d.category, toPaise(d.amount), d.description.trim(), d.quantity, d.unit, d.worker, d.labourKind, d.supplier, d.paymentMode]),
      ),
    )
    .digest("hex");

/**
 * Saves confirmed drafts as expenses in one transaction. Refuses anything that
 * still has an open question, and likely duplicates the user didn't confirm.
 * Retrying with the same clientKey returns the first save instead of a second.
 */
export async function saveVoice(actor: Actor, raw: unknown): Promise<SavedVoice> {
  const input = voiceSaveInput.parse(raw);
  const payloadHash = hashEntries(input.entries);

  const result = await db.transaction(async (tx) => {
    // Blocks on a concurrent save with the same key until it commits or rolls back.
    const [batch] = await tx
      .insert(voiceBatches)
      .values({
        organizationId: actor.orgId,
        createdBy: actor.userId,
        clientKey: input.clientKey,
        payloadHash,
        transcript: input.transcript,
        language: input.language,
        extractor: input.extractor,
        capturedAt: input.capturedAt ? new Date(Math.min(Date.parse(input.capturedAt), Date.now())) : null,
      })
      .onConflictDoNothing({ target: [voiceBatches.createdBy, voiceBatches.clientKey] })
      .returning({ id: voiceBatches.id });
    if (!batch) {
      const [prior] = await tx
        .select({ hash: voiceBatches.payloadHash, ids: voiceBatches.expenseIds })
        .from(voiceBatches)
        .where(and(eq(voiceBatches.createdBy, actor.userId), eq(voiceBatches.clientKey, input.clientKey)));
      if (prior.hash !== payloadHash) {
        throw new ValidationError("These entries were already saved, and have changed since. Start a new entry to save more.", {
          clientKey: "Already saved with different entries.",
        });
      }
      return { ids: prior.ids, replayed: true };
    }

    const checked = await review(actor, input.entries, tx);
    const fieldErrors: Record<string, string> = {};
    checked.issues.forEach((list, i) => {
      for (const issue of list) if (issue.level === "error") fieldErrors[`entries.${i}.${issue.field}`] ??= issue.message;
    });
    const firstError = Object.entries(fieldErrors)[0];
    if (firstError) {
      const n = Number(firstError[0].split(".")[1]) + 1;
      throw new ValidationError(`Entry ${n}: ${firstError[1]}`, fieldErrors);
    }
    const unconfirmed = checked.duplicates.filter((d) => !input.acknowledgedDuplicates.includes(d.index));
    if (unconfirmed.length) {
      throw new ValidationError(
        `Entry ${unconfirmed[0].index + 1} looks like a duplicate. Remove it, or confirm it's a separate payment.`,
        Object.fromEntries(unconfirmed.map((d) => [`entries.${d.index}.duplicate`, "Looks like a duplicate."])),
      );
    }

    const source = input.spoken ? "voice" : "manual";
    const inputs = input.entries.map((d) =>
      expenseInput.parse({
        siteId: d.siteId,
        categoryCode: d.category,
        expenseDate: d.date,
        description: d.description,
        paymentMethod: d.paymentMode,
        source,
        supplierName: d.category !== "labour" ? (d.supplier ?? undefined) : undefined,
        workerName: d.category === "labour" ? (d.worker ?? undefined) : undefined,
        labourKind: d.category === "labour" && d.worker ? (d.labourKind ?? "wage") : undefined,
        voiceTranscript: input.transcript,
        items: [draftItem(d)],
        submit: input.submit,
      }),
    );
    const ids = await insertExpenses(actor, inputs, tx);
    await tx.update(voiceBatches).set({ expenseIds: ids }).where(eq(voiceBatches.id, batch.id));
    return { ids, replayed: false };
  });

  const [saved, [sum]] = await Promise.all([
    getExpenses(actor, result.ids),
    db
      .select({ total: sql<string>`coalesce(sum(${expenses.totalAmount}), 0)::text` })
      .from(expenses)
      .where(and(inArray(expenses.id, result.ids), isNull(expenses.deletedAt))),
  ]);
  return { expenses: saved, total: paiseToRupees(toPaise(sum.total) ?? 0), replayed: result.replayed };
}
