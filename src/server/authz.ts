import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type Db, type Tx } from "@/db";
import { constructionSites, organizationMembers, organizations, siteMemberships, users } from "@/db/schema";
import { can, type SitePermission, type SiteRole } from "@/lib/permissions";
import { ForbiddenError, NotFoundError, UnauthenticatedError } from "./errors";
import { uuid } from "./validation";

export type OrgRole = "owner" | "admin" | "member";
export type { SitePermission, SiteRole };
export { can };

/** Everything the data layer needs to know about who is acting. */
export type Actor = {
  userId: string;
  name: string;
  email: string;
  orgId: string;
  orgName: string;
  orgRole: OrgRole;
};

export const isOrgAdmin = (actor: Actor) => actor.orgRole === "owner" || actor.orgRole === "admin";

/** The organization owner: the one permanent admin, who alone creates and manages accounts. */
export const isAdmin = (actor: Actor) => actor.orgRole === "owner";

export function requireAdmin(actor: Actor) {
  if (!isAdmin(actor)) throw new ForbiddenError("Only the admin can do that.");
}

/** Builds the actor for a user id; deactivated users have none. Used by requireActor and by tests. */
export async function loadActor(userId: string, conn: Db | Tx = db): Promise<Actor> {
  const [row] = await conn
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      orgId: organizationMembers.organizationId,
      orgName: organizations.name,
      orgRole: organizationMembers.role,
    })
    .from(users)
    .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(and(eq(users.id, userId), isNull(users.deactivatedAt)))
    // A user in several orgs acts in the one they last switched to, else the oldest.
    .orderBy(sql`${organizationMembers.selectedAt} desc nulls last`, asc(organizationMembers.createdAt))
    .limit(1);
  if (!row) throw new UnauthenticatedError();
  return row;
}

/**
 * The actor's effective role on a site, or null when they can't see it.
 * Sites in another organization are always null.
 */
export async function siteRoleFor(actor: Actor, siteId: string, conn: Db | Tx = db): Promise<SiteRole | null> {
  if (!uuid.safeParse(siteId).success) return null;
  const [row] = await conn
    .select({ orgId: constructionSites.organizationId, role: siteMemberships.role })
    .from(constructionSites)
    .leftJoin(
      siteMemberships,
      and(eq(siteMemberships.siteId, constructionSites.id), eq(siteMemberships.userId, actor.userId)),
    )
    .where(eq(constructionSites.id, siteId))
    .limit(1);
  if (!row || row.orgId !== actor.orgId) return null;
  if (isOrgAdmin(actor)) return "owner";
  return row.role ?? null;
}

/**
 * The only gate for site-scoped work. Throws NotFound if the site is invisible
 * to the actor (so ids don't leak) and Forbidden if their role lacks the permission.
 */
export async function requireSitePermission(
  actor: Actor,
  siteId: string,
  permission: SitePermission,
  conn: Db | Tx = db,
): Promise<SiteRole> {
  const role = await siteRoleFor(actor, siteId, conn);
  if (!role) throw new NotFoundError("Site");
  if (!can(role, permission)) throw new ForbiddenError();
  return role;
}

/**
 * Org-wide reference records (workers with their wages, suppliers, the materials catalog) are
 * for org admins and anyone who reads some site's records. Assistant engineers are refused.
 */
export async function requireOrgReader(actor: Actor, conn: Db | Tx = db) {
  if (!(await readsRecords(actor, conn))) throw new ForbiddenError();
}

/** Whether the actor reads any site's records. False for someone who is only an assistant engineer. */
export async function readsRecords(actor: Actor, conn: Db | Tx = db) {
  if (isOrgAdmin(actor)) return true;
  return [...(await accessibleSites(actor, conn)).values()].some((r) => can(r, "site:read"));
}

export function requireOrgAdmin(actor: Actor) {
  if (!isOrgAdmin(actor)) throw new ForbiddenError("Only organization owners and admins can do that.");
}

/** Site id → role for every site the actor can see. Drives every list and aggregate query. */
export async function accessibleSites(actor: Actor, conn: Db | Tx = db): Promise<Map<string, SiteRole>> {
  if (isOrgAdmin(actor)) {
    const rows = await conn
      .select({ id: constructionSites.id })
      .from(constructionSites)
      .where(eq(constructionSites.organizationId, actor.orgId));
    return new Map(rows.map((r) => [r.id, "owner" as SiteRole]));
  }
  const rows = await conn
    .select({ id: siteMemberships.siteId, role: siteMemberships.role })
    .from(siteMemberships)
    .innerJoin(constructionSites, eq(constructionSites.id, siteMemberships.siteId))
    .where(and(eq(siteMemberships.userId, actor.userId), eq(constructionSites.organizationId, actor.orgId)));
  return new Map(rows.map((r) => [r.id, r.role]));
}

export async function accessibleSiteIds(actor: Actor, conn: Db | Tx = db): Promise<string[]> {
  return [...(await accessibleSites(actor, conn)).keys()];
}

/**
 * Narrows a requested site filter to the sites where the actor has `permission`
 * (reading, by default). An explicitly requested invisible site yields NotFound;
 * a visible one without the permission yields Forbidden.
 */
export async function scopeSiteIds(
  actor: Actor,
  requested?: string | null,
  conn: Db | Tx = db,
  permission: SitePermission = "site:read",
): Promise<string[]> {
  const roles = await accessibleSites(actor, conn);
  if (requested) {
    const role = roles.get(requested);
    if (!role) throw new NotFoundError("Site");
    if (!can(role, permission)) throw new ForbiddenError();
    return [requested];
  }
  return [...roles].filter(([, role]) => can(role, permission)).map(([id]) => id);
}

/** Checks that org-level reference rows (suppliers, workers, categories) belong to the actor's org. */
export async function assertSameOrg(
  table: { id: unknown; organizationId: unknown },
  ids: string[],
  actor: Actor,
  what: string,
  conn: Db | Tx = db,
) {
  if (ids.length === 0) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = table as any;
  const rows = await conn
    .select({ id: t.id })
    .from(t)
    .where(and(inArray(t.id, ids), eq(t.organizationId, actor.orgId)));
  if (rows.length !== new Set(ids).size) throw new NotFoundError(what);
}
