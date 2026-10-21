import "server-only";
import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { scopeSiteIds, isOrgAdmin, type Actor } from "../authz";
import { auditFilters } from "../validation";
import { decodeCursor, encodeCursor, type Conn } from "./shared";

export type AuditEntry = {
  siteId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  data?: Record<string, unknown>;
};

/**
 * Appends to the audit log. Call it with the transaction that made the change, so a
 * rolled-back change leaves no entry and a committed one always has one. There is
 * no update or delete for this table anywhere in the app.
 */
export async function audit(conn: Conn, actor: Actor, entry: AuditEntry | AuditEntry[]) {
  const list = Array.isArray(entry) ? entry : [entry];
  if (!list.length) return;
  await conn.insert(auditLog).values(
    list.map((e) => ({
      organizationId: actor.orgId,
      siteId: e.siteId ?? null,
      actorId: actor.userId,
      actorName: actor.name,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      summary: e.summary,
      data: e.data ?? null,
    })),
  );
}

export type AuditRow = {
  id: string;
  siteId: string | null;
  actorName: string;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  data: unknown;
  createdAt: string;
};

/**
 * Activity on sites where the actor may read the log (owners, accountants).
 * Org-wide entries (catalog, directory changes) are shown to org admins only.
 */
export async function listAudit(actor: Actor, raw: unknown = {}) {
  const f = auditFilters.parse(raw);
  const siteIds = await scopeSiteIds(actor, f.siteId, db, "audit:read");
  const scope: SQL[] = [];
  if (siteIds.length) scope.push(inArray(auditLog.siteId, siteIds));
  if (!f.siteId && isOrgAdmin(actor)) scope.push(sql`${auditLog.siteId} is null`);
  if (!scope.length) return { items: [] as AuditRow[], nextCursor: null };

  const conds: SQL[] = [eq(auditLog.organizationId, actor.orgId), or(...scope)!];
  if (f.entityType) conds.push(eq(auditLog.entityType, f.entityType));
  if (f.entityId) conds.push(eq(auditLog.entityId, f.entityId));
  const cursor = decodeCursor<{ c: string; i: string }>(f.cursor);
  // Full-precision text so entries in the same millisecond are neither skipped nor repeated.
  if (cursor) conds.push(sql`(${auditLog.createdAt}, ${auditLog.id}) < (${cursor.c}::timestamptz, ${cursor.i}::uuid)`);
  const rows = await db
    .select({ row: auditLog, createdAtText: sql<string>`${auditLog.createdAt}::text` })
    .from(auditLog)
    .where(and(...conds))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(f.limit + 1);
  const page = rows.slice(0, f.limit);
  const last = page.at(-1);
  return {
    items: page.map(
      ({ row: r }): AuditRow => ({
        id: r.id,
        siteId: r.siteId,
        actorName: r.actorName,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        summary: r.summary,
        data: r.data,
        createdAt: r.createdAt.toISOString(),
      }),
    ),
    nextCursor: rows.length > f.limit && last ? encodeCursor({ c: last.createdAtText, i: last.row.id }) : null,
  };
}
