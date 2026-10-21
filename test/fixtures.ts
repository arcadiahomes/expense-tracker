import { db } from "@/db";
import { organizationMembers, siteMemberships, users } from "@/db/schema";
import { loadActor, type Actor } from "@/server/authz";
import { createExpense } from "@/server/data/expenses";
import { createOrganization } from "@/server/data/organizations";
import { createSite } from "@/server/data/sites";

/** A user with no organization (like someone who just signed up through an invitation). */
export async function newUser(name: string) {
  const id = crypto.randomUUID();
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}.${id.slice(0, 8)}@test.example`;
  await db.insert(users).values({ id, name, email });
  return { id, email };
}

const user = async (name: string) => (await newUser(name)).id;

/**
 * Two organizations. Org A: org owner; on site 1 an engineer, a viewer, an
 * accountant and a site owner who is not an org admin; an engineer on site 2.
 * Org B: owner with one site.
 */
export async function world() {
  const ownerA = await user("Owner A");
  const eng1 = await user("Engineer One");
  const eng2 = await user("Engineer Two");
  const viewer = await user("Viewer");
  const accountant = await user("Accountant");
  const siteOwner = await user("Site Owner");
  const ownerB = await user("Owner B");

  const orgA = await createOrganization(ownerA, `Org A ${crypto.randomUUID().slice(0, 4)}`);
  await createOrganization(ownerB, `Org B ${crypto.randomUUID().slice(0, 4)}`);
  await db.insert(organizationMembers).values([
    { organizationId: orgA.id, userId: eng1, role: "member" },
    { organizationId: orgA.id, userId: eng2, role: "member" },
    { organizationId: orgA.id, userId: viewer, role: "member" },
    { organizationId: orgA.id, userId: accountant, role: "member" },
    { organizationId: orgA.id, userId: siteOwner, role: "member" },
  ]);

  const a = {
    owner: await loadActor(ownerA),
    eng1: await loadActor(eng1),
    eng2: await loadActor(eng2),
    viewer: await loadActor(viewer),
    accountant: await loadActor(accountant),
    siteOwner: await loadActor(siteOwner),
  };
  const b = { owner: await loadActor(ownerB) };

  const site1 = await createSite(a.owner, { name: "Site One", location: "Kochi", budget: "100000", startDate: "2026-01-01" });
  const site2 = await createSite(a.owner, { name: "Site Two", location: "Pune", budget: "50000", startDate: "2026-01-01" });
  const siteB = await createSite(b.owner, { name: "Other Org Site", location: "Delhi", budget: "75000", startDate: "2026-01-01" });

  await db.insert(siteMemberships).values([
    { siteId: site1.site.id, userId: eng1, role: "engineer" },
    { siteId: site2.site.id, userId: eng2, role: "engineer" },
    { siteId: site1.site.id, userId: viewer, role: "viewer" },
    { siteId: site1.site.id, userId: accountant, role: "accountant" },
    { siteId: site1.site.id, userId: siteOwner, role: "owner" },
  ]);

  return { a, b, orgA: orgA.id, site1: site1.site.id, site2: site2.site.id, siteB: siteB.site.id };
}

/** Minimal valid expense input; override any field. */
export function expense(siteId: string, over: Record<string, unknown> = {}) {
  return {
    siteId,
    categoryCode: "materials",
    expenseDate: "2026-10-20",
    description: "Cement",
    paymentMethod: "cash",
    items: [{ description: "Cement", quantity: "1", unit: "bags", unitPrice: "100" }],
    ...over,
  };
}

export async function addExpense(actor: Actor, siteId: string, over: Record<string, unknown> = {}) {
  return createExpense(actor, expense(siteId, over));
}
