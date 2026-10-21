import "server-only";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { notifications, organizationMembers, siteMemberships } from "@/db/schema";
import type { Actor } from "../authz";
import { uuid } from "../validation";
import type { Conn } from "./shared";

export type NotificationKind = "expense.submitted" | "expense.approved" | "expense.rejected" | "expense.reopened";

export type Notice = {
  id: string;
  kind: NotificationKind;
  siteId: string | null;
  expenseId: string | null;
  title: string;
  body: string | null;
  read: boolean;
  createdAt: string;
};

/**
 * Who reviews submissions on a site: the org's owners and admins, and the site's owners.
 * The person who acted is left out.
 */
export async function approversOf(siteId: string, exceptUserId: string, conn: Conn = db): Promise<string[]> {
  const rows = (await conn.execute(sql`
    select m.user_id from organization_members m
    join construction_sites s on s.organization_id = m.organization_id
    where s.id = ${siteId} and m.role in ('owner', 'admin')
    union
    select sm.user_id from site_memberships sm where sm.site_id = ${siteId} and sm.role = 'owner'
  `)) as unknown as { user_id: string }[];
  return rows.map((r) => r.user_id).filter((id) => id !== exceptUserId);
}

/** Adds notices in the caller's transaction, so a rolled-back change sends none. */
export async function notify(
  conn: Conn,
  actor: Actor,
  userIds: string[],
  n: { kind: NotificationKind; siteId: string; expenseId: string; title: string; body?: string | null },
) {
  const to = [...new Set(userIds)];
  if (!to.length) return;
  await conn.insert(notifications).values(to.map((userId) => ({ organizationId: actor.orgId, userId, ...n, body: n.body ?? null })));
}

/**
 * The actor's own notices in their current organization, newest first. Notices about sites
 * they can no longer see are left out (removing someone from a site hides them).
 */
export async function listNotifications(actor: Actor, limit = 30): Promise<{ items: Notice[]; unread: number }> {
  const visible = or(
    isNull(notifications.siteId),
    sql`exists (select 1 from ${organizationMembers} om where om.organization_id = ${notifications.organizationId} and om.user_id = ${actor.userId} and om.role in ('owner', 'admin'))`,
    sql`exists (select 1 from ${siteMemberships} sm where sm.site_id = ${notifications.siteId} and sm.user_id = ${actor.userId})`,
  );
  const mine = and(eq(notifications.userId, actor.userId), eq(notifications.organizationId, actor.orgId), visible);
  const [rows, [count]] = await Promise.all([
    db.select().from(notifications).where(mine).orderBy(desc(notifications.createdAt)).limit(limit),
    db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(and(mine, isNull(notifications.readAt))),
  ]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      kind: r.kind as NotificationKind,
      siteId: r.siteId,
      expenseId: r.expenseId,
      title: r.title,
      body: r.body,
      read: !!r.readAt,
      createdAt: r.createdAt.toISOString(),
    })),
    unread: count.n,
  };
}

/** Marks the actor's own notices read (the given ones, or all). Other people's ids are ignored. */
export async function markNotificationsRead(actor: Actor, ids?: string[]) {
  const valid = ids?.filter((id) => uuid.safeParse(id).success);
  if (ids && !valid?.length) return;
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.userId, actor.userId),
        eq(notifications.organizationId, actor.orgId),
        isNull(notifications.readAt),
        valid ? inArray(notifications.id, valid) : undefined,
      ),
    );
}
