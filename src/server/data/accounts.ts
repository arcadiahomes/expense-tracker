import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, inArray, isNull, max, ne, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  accounts,
  constructionSites,
  organizationMembers,
  passwordLinks,
  sessions,
  siteMemberships,
  users,
} from "@/db/schema";
import { auth } from "@/lib/auth";
import type { SiteRole } from "@/lib/permissions";
import { assertSameOrg, loadActor, requireAdmin, type Actor } from "../authz";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import {
  accountActiveInput,
  accountInput,
  accountSitesInput,
  bootstrapAdminInput,
  passwordLinkToken,
  setPasswordInput,
} from "../validation";
import { audit } from "./audit";
import { createOrganization } from "./organizations";
import type { Conn } from "./shared";

/**
 * Accounts. There is no public sign-up: the organization owner (the one permanent admin)
 * creates assistant engineer accounts, assigns their sites, deactivates them and issues
 * one-time password links. Nobody's password is ever chosen, seen or stored by anyone else.
 */

const LINK_TTL_MS = 48 * 60 * 60 * 1000;

/** Link tokens are stored only as SHA-256: a database leak doesn't hand out working links. */
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export type AccountSummary = {
  id: string;
  name: string;
  email: string;
  active: boolean;
  /** False until they set a password through their link. */
  hasPassword: boolean;
  lastSignInAt: string | null;
  sites: { id: string; name: string; role: SiteRole }[];
  /** Their unused, unexpired password link, if any (the link itself is shown only once). */
  pendingLink: { purpose: "setup" | "reset"; expiresAt: string } | null;
};

/** Everyone in the admin's organization except the admin. */
export async function listAccounts(actor: Actor): Promise<AccountSummary[]> {
  requireAdmin(actor);
  const people = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      deactivatedAt: users.deactivatedAt,
      hasPassword: sql<boolean>`exists (select 1 from ${accounts} a where a.user_id = ${users.id} and a.provider_id = 'credential' and a.password is not null)`,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.organizationId, actor.orgId), ne(organizationMembers.role, "owner")))
    .orderBy(asc(users.name));
  if (people.length === 0) return [];
  const ids = people.map((p) => p.id);

  const [siteRows, lastSessions, links] = await Promise.all([
    db
      .select({ userId: siteMemberships.userId, id: constructionSites.id, name: constructionSites.name, role: siteMemberships.role })
      .from(siteMemberships)
      .innerJoin(constructionSites, eq(constructionSites.id, siteMemberships.siteId))
      .where(and(inArray(siteMemberships.userId, ids), eq(constructionSites.organizationId, actor.orgId)))
      .orderBy(asc(constructionSites.name)),
    db.select({ userId: sessions.userId, at: max(sessions.createdAt) }).from(sessions).where(inArray(sessions.userId, ids)).groupBy(sessions.userId),
    db
      .select({ userId: passwordLinks.userId, purpose: passwordLinks.purpose, expiresAt: passwordLinks.expiresAt })
      .from(passwordLinks)
      .where(and(inArray(passwordLinks.userId, ids), usable())),
  ]);

  return people.map((p) => {
    const link = links.find((l) => l.userId === p.id);
    return {
      id: p.id,
      name: p.name,
      email: p.email,
      active: !p.deactivatedAt,
      hasPassword: p.hasPassword,
      lastSignInAt: lastSessions.find((s) => s.userId === p.id)?.at?.toISOString() ?? null,
      sites: siteRows.filter((s) => s.userId === p.id).map(({ id, name, role }) => ({ id, name, role })),
      pendingLink: link ? { purpose: link.purpose, expiresAt: link.expiresAt.toISOString() } : null,
    };
  });
}

/**
 * Creates an assistant engineer: the account (no password), membership of the admin's
 * organization, the assistant role on each chosen site, and a one-time setup link.
 */
