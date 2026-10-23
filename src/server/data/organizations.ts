import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { expenseCategories, organizationMembers, organizations } from "@/db/schema";
import { CATEGORIES, type OrganizationProfile } from "@/lib/types";
import { requireOrgAdmin, type Actor } from "../authz";
import { NotFoundError } from "../errors";
import { organizationProfileInput, uuid } from "../validation";
import { audit } from "./audit";
import type { Conn } from "./shared";

const CATEGORY_NAMES = {
  materials: "Materials",
  labour: "Labour",
  transport: "Transport",
  equipment: "Equipment",
  other: "Other",
} as const;

function slugify(name: string) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "org";
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

/** New tenant with its owner and the five standard expense categories. */
export async function createOrganization(ownerUserId: string, name: string, conn: Conn = db) {
  const [org] = await conn.insert(organizations).values({ name, slug: slugify(name) }).returning();
  await conn.insert(organizationMembers).values({ organizationId: org.id, userId: ownerUserId, role: "owner" });
  await conn.insert(expenseCategories).values(
    CATEGORIES.map((code, i) => ({ organizationId: org.id, code, name: CATEGORY_NAMES[code], sortOrder: i })),
  );
  return org;
}

/** Every organization the user belongs to, for the workspace switcher. */
export async function listMyOrganizations(actor: Actor) {
  const rows = await db
    .select({ id: organizations.id, name: organizations.name, role: organizationMembers.role })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, actor.userId))
    .orderBy(asc(organizations.name));
  return rows.map((r) => ({ ...r, active: r.id === actor.orgId }));
}

/** Makes one of the user's own organizations active; anything else is "not found". */
export async function selectOrganization(actor: Actor, organizationId: string) {
  if (!uuid.safeParse(organizationId).success) throw new NotFoundError("Organization");
  const rows = await db
    .update(organizationMembers)
    .set({ selectedAt: new Date() })
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, actor.userId)))
    .returning({ id: organizationMembers.organizationId });
  if (rows.length === 0) throw new NotFoundError("Organization");
}

/** The company's name and contact details, as printed on invoices and receipts. */
export async function organizationProfile(actor: Actor, conn: Conn = db): Promise<OrganizationProfile> {
  const [org] = await conn
    .select({ name: organizations.name, address: organizations.address, phone: organizations.phone, email: organizations.email, website: organizations.website })
    .from(organizations)
    .where(eq(organizations.id, actor.orgId))
    .limit(1);
  return { name: org.name, address: org.address ?? "", phone: org.phone ?? "", email: org.email ?? "", website: org.website ?? "" };
}

/** Org owners and admins set the contact details; a blank field clears it. */
export async function updateOrganizationProfile(actor: Actor, raw: unknown): Promise<OrganizationProfile> {
  requireOrgAdmin(actor);
  const input = organizationProfileInput.parse(raw);
  await db.transaction(async (tx) => {
    await tx
      .update(organizations)
      .set({ address: input.address ?? null, phone: input.phone ?? null, email: input.email ?? null, website: input.website ?? null })
      .where(eq(organizations.id, actor.orgId));
    await audit(tx, actor, { action: "organization.profile", entityType: "organization", entityId: actor.orgId, summary: "Updated the company details on invoices and receipts", data: input });
  });
  return organizationProfile(actor);
}
