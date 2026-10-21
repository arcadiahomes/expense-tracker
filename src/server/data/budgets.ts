import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { expenseCategories, siteBudgets } from "@/db/schema";
import { formatINR } from "@/lib/format";
import type { Category } from "@/lib/types";
import { requireSitePermission, type Actor } from "../authz";
import { budgetInput, budgetRemoveInput } from "../validation";
import { audit } from "./audit";
import { categoryId, num } from "./shared";

export type BudgetLine = { category: Category | null; amount: number; alertPercent: number; note: string | null };

/** All budget lines for a site: the overall budget (category null) and per-category lines. */
export async function getBudgets(actor: Actor, siteId: string): Promise<BudgetLine[]> {
  await requireSitePermission(actor, siteId, "site:read");
  const rows = await db
    .select({ category: expenseCategories.code, amount: siteBudgets.amount, alertPercent: siteBudgets.alertPercent, note: siteBudgets.note })
    .from(siteBudgets)
    .leftJoin(expenseCategories, eq(expenseCategories.id, siteBudgets.categoryId))
    .where(eq(siteBudgets.siteId, siteId))
    .orderBy(asc(expenseCategories.sortOrder));
  return rows.map((r) => ({ category: (r.category ?? null) as Category | null, amount: num(r.amount), alertPercent: r.alertPercent, note: r.note }));
}

/**
 * Insert or replace one budget line, with its alert threshold. Owners and accountants.
 * The overall line is also the site's headline budget, so the two never disagree.
 */
export async function upsertBudget(actor: Actor, raw: unknown) {
  const input = budgetInput.parse(raw);
  await requireSitePermission(actor, input.siteId, "finance:manage");
  await db.transaction(async (tx) => {
    const catId = input.categoryCode ? await categoryId(actor, input.categoryCode, tx) : null;
    const [before] = await tx
      .select({ amount: siteBudgets.amount, alertPercent: siteBudgets.alertPercent })
      .from(siteBudgets)
      .where(and(eq(siteBudgets.siteId, input.siteId), catId ? eq(siteBudgets.categoryId, catId) : isNull(siteBudgets.categoryId)));
    await tx
      .insert(siteBudgets)
      .values({ siteId: input.siteId, categoryId: catId, amount: input.amount, alertPercent: input.alertPercent, note: input.note, updatedBy: actor.userId })
      .onConflictDoUpdate({
        target: [siteBudgets.siteId, siteBudgets.categoryId],
        set: { amount: input.amount, alertPercent: input.alertPercent, note: input.note ?? null, updatedBy: actor.userId, updatedAt: new Date() },
      });
    await audit(tx, actor, {
      siteId: input.siteId,
      action: "budget.set",
      entityType: "budget",
      entityId: `${input.siteId}:${input.categoryCode ?? "total"}`,
      summary: `${input.categoryCode ? `${input.categoryCode[0].toUpperCase()}${input.categoryCode.slice(1)} budget` : "Total budget"} set to ${formatINR(num(input.amount))}, alert at ${input.alertPercent}%`,
      data: { before: before ?? null, after: input },
    });
  });
  return getBudgets(actor, input.siteId);
}

/** Removes a category budget line. The total budget can be changed but not removed. */
export async function removeBudget(actor: Actor, raw: unknown) {
  const input = budgetRemoveInput.parse(raw);
  await requireSitePermission(actor, input.siteId, "finance:manage");
  await db.transaction(async (tx) => {
    const catId = await categoryId(actor, input.categoryCode, tx);
    const gone = await tx.delete(siteBudgets).where(and(eq(siteBudgets.siteId, input.siteId), eq(siteBudgets.categoryId, catId))).returning();
    if (gone.length) {
      await audit(tx, actor, {
        siteId: input.siteId,
        action: "budget.remove",
        entityType: "budget",
        entityId: `${input.siteId}:${input.categoryCode}`,
        summary: `Removed the ${input.categoryCode} budget of ${formatINR(num(gone[0].amount))}`,
      });
    }
  });
  return getBudgets(actor, input.siteId);
}
