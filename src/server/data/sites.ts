import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  constructionSites,
  organizationMembers,
  siteBudgets,
  siteMemberships,
  users,
} from "@/db/schema";
import type { CategoryTotal, SiteSummary } from "@/lib/analytics";
import { daysBetween, monthStart } from "@/lib/dates";
import { CATEGORIES, type Category, type SiteRole } from "@/lib/types";
import {
  accessibleSites,
  can,
  isOrgAdmin,
  requireOrgAdmin,
  requireSitePermission,
  type Actor,
} from "../authz";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { siteInput, siteMemberRoleInput, siteUpdateInput } from "../validation";
import { SITE_STATUS_FROM_DB, num, rethrowUnique, today, type Conn } from "./shared";

type SummaryRow = {
  id: string;
  name: string;
  location: string;
  client_name: string | null;
  status: "active" | "on_hold" | "completed";
  start_date: string;
  budget: string | null;
  alert_percent: number | null;
  spent: string;
  month_spend: string;
  last_entry: string | null;
  entry_count: number;
  engineer_id: string | null;
  engineer_name: string | null;
};

/** Budget, spend and engineer for each site, computed in one SQL pass. */
async function summaries(siteIds: string[], roles: Map<string, SiteRole>, conn: Conn = db): Promise<SiteSummary[]> {
  if (siteIds.length === 0) return [];
  const t = today();
  const ms = monthStart(t);
  const rows = (await conn.execute(sql`
    select s.id, s.name, s.location, s.client_name, s.status, s.start_date::text as start_date,
           b.amount as budget, b.alert_percent,
           coalesce(e.spent, 0) as spent,
           coalesce(e.month_spend, 0) as month_spend,
           e.last_entry::text as last_entry,
           coalesce(e.entry_count, 0)::int as entry_count,
           eng.id as engineer_id, eng.name as engineer_name
    from construction_sites s
    left join site_budgets b on b.site_id = s.id and b.category_id is null
    left join lateral (
      select sum(x.total_amount) as spent,
             sum(x.total_amount) filter (where x.expense_date >= ${ms}::date) as month_spend,
             max(x.expense_date) as last_entry,
             count(*) as entry_count
      from expenses x
      where x.site_id = s.id and x.deleted_at is null and x.status = 'approved'
    ) e on true
    left join lateral (
      select u.id, u.name from site_memberships m join users u on u.id = m.user_id
      where m.site_id = s.id and m.role = 'engineer'
      order by m.created_at limit 1
    ) eng on true
    where s.id in ${siteIds}
    order by case s.status when 'active' then 0 when 'on_hold' then 1 else 2 end, s.created_at desc
  `)) as unknown as SummaryRow[];

  return rows.map((r) => {
    const budget = num(r.budget);
    const spent = num(r.spent);
    return {
      site: {
        id: r.id,
        name: r.name,
        location: r.location,
        client: r.client_name ?? "",
        engineer: r.engineer_name ?? "",
        engineerUserId: r.engineer_id,
        budget,
        startDate: r.start_date,
        status: SITE_STATUS_FROM_DB[r.status],
        role: roles.get(r.id) ?? "viewer",
      },
      spent,
      balance: budget - spent,
      utilisation: budget > 0 ? spent / budget : 0,
      alertAt: (r.alert_percent ?? 80) / 100,
      monthSpend: num(r.month_spend),
      lastEntry: r.last_entry ?? undefined,
      daysRunning: Math.max(0, daysBetween(r.start_date, t)),
      entryCount: r.entry_count,
    };
  });
}

/** Sites whose records the actor reads, with their figures. Sites an assistant engineer only submits to aren't listed. */
export async function listSites(actor: Actor): Promise<SiteSummary[]> {
  const roles = await accessibleSites(actor);
  return summaries([...roles].filter(([, r]) => can(r, "site:read")).map(([id]) => id), roles);
}