export async function createAccount(actor: Actor, raw: unknown) {
  requireAdmin(actor);
  const input = accountInput.parse(raw);
  await assertSameOrg(constructionSites, input.siteIds, actor, "Site");
  const id = crypto.randomUUID();
  try {
    return await db.transaction(async (tx) => {
      await assertEmailFree(input.email, tx);
      await tx.insert(users).values({ id, name: input.name, email: input.email });
      await tx.insert(organizationMembers).values({ organizationId: actor.orgId, userId: id, role: "member", selectedAt: new Date() });
      await tx
        .insert(siteMemberships)
        .values(input.siteIds.map((siteId) => ({ siteId, userId: id, role: "assistant" as const, addedBy: actor.userId })));
      const link = await issueLink(tx, id, "setup", actor.userId);
      await audit(tx, actor, {
        action: "account.create",
        entityType: "user",
        entityId: id,
        summary: `Created assistant engineer account for ${input.name} (${input.email})`,
        data: { email: input.email, siteIds: input.siteIds },
      });
      return { id, email: input.email, ...link };
    });
  } catch (err) {
    throw uniqueEmail(err);
  }
}

/**
 * Sets exactly which of the organization's sites the person works on. Sites they keep
 * keep their role; new ones get the assistant engineer role.
 */
export async function setAccountSites(actor: Actor, raw: unknown) {
  requireAdmin(actor);
  const input = accountSitesInput.parse(raw);
  await assertSameOrg(constructionSites, input.siteIds, actor, "Site");
  await db.transaction(async (tx) => {
    const target = await lockAccount(tx, actor, input.userId);
    const orgSites = tx.select({ id: constructionSites.id }).from(constructionSites).where(eq(constructionSites.organizationId, actor.orgId));
    const removed = await tx
      .delete(siteMemberships)
      .where(
        and(
          eq(siteMemberships.userId, target.id),
          inArray(siteMemberships.siteId, orgSites),
          input.siteIds.length ? notInArray(siteMemberships.siteId, input.siteIds) : undefined,
        ),
      )
      .returning({ siteId: siteMemberships.siteId });
    const added = input.siteIds.length
      ? await tx
          .insert(siteMemberships)
          .values(input.siteIds.map((siteId) => ({ siteId, userId: target.id, role: "assistant" as const, addedBy: actor.userId })))
          .onConflictDoNothing()
          .returning({ siteId: siteMemberships.siteId })
      : [];
    if (removed.length || added.length) {
      await audit(tx, actor, {
        action: "account.sites",
        entityType: "user",
        entityId: target.id,
        summary: `Changed sites for ${target.name}: ${added.length} added, ${removed.length} removed`,
        data: { added: added.map((r) => r.siteId), removed: removed.map((r) => r.siteId) },
      });
    }
  });
}

/**
 * Deactivating blocks sign-in at once: their sessions and unused links are deleted, and
 * `loadActor` refuses them even on a cached session cookie. Their entries stay as they are.
 */
export async function setAccountActive(actor: Actor, raw: unknown) {
  requireAdmin(actor);
  const input = accountActiveInput.parse(raw);
  await db.transaction(async (tx) => {
    const target = await lockAccount(tx, actor, input.userId);
    if (input.active === !target.deactivatedAt) return;
    await tx
      .update(users)
      .set(input.active ? { deactivatedAt: null, deactivatedBy: null } : { deactivatedAt: new Date(), deactivatedBy: actor.userId })
      .where(eq(users.id, target.id));
    if (!input.active) {
      await tx.delete(sessions).where(eq(sessions.userId, target.id));
      await tx.update(passwordLinks).set({ revokedAt: new Date() }).where(and(eq(passwordLinks.userId, target.id), usable()));
    }
    await audit(tx, actor, {
      action: input.active ? "account.activate" : "account.deactivate",
      entityType: "user",
      entityId: target.id,
      summary: `${input.active ? "Reactivated" : "Deactivated"} ${target.name} (${target.email})`,
    });
  });
}

/**
 * A new one-time link for the person to set a password: "setup" if they never had one,
 * else "reset". Their earlier unused links stop working. Their current password keeps
 * working until the link is used.
 */
export async function issuePasswordLink(actor: Actor, userId: string) {
  requireAdmin(actor);
  return db.transaction(async (tx) => {
    const target = await lockAccount(tx, actor, userId);
    if (target.deactivatedAt) throw new ValidationError("Reactivate this account before sending a password link.");
    const purpose = (await hasPassword(tx, target.id)) ? "reset" : "setup";
    const link = await issueLink(tx, target.id, purpose, actor.userId);
    await audit(tx, actor, {
      action: "account.password_link",
      entityType: "user",
      entityId: target.id,
      summary: `Created a password ${purpose} link for ${target.name}`,
    });
    return { email: target.email, ...link };
  });
}

