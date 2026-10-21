"use server";

import { createSite, deleteSite, updateSite } from "../data/sites";
import { removeBudget, upsertBudget } from "../data/budgets";
import { run } from "./run";

export async function createSiteAction(input: unknown) {
  return run((actor) => createSite(actor, input));
}

export async function updateSiteAction(input: unknown) {
  return run((actor) => updateSite(actor, input));
}

export async function deleteSiteAction(id: string) {
  return run((actor) => deleteSite(actor, id));
}

export async function upsertBudgetAction(input: unknown) {
  return run((actor) => upsertBudget(actor, input));
}

export async function removeBudgetAction(input: unknown) {
  return run((actor) => removeBudget(actor, input));
}
