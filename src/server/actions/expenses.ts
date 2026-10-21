"use server";

import type { ExpenseFilters } from "../validation";
import {
  createExpense,
  createExpenses,
  deleteExpense,
  listExpenses,
  listMyExpenses,
  listReviewQueue,
  reopenExpense,
  restoreExpense,
  reviewExpense,
  submitExpense,
  updateExpense,
} from "../data/expenses";
import { markNotificationsRead } from "../data/notifications";
import { run } from "./run";

export async function createExpenseAction(input: unknown) {
  return run((actor) => createExpense(actor, input));
}

export async function createExpensesAction(input: unknown) {
  return run((actor) => createExpenses(actor, input));
}

export async function updateExpenseAction(input: unknown) {
  return run((actor) => updateExpense(actor, input));
}

export async function deleteExpenseAction(id: string) {
  return run((actor) => deleteExpense(actor, id));
}

export async function restoreExpenseAction(id: string) {
  return run((actor) => restoreExpense(actor, id));
}

/** Read-only: next page for "Show more" lists. */
export async function loadExpensesAction(filters: ExpenseFilters) {
  return run((actor) => listExpenses(actor, filters), { write: false });
}

/** Sends the caller's own draft or rejected expense for approval. */
export async function submitExpenseAction(id: string) {
  return run((actor) => submitExpense(actor, id));
}

/** A site owner approves or rejects (with a reason) a waiting expense. */
export async function reviewExpenseAction(input: unknown) {
  return run((actor) => reviewExpense(actor, input));
}

/** A site owner sends an approved expense back for correction, with a reason. */
export async function reopenExpenseAction(input: unknown) {
  return run((actor) => reopenExpense(actor, input));
}

/** Read-only: next page of the caller's own entries. */
export async function loadMyExpensesAction(input: unknown) {
  return run((actor) => listMyExpenses(actor, input), { write: false });
}

/** Read-only: next page of the approval queue. */
export async function loadReviewQueueAction(input: unknown) {
  return run((actor) => listReviewQueue(actor, input), { write: false });
}

/** Marks the caller's own notices read (the given ones, or all). */
export async function markNotificationsReadAction(ids?: string[]) {
  return run((actor) => markNotificationsRead(actor, Array.isArray(ids) ? ids.map(String) : undefined));
}
