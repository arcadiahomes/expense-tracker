import "server-only";
import { and, eq } from "drizzle-orm";
import { db, type Db, type Tx } from "@/db";
import { constructionSites, expenseCategories, labourWorkers, suppliers } from "@/db/schema";
import { todayInIndia } from "@/lib/dates";
import type { Category } from "@/lib/types";
import type { Actor } from "../authz";
import { NotFoundError, ValidationError } from "../errors";

export type Conn = Db | Tx;

/** Business "today" (IST). APP_TODAY pins it for tests and demos. */
export function today() {
  return process.env.APP_TODAY || todayInIndia();
}

/**
 * Review columns for an expense that counts at once (bill payments, purchases, labour
 * payments, and expenses from anyone but an assistant engineer): approved by whoever entered it.
 */
export function enteredApproved(actor: Actor, at = new Date()) {
  return { status: "approved" as const, submittedAt: at, reviewedBy: actor.userId, reviewedAt: at };
}

/** numeric strings from Postgres → number, for display DTOs only. */
export const num = (v: string | number | null | undefined) => (v == null ? 0 : Number(v));

export const SITE_STATUS_TO_DB = { active: "active", "on-hold": "on_hold", completed: "completed" } as const;
export const SITE_STATUS_FROM_DB = { active: "active", on_hold: "on-hold", completed: "completed" } as const;

export async function categoryId(actor: Actor, code: Category, conn: Conn = db) {
  const [row] = await conn
    .select({ id: expenseCategories.id })
    .from(expenseCategories)
    .where(and(eq(expenseCategories.organizationId, actor.orgId), eq(expenseCategories.code, code)))
    .limit(1);
  if (!row) throw new NotFoundError("Category");
  return row.id;
}

/** Org-scoped find-or-create by exact name; keeps free-text supplier entry in the UI. */
export async function supplierIdByName(actor: Actor, name: string | undefined, conn: Conn = db) {
  if (!name) return null;
  const [row] = await conn
    .insert(suppliers)
    .values({ organizationId: actor.orgId, name })
    .onConflictDoUpdate({ target: [suppliers.organizationId, suppliers.name], set: { name } })
    .returning({ id: suppliers.id });
  return row.id;
}

export async function workerIdByName(actor: Actor, name: string | undefined, conn: Conn = db) {
  if (!name) return null;
  const [row] = await conn
    .insert(labourWorkers)
    .values({ organizationId: actor.orgId, name })
    .onConflictDoUpdate({ target: [labourWorkers.organizationId, labourWorkers.name], set: { name } })
    .returning({ id: labourWorkers.id });
  return row.id;
}

/** Completed sites are closed for new spending, stock movements and attendance. */
export async function requireOpenSite(siteId: string, conn: Conn = db) {
  const [row] = await conn.select({ status: constructionSites.status }).from(constructionSites).where(eq(constructionSites.id, siteId)).limit(1);
  if (!row) throw new NotFoundError("Site");
  if (row.status === "completed") throw new ValidationError("This site is completed. Reopen it to record new entries.");
}

/** Postgres unique violation → friendly validation error on a field. */
export function rethrowUnique(err: unknown, field: string, message: string): never {
  const code = (err as { code?: string; cause?: { code?: string } })?.code ??
    (err as { cause?: { code?: string } })?.cause?.code;
  if (code === "23505") throw new ValidationError(message, { [field]: message });
  throw err;
}

/** Opaque pagination cursor. */
export function encodeCursor(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor<T>(cursor: string | undefined): T | null {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as T;
  } catch {
    throw new ValidationError("That page link is invalid. Reload and try again.");
  }
}