// ---- Using a link (no actor: the person isn't signed in) --------------------

type LinkStatus = "valid" | "expired" | "used" | "revoked";

const LINK_MESSAGE: Record<Exclude<LinkStatus, "valid">, string> = {
  expired: "This link has expired. Ask the admin for a new one.",
  used: "This link has already been used. Sign in with your password, or ask the admin for a new link.",
  revoked: "This link is no longer valid. Ask the admin for a new one.",
};

function statusOf(row: { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date }): LinkStatus {
  if (row.usedAt) return "used";
  if (row.revokedAt) return "revoked";
  if (row.expiresAt.getTime() <= Date.now()) return "expired";
  return "valid";
}

/** What the set-password page shows to whoever holds the link. Null for unknown or malformed tokens. */
export async function previewPasswordLink(rawToken: string) {
  const token = passwordLinkToken.safeParse(rawToken);
  if (!token.success) return null;
  const [row] = await db
    .select({
      name: users.name,
      email: users.email,
      deactivatedAt: users.deactivatedAt,
      purpose: passwordLinks.purpose,
      usedAt: passwordLinks.usedAt,
      revokedAt: passwordLinks.revokedAt,
      expiresAt: passwordLinks.expiresAt,
    })
    .from(passwordLinks)
    .innerJoin(users, eq(users.id, passwordLinks.userId))
    .where(eq(passwordLinks.tokenHash, hashToken(token.data)))
    .limit(1);
  if (!row) return null;
  const status = row.deactivatedAt ? "revoked" : statusOf(row);
  return { name: row.name, email: row.email, purpose: row.purpose, message: status === "valid" ? null : LINK_MESSAGE[status] };
}

/**
 * Sets the password with a one-time link (hashed by Better Auth's own hasher), then ends
 * every session the person had. Returns their email so the caller can sign them in.
 */
export async function setPasswordWithLink(raw: unknown) {
  const input = setPasswordInput.parse(raw);
  const ctx = await auth.$context;
  // Hash before taking row locks: it's deliberately slow.
  const hash = await ctx.password.hash(input.password);
  return db.transaction(async (tx) => {
    const [link] = await tx
      .select()
      .from(passwordLinks)
      .where(eq(passwordLinks.tokenHash, hashToken(input.token)))
      .for("update")
      .limit(1);
    if (!link) throw new NotFoundError("Link");
    const status = statusOf(link);
    if (status !== "valid") throw new ValidationError(LINK_MESSAGE[status]);
    // Refuses deactivated people and anyone outside an organization.
    const actor = await loadActor(link.userId, tx).catch(() => {
      throw new ValidationError(LINK_MESSAGE.revoked);
    });

    const [credential] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, actor.userId), eq(accounts.providerId, "credential"), eq(accounts.accountId, actor.userId)))
      .limit(1);
    if (credential) await tx.update(accounts).set({ password: hash }).where(eq(accounts.id, credential.id));
    else await tx.insert(accounts).values({ id: crypto.randomUUID(), accountId: actor.userId, providerId: "credential", userId: actor.userId, password: hash });

    const now = new Date();
    await tx.update(passwordLinks).set({ usedAt: now }).where(eq(passwordLinks.id, link.id));
    await tx.update(passwordLinks).set({ revokedAt: now }).where(and(eq(passwordLinks.userId, actor.userId), usable()));
    // A new password signs out every device that had the old one.
    await tx.delete(sessions).where(eq(sessions.userId, actor.userId));
    await audit(tx, actor, {
      action: link.purpose === "setup" ? "account.password_setup" : "account.password_reset",
      entityType: "user",
      entityId: actor.userId,
      summary: `${actor.name} ${link.purpose === "setup" ? "set up" : "reset"} their password`,
    });
    return { email: actor.email };
  });
}

// ---- Server-side setup (npm run admin:*) ------------------------------------

/**
 * Creates the organization and its owner, the one permanent admin, once. Does nothing
 * (and says so) when an admin already exists. An existing account with the email that
 * belongs to no organization becomes the admin and keeps its password. Returns a setup
 * link when the admin has no password yet.
 */