/** Site summary plus its all-time category split. NotFound if invisible. */
export async function getSite(actor: Actor, siteId: string) {
  const role = await requireSitePermission(actor, siteId, "site:read");
  const [summary] = await summaries([siteId], new Map([[siteId, role]]));
  if (!summary) throw new NotFoundError("Site");
  const rows = (await db.execute(sql`
    select c.code, coalesce(sum(x.total_amount), 0) as amount
    from expense_categories c
    left join expenses x on x.category_id = c.id and x.site_id = ${siteId} and x.deleted_at is null and x.status = 'approved'
    where c.organization_id = ${actor.orgId}
    group by c.code
  `)) as unknown as { code: Category; amount: string }[];
  const byCode = new Map(rows.map((r) => [r.code, num(r.amount)]));
  const categories: CategoryTotal[] = CATEGORIES.map((c) => ({ category: c, amount: byCode.get(c) ?? 0 }));
  return { summary, categories };
}

async function assertOrgMember(actor: Actor, userId: string, conn: Conn) {
  const [row] = await conn
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, actor.orgId), eq(organizationMembers.userId, userId)))
    .limit(1);
  if (!row) throw new ValidationError("That person isn't in your organization.", { engineerUserId: "Pick someone from your organization." });
}

async function upsertOverallBudget(siteId: string, amount: string, actor: Actor, conn: Conn) {
  await conn
    .insert(siteBudgets)
    .values({ siteId, categoryId: null, amount, updatedBy: actor.userId })
    .onConflictDoUpdate({
      target: [siteBudgets.siteId, siteBudgets.categoryId],
      set: { amount, updatedBy: actor.userId, updatedAt: new Date() },
    });
}

async function assignEngineer(siteId: string, userId: string | undefined, actor: Actor, conn: Conn) {
  if (!userId) return;
  await assertOrgMember(actor, userId, conn);
  await conn
    .insert(siteMemberships)
    .values({ siteId, userId, role: "engineer", addedBy: actor.userId })
    .onConflictDoNothing();
}

export async function createSite(actor: Actor, raw: unknown): Promise<SiteSummary> {
  requireOrgAdmin(actor);
  const input = siteInput.parse(raw);
  const id = await db
    .transaction(async (tx) => {
      const [site] = await tx
        .insert(constructionSites)
        .values({
          organizationId: actor.orgId,
          name: input.name,
          location: input.location,
          clientName: input.clientName,
          status: input.status,
          startDate: input.startDate,
          createdBy: actor.userId,
        })
        .returning({ id: constructionSites.id });
      await tx.insert(siteMemberships).values({ siteId: site.id, userId: actor.userId, role: "owner", addedBy: actor.userId });
      await upsertOverallBudget(site.id, input.budget, actor, tx);
      await assignEngineer(site.id, input.engineerUserId, actor, tx);
      return site.id;
    })
    .catch((err) => rethrowUnique(err, "name", "You already have a site with this name."));
  const roles = await accessibleSites(actor);
  const [summary] = await summaries([id], roles);
  return summary;
}

export async function updateSite(actor: Actor, raw: unknown): Promise<SiteSummary> {
  const input = siteUpdateInput.parse(raw);
  await requireSitePermission(actor, input.id, "site:manage");
  await db
    .transaction(async (tx) => {
      await tx
        .update(constructionSites)
        .set({
          name: input.name,
          location: input.location,
          clientName: input.clientName ?? null,
          status: input.status,
          startDate: input.startDate,
        })
        .where(and(eq(constructionSites.id, input.id), eq(constructionSites.organizationId, actor.orgId)));
      await upsertOverallBudget(input.id, input.budget, actor, tx);
      await assignEngineer(input.id, input.engineerUserId, actor, tx);
    })
    .catch((err) => rethrowUnique(err, "name", "You already have a site with this name."));
  const roles = await accessibleSites(actor);
  const [summary] = await summaries([input.id], roles);
  return summary;
}

/** Deletes the site and, by cascade, its expenses, budgets, bills, attendance and receipts. */
export async function deleteSite(actor: Actor, siteId: string) {
  requireOrgAdmin(actor);
  await requireSitePermission(actor, siteId, "site:manage");
  const removed = await db
    .delete(constructionSites)
    .where(and(eq(constructionSites.id, siteId), eq(constructionSites.organizationId, actor.orgId)))
    .returning({ id: constructionSites.id });
  if (removed.length === 0) throw new NotFoundError("Site");
}

