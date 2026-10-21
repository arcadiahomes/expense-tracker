import "server-only";
import type { ExpenseStatus } from "@/lib/types";
import { can, type Actor, type SiteRole } from "../authz";

/**
 * Who may see and change an expense, given their role on its site and its approval state.
 * Shared by expenses and receipts so a file is managed exactly when its expense is.
 */
export type ExpenseState = { createdBy: string; status: ExpenseStatus; reviewedBy: string | null; source: string };

/** Sources an assistant engineer can enter, and so the only ones that go through review. */
export const REVIEWABLE_SOURCES = ["manual", "voice"];

/** Approved by someone other than the person who entered it: corrected by reopening, never in place. */
export const approvedAfterReview = (e: ExpenseState) => e.status === "approved" && !!e.reviewedBy && e.reviewedBy !== e.createdBy;

/**
 * Drafts are their author's alone. Waiting and rejected entries are also visible to whoever
 * reviews or manages the site's expenses. Approved ones are the site's record.
 */
export function canSeeExpense(actor: Actor, role: SiteRole | null | undefined, e: ExpenseState) {
  if (!role) return false;
  if (e.createdBy === actor.userId && (can(role, "expense:create") || can(role, "site:read"))) return true;
  if (e.status === "draft") return false;
  if (e.status === "approved") return can(role, "site:read");
  return can(role, "expense:approve") || can(role, "expense:edit_any");
}

/** Why the actor may not edit, delete or restore this expense (or its receipts), or null if they may. */
export function changeRefusal(actor: Actor, role: SiteRole | null | undefined, e: ExpenseState): string | null {
  const own = e.createdBy === actor.userId && can(role, "expense:create");
  if (!own && !can(role, "expense:edit_any")) return "You can only change expenses you entered. Ask the site owner or accountant.";
  if (approvedAfterReview(e)) return "This expense was approved after review. A site owner can reopen it with a reason so it can be corrected.";
  // Assistant engineers change only their drafts and rejected entries.
  if (!can(role, "expense:direct") && !can(role, "expense:edit_any") && e.status !== "draft" && e.status !== "rejected") {
    return e.status === "pending_approval" ? "This expense is waiting for approval, so it can't be changed now." : "Approved expenses can't be changed.";
  }
  return null;
}

export const canSubmitExpense = (actor: Actor, role: SiteRole | null | undefined, e: ExpenseState) =>
  e.createdBy === actor.userId && can(role, "expense:create") && (e.status === "draft" || e.status === "rejected");

/** Site owners review; nobody approves their own entry. */
export const canReviewExpense = (actor: Actor, role: SiteRole | null | undefined, e: ExpenseState) =>
  e.status === "pending_approval" && e.createdBy !== actor.userId && can(role, "expense:approve");

export const canReopenExpense = (actor: Actor, role: SiteRole | null | undefined, e: ExpenseState) =>
  e.status === "approved" && e.createdBy !== actor.userId && can(role, "expense:approve") && REVIEWABLE_SOURCES.includes(e.source);