export async function bootstrapAdmin(raw: unknown) {
  const input = bootstrapAdminInput.parse(raw);
  return db.transaction(async (tx) => {
    // Two bootstraps at once must not both create an admin.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('arcadia:bootstrap-admin'))`);
    const [existingAdmin] = await tx
      .select({ email: users.email })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.role, "owner"))
      .limit(1);
    if (existingAdmin) return { status: "exists" as const, email: existingAdmin.email };

    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(sql`lower(${users.email})`, input.email)).limit(1);
    let userId = existing?.id;
    if (userId) {
      const [member] = await tx.select({ id: organizationMembers.organizationId }).from(organizationMembers).where(eq(organizationMembers.userId, userId)).limit(1);
      if (member) throw new ValidationError("That email already belongs to another organization's account.");
      await tx.update(users).set({ deactivatedAt: null, deactivatedBy: null }).where(eq(users.id, userId));
    } else {
      userId = crypto.randomUUID();
      await tx.insert(users).values({ id: userId, name: input.name, email: input.email });
    }
    await createOrganization(userId, input.organizationName, tx);
    const actor = await loadActor(userId, tx);
    await audit(tx, actor, {
      action: "account.bootstrap_admin",
      entityType: "user",
      entityId: userId,
      summary: `Set up ${input.email} as the admin of ${input.organizationName}`,
    });
    const link = (await hasPassword(tx, userId)) ? null : await issueLink(tx, userId, "setup", null);
    return { status: "created" as const, email: input.email, link };
  });
}

/** A password reset link for the admin, for when they can't sign in. Server-side only. */
export async function issueAdminResetLink() {
  return db.transaction(async (tx) => {
    const owners = await tx
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.role, "owner"));
    if (owners.length === 0) throw new NotFoundError("Admin");
    if (owners.length > 1) throw new ValidationError("There is more than one organization owner in this database; reset links must be issued per account.");
    const actor = await loadActor(owners[0].userId, tx);
    const link = await issueLink(tx, actor.userId, (await hasPassword(tx, actor.userId)) ? "reset" : "setup", null);
    await audit(tx, actor, {
      action: "account.password_link",
      entityType: "user",
      entityId: actor.userId,
      summary: `Created a password ${link.purpose} link for the admin from the server console`,
    });
    return { email: actor.email, ...link };
  });
}

// ---- Helpers ----------------------------------------------------------------

const usable = () => and(isNull(passwordLinks.usedAt), isNull(passwordLinks.revokedAt), sql`${passwordLinks.expiresAt} > now()`);

async function issueLink(tx: Conn, userId: string, purpose: "setup" | "reset", createdBy: string | null) {
  await tx.update(passwordLinks).set({ revokedAt: new Date() }).where(and(eq(passwordLinks.userId, userId), usable()));
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + LINK_TTL_MS);
  await tx.insert(passwordLinks).values({ userId, tokenHash: hashToken(token), purpose, createdBy, expiresAt });
  return { purpose, path: `/set-password/${token}`, expiresAt: expiresAt.toISOString() };
}

async function hasPassword(conn: Conn, userId: string) {
  const [row] = await conn
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential"), sql`${accounts.password} is not null`))
    .limit(1);
  return !!row;
}

/**
 * Locks a person in the admin's organization for a change. Anyone else is "not found";
 * the admin's own account can't be changed here (it is protected in the database too).
 */
async function lockAccount(tx: Conn, actor: Actor, userId: string) {
  if (typeof userId !== "string" || userId.length === 0 || userId.length > 100) throw new NotFoundError("Account");
  const [row] = await tx
    .select({ id: users.id, name: users.name, email: users.email, deactivatedAt: users.deactivatedAt, role: organizationMembers.role })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.organizationId, actor.orgId), eq(organizationMembers.userId, userId)))
    .for("update")
    .limit(1);
  if (!row) throw new NotFoundError("Account");
  if (row.role === "owner") throw new ForbiddenError("The admin account can't be changed here.");
  return row;
}

async function assertEmailFree(email: string, conn: Conn) {
  const [row] = await conn.select({ id: users.id }).from(users).where(eq(sql`lower(${users.email})`, email)).limit(1);
  if (row) throw takenEmail();
}

const takenEmail = () => new ValidationError("An account already uses this email.", { email: "An account already uses this email." });

/** A concurrent create with the same email loses on the unique index; report it like the pre-check. */
function uniqueEmail(err: unknown) {
  const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
  return code === "23505" ? takenEmail() : err;
}
