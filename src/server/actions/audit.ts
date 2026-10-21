"use server";

import { listAudit } from "../data/audit";
import { run } from "./run";

/** Read-only: next page of the activity log. */
export async function loadAuditAction(filters: unknown) {
  return run((actor) => listAudit(actor, filters), { write: false });
}