// ---- Members ----------------------------------------------------------------

/** Everyone in the organization, with emails. Org owners and admins only. */
export async function listOrgMembers(actor: Actor) {
  requireOrgAdmin(actor);
  return db
    .select({ id: users.id, name: users.name, email: users.email, role: organizationMembers.role })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.organizationId, actor.orgId))
    .orderBy(users.name);
}

/** People on a site, with emails. Site owners (and org owners/admins) only. */
export async function listSiteMembers(actor: Actor, siteId: string) {
  await requireSitePermission(actor, siteId, "site:manage");
  return db
    .select({ id: users.id, name: users.name, email: users.email, role: siteMemberships.role })
    .from(siteMemberships)
    .innerJoin(users, eq(users.id, siteMemberships.userId))
    .where(eq(siteMemberships.siteId, siteId))
    .orderBy(users.name);
}

/**
 * Site owners manage everyone else on their site; only org owners/admins may
 * grant or take away site ownership, or change their own access.
 */
function assertMayChange(actor: Actor, userId: string, from: SiteRole, to: SiteRole | null) {
  if (isOrgAdmin(actor)) return;
  if (userId === actor.userId) throw new ForbiddenError("You can't change your own access. Ask an organization owner.");
  if (from === "owner" || to === "owner") {
    throw new ForbiddenError("Only organization owners and admins can add or remove site owners.");
  }
}

async function lockMembership(siteId: string, userId: string, conn: Conn) {
  const [row] = await conn
    .select({ role: siteMemberships.role })
    .from(siteMemberships)
    .where(and(eq(siteMemberships.siteId, siteId), eq(siteMemberships.userId, userId)))
    .for("update")
    .limit(1);
  if (!row) throw new NotFoundError("Member");
  return row.role;
}

/** Changes the role of someone already on the site. New people get accounts from the admin (data/accounts.ts). */
export async function setSiteMemberRole(actor: Actor, raw: unknown) {
  const input = siteMemberRoleInput.parse(raw);
  await requireSitePermission(actor, input.siteId, "site:manage");
  await db.transaction(async (tx) => {
    const from = await lockMembership(input.siteId, input.userId, tx);
    assertMayChange(actor, input.userId, from, input.role);
    await tx
      .update(siteMemberships)
      .set({ role: input.role })
      .where(and(eq(siteMemberships.siteId, input.siteId), eq(siteMemberships.userId, input.userId)));
  });
}

export async function removeSiteMember(actor: Actor, siteId: string, userId: string) {
  await requireSitePermission(actor, siteId, "site:manage");
  await db.transaction(async (tx) => {
    const from = await lockMembership(siteId, userId, tx);
    assertMayChange(actor, userId, from, null);
    await tx.delete(siteMemberships).where(and(eq(siteMemberships.siteId, siteId), eq(siteMemberships.userId, userId)));
  });
}

/** Overall budget rows for a set of sites (used by reports). */
export async function overallBudgets(siteIds: string[]) {
  if (siteIds.length === 0) return new Map<string, number>();
  const rows = await db
    .select({ siteId: siteBudgets.siteId, amount: siteBudgets.amount })
    .from(siteBudgets)
    .where(and(inArray(siteBudgets.siteId, siteIds), sql`${siteBudgets.categoryId} is null`));
  return new Map(rows.map((r) => [r.siteId, num(r.amount)]));
}

/** The site a site-scoped page shows: the requested one if its records are readable, else the first such site by name. */
export async function pickSite(actor: Actor, requested: unknown): Promise<string | null> {
  const readable = [...(await accessibleSites(actor))].filter(([, r]) => can(r, "site:read")).map(([id]) => id);
  if (typeof requested === "string" && readable.includes(requested)) return requested;
  if (!readable.length) return null;
  const [first] = await db
    .select({ id: constructionSites.id })
    .from(constructionSites)
    .where(inArray(constructionSites.id, readable))
    .orderBy(asc(constructionSites.name))
    .limit(1);
  return first?.id ?? null;
}
