import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { db } from "@/db";
import { accounts, auditLog, organizationMembers, organizations, passwordLinks, sessions, siteMemberships, users } from "@/db/schema";
import { auth } from "@/lib/auth";
import { loadActor, readsRecords, type Actor } from "@/server/authz";
import {
  bootstrapAdmin,
  createAccount,
  issueAdminResetLink,
  issuePasswordLink,
  listAccounts,
  previewPasswordLink,
  setAccountActive,
  setAccountSites,
  setPasswordWithLink,
} from "@/server/data/accounts";
import { createExpense, listExpenses, reviewExpense } from "@/server/data/expenses";
import { createSite, getSite } from "@/server/data/sites";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { expense } from "./fixtures";

/**
 * The single-admin model end to end, against the real Better Auth instance and database:
 * bootstrap, sign-in, admin-created accounts, password links, deactivation and the
 * database guards around the admin.
 */

const ORIGIN = process.env.BETTER_AUTH_URL || "http://localhost:3000";
const { GET: authGet, POST: authPost } = await import("@/app/api/auth/[...all]/route");

const tokenOf = (path: string) => path.split("/").pop()!;
const authCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (err) {
    return (err as { body?: { code?: string } }).body?.code ?? String(err);
  }
};
const signIn = (email: string, password: string) => auth.api.signInEmail({ body: { email, password } });
const post = (path: string, body: unknown, cookie?: string) =>
  authPost(
    new Request(`${ORIGIN}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie && { cookie }) },
      body: JSON.stringify(body),
    }),
  );

const ADMIN_EMAIL = `admin.${crypto.randomUUID().slice(0, 8)}@test.example`;
const ADMIN_PASSWORD = "Admin-passw0rd-long";
let admin: Actor;
let siteA: string;
let siteB: string;

beforeAll(async () => {
  // Bootstrap only runs on a database without an admin: clear other test files' organizations.
  // (Deleting an organization is the one way its owner membership may go; see migration 0013.)
  await db.delete(organizations);
  const created = await bootstrapAdmin({ email: ADMIN_EMAIL.toUpperCase(), name: "Arcadia Admin", organizationName: "Arcadia Test" });
  expect(created.status).toBe("created");
  if (created.status !== "created" || !created.link) throw new Error("expected a setup link");
  await setPasswordWithLink({ token: tokenOf(created.link.path), password: ADMIN_PASSWORD, confirm: ADMIN_PASSWORD });
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, ADMIN_EMAIL));
  admin = await loadActor(row.id);
  siteA = (await createSite(admin, { name: "Site A", location: "Kochi", budget: "100000", startDate: "2026-01-01" })).site.id;
  siteB = (await createSite(admin, { name: "Site B", location: "Thrissur", budget: "100000", startDate: "2026-01-01" })).site.id;
});

describe("admin bootstrap", () => {
  it("creates one admin, once, and never overwrites it", async () => {
    expect(admin.orgRole).toBe("owner");
    expect(admin.email).toBe(ADMIN_EMAIL);
    const again = await bootstrapAdmin({ email: "someone.else@test.example", name: "Other", organizationName: "Other Org" });
    expect(again).toEqual({ status: "exists", email: ADMIN_EMAIL });
    expect(await db.select().from(users).where(eq(users.email, "someone.else@test.example"))).toEqual([]);
    const owners = await db.select().from(organizationMembers).where(eq(organizationMembers.role, "owner"));
    expect(owners).toHaveLength(1);
    await expect(bootstrapAdmin({ email: "not-an-email", name: "", organizationName: "X" })).rejects.toBeInstanceOf(ZodError);
  });

  it("issues a server-side reset link for the admin without changing the password", async () => {
    const link = await issueAdminResetLink();
    expect(link).toMatchObject({ email: ADMIN_EMAIL, purpose: "reset" });
    expect(await authCode(signIn(ADMIN_EMAIL, ADMIN_PASSWORD))).toBe("ok");
    // Revoke it again so it can't be used by anything later in this file.
    await db.update(passwordLinks).set({ revokedAt: new Date() }).where(eq(passwordLinks.tokenHash, createHash("sha256").update(tokenOf(link.path)).digest("hex")));
    expect((await previewPasswordLink(tokenOf(link.path)))?.message).toMatch(/no longer valid/);
  });
});

describe("sign-in", () => {
  it("accepts the admin's password and refuses wrong passwords and unknown emails alike", async () => {
    const ok = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(ok.user.id).toBe(admin.userId);
    expect(await authCode(signIn(ADMIN_EMAIL.toUpperCase(), ADMIN_PASSWORD))).toBe("ok");
    expect(await authCode(signIn(ADMIN_EMAIL, "wrong-password"))).toBe("INVALID_EMAIL_OR_PASSWORD");
    expect(await authCode(signIn("nobody@test.example", ADMIN_PASSWORD))).toBe("INVALID_EMAIL_OR_PASSWORD");
  });

  it("sets an httpOnly session cookie over HTTP, and sign-out ends the session", async () => {
    const res = await post("/sign-in/email", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    const setCookies = res.headers.getSetCookie();
    const token = setCookies.find((c) => c.startsWith("better-auth.session_token="))!;
    expect(token).toMatch(/HttpOnly/i);
    expect(token).toMatch(/SameSite=Lax/i);
    const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");

    const me = await authGet(new Request(`${ORIGIN}/api/auth/get-session`, { headers: { cookie } }));
    expect((await me.json())?.user?.email).toBe(ADMIN_EMAIL);

    const out = await post("/sign-out", {}, cookie);
    expect(out.status).toBe(200);
    const stored = decodeURIComponent(token.split(";")[0].split("=")[1]).split(".")[0];
    expect(await db.select().from(sessions).where(eq(sessions.token, stored))).toEqual([]);
  });
  // The cross-site (Origin) check is off under NODE_ENV=test in Better Auth; it's checked against the production build.
});

describe("public registration is disabled", () => {
  it("at the API, over HTTP and through auth.api", async () => {
    const email = `selfreg.${crypto.randomUUID().slice(0, 8)}@test.example`;
    const res = await post("/sign-up/email", { email, password: "Passw0rd-long", name: "Self" });
    expect(res.status).toBe(404);
    expect(await authCode(auth.api.signUpEmail({ body: { email, password: "Passw0rd-long", name: "Self" } }))).not.toBe("ok");
    // Better Auth's emailed reset flow is off too; resets are admin-issued links.
    expect((await post("/request-password-reset", { email: ADMIN_EMAIL })).status).toBe(404);
    expect((await post("/reset-password", { newPassword: "x".repeat(10), token: "t" })).status).toBe(404);
    expect(await db.select().from(users).where(eq(users.email, email))).toEqual([]);
  });
});

describe("assistant engineer accounts", () => {
  const email = `asst.${crypto.randomUUID().slice(0, 8)}@test.example`;
  const password = "Asst-passw0rd-long";
  let userId: string;
  let setupPath: string;

  it("the admin creates one with sites and a one-time setup link; only a hash is stored", async () => {
    const created = await createAccount(admin, { name: " Anu Joseph ", email: email.toUpperCase(), siteIds: [siteA, siteA] });
    userId = created.id;
    setupPath = created.path;
    expect(created).toMatchObject({ email, purpose: "setup" });
    expect(tokenOf(setupPath)).toHaveLength(43);

    const [link] = await db.select().from(passwordLinks).where(eq(passwordLinks.userId, userId));
    expect(JSON.stringify(link)).not.toContain(tokenOf(setupPath));
    expect(await db.select().from(accounts).where(eq(accounts.userId, userId))).toEqual([]);

    const [listed] = (await listAccounts(admin)).filter((a) => a.id === userId);
    expect(listed).toMatchObject({ name: "Anu Joseph", email, active: true, hasPassword: false, lastSignInAt: null });
    expect(listed.sites).toEqual([{ id: siteA, name: "Site A", role: "assistant" }]);
    expect(listed.pendingLink?.purpose).toBe("setup");
    expect(await previewPasswordLink(tokenOf(setupPath))).toMatchObject({ email, purpose: "setup", message: null });

    // No password yet: nothing to sign in with.
    expect(await authCode(signIn(email, password))).toBe("INVALID_EMAIL_OR_PASSWORD");
    const log = await db.select().from(auditLog).where(and(eq(auditLog.entityId, userId), eq(auditLog.action, "account.create")));
    expect(log).toHaveLength(1);
  });

  it("refuses duplicate emails, whatever the case", async () => {
    for (const dup of [email, email.toUpperCase(), ADMIN_EMAIL]) {
      const err = await createAccount(admin, { name: "Dup", email: dup, siteIds: [siteA] }).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.fieldErrors.email).toMatch(/already/);
    }
    await expect(createAccount(admin, { name: "No sites", email: "nosites@test.example", siteIds: [] })).rejects.toBeInstanceOf(ZodError);
    await expect(createAccount(admin, { name: "Bad site", email: "badsite@test.example", siteIds: [crypto.randomUUID()] })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("sets the password once through the link, then signs in", async () => {
    const token = tokenOf(setupPath);
    await expect(setPasswordWithLink({ token, password: "short", confirm: "short" })).rejects.toBeInstanceOf(ZodError);
    await expect(setPasswordWithLink({ token, password, confirm: `${password}x` })).rejects.toBeInstanceOf(ZodError);
    await expect(setPasswordWithLink({ token: "x".repeat(43), password, confirm: password })).rejects.toBeInstanceOf(NotFoundError);

    expect(await setPasswordWithLink({ token, password, confirm: password })).toEqual({ email });
    const [cred] = await db.select().from(accounts).where(eq(accounts.userId, userId));
    expect(cred.password).not.toContain(password);
    expect(await authCode(signIn(email, password))).toBe("ok");

    await expect(setPasswordWithLink({ token, password: "Another-passw0rd", confirm: "Another-passw0rd" })).rejects.toThrow(/already been used/);
    expect((await previewPasswordLink(token))?.message).toMatch(/already been used/);
  });

  it("can only add expenses to assigned sites, for approval, and nothing an admin does", async () => {
    const me = await loadActor(userId);
    expect(me.orgRole).toBe("member");
    expect(await readsRecords(me)).toBe(false);

    const mine = await createExpense(me, { ...expense(siteA), submit: true });
    expect(mine.status).toBe("pending_approval");
    await expect(createExpense(me, expense(siteB))).rejects.toBeInstanceOf(NotFoundError);
    await expect(reviewExpense(me, { id: mine.id, decision: "approve" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getSite(me, siteA)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listExpenses(me, { siteId: siteA })).rejects.toBeInstanceOf(ForbiddenError);

    await expect(listAccounts(me)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createAccount(me, { name: "Friend", email: "friend@test.example", siteIds: [siteA] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setAccountSites(me, { userId, siteIds: [siteA, siteB] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setAccountActive(me, { userId: admin.userId, active: false })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(issuePasswordLink(me, admin.userId)).rejects.toBeInstanceOf(ForbiddenError);

    // The admin approves it.
    await expect(reviewExpense(admin, { id: mine.id, decision: "approve" })).resolves.toMatchObject({ status: "approved" });
  });

  it("the admin changes their sites", async () => {
    await setAccountSites(admin, { userId, siteIds: [siteB] });
    const me = await loadActor(userId);
    await expect(createExpense(me, expense(siteA))).rejects.toBeInstanceOf(NotFoundError);
    await expect(createExpense(me, expense(siteB))).resolves.toBeTruthy();
    expect((await db.select().from(siteMemberships).where(eq(siteMemberships.userId, userId))).map((m) => [m.siteId, m.role])).toEqual([
      [siteB, "assistant"],
    ]);
  });

  it("a reset link replaces the password and signs out every device", async () => {
    await signIn(email, password);
    const first = await issuePasswordLink(admin, userId);
    const second = await issuePasswordLink(admin, userId);
    expect(second.purpose).toBe("reset");
    // Only the newest link works; the old password works until it is used.
    expect((await previewPasswordLink(tokenOf(first.path)))?.message).toMatch(/no longer valid/);
    expect(await authCode(signIn(email, password))).toBe("ok");

    await setPasswordWithLink({ token: tokenOf(second.path), password: "Changed-passw0rd", confirm: "Changed-passw0rd" });
    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toEqual([]);
    expect(await authCode(signIn(email, password))).toBe("INVALID_EMAIL_OR_PASSWORD");
    expect(await authCode(signIn(email, "Changed-passw0rd"))).toBe("ok");
  });

  it("refuses expired links", async () => {
    const link = await issuePasswordLink(admin, userId);
    await db.update(passwordLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(and(eq(passwordLinks.userId, userId), sql`used_at is null`));
    expect((await previewPasswordLink(tokenOf(link.path)))?.message).toMatch(/expired/);
    await expect(setPasswordWithLink({ token: tokenOf(link.path), password: "Expired-passw0rd", confirm: "Expired-passw0rd" })).rejects.toThrow(/expired/);
  });

  it("deactivation blocks sign-in and existing sessions at once; reactivation restores them", async () => {
    await signIn(email, "Changed-passw0rd");
    const pendingLink = await issuePasswordLink(admin, userId);
    await setAccountActive(admin, { userId, active: false });

    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toEqual([]);
    await expect(loadActor(userId)).rejects.toThrow();
    expect(await authCode(signIn(email, "Changed-passw0rd"))).toBe("ACCOUNT_INACTIVE");
    expect(await authCode(signIn(email, "wrong-password"))).toBe("INVALID_EMAIL_OR_PASSWORD");
    expect((await previewPasswordLink(tokenOf(pendingLink.path)))?.message).toBeTruthy();
    await expect(issuePasswordLink(admin, userId)).rejects.toBeInstanceOf(ValidationError);
    expect((await listAccounts(admin)).find((a) => a.id === userId)?.active).toBe(false);

    await setAccountActive(admin, { userId, active: true });
    expect(await authCode(signIn(email, "Changed-passw0rd"))).toBe("ok");
    const actions = (await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, userId))).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["account.deactivate", "account.activate", "account.password_reset", "account.sites"]));
  });
});

describe("the admin is permanent", () => {
  it("can't be deactivated, changed or removed through the app", async () => {
    await expect(setAccountActive(admin, { userId: admin.userId, active: false })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setAccountSites(admin, { userId: admin.userId, siteIds: [] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(issuePasswordLink(admin, admin.userId)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listAccounts(admin)).some((a) => a.id === admin.userId)).toBe(false);
  });

  it("nor directly in the database, and there is only ever one owner", async () => {
    const owner = and(eq(organizationMembers.userId, admin.userId), eq(organizationMembers.organizationId, admin.orgId));
    await expect(db.update(users).set({ deactivatedAt: new Date() }).where(eq(users.id, admin.userId))).rejects.toThrow();
    await expect(db.update(organizationMembers).set({ role: "member" }).where(owner)).rejects.toThrow();
    await expect(db.delete(organizationMembers).where(owner)).rejects.toThrow();
    await expect(db.delete(users).where(eq(users.id, admin.userId))).rejects.toThrow();

    const other = await listAccounts(admin);
    await expect(
      db.update(organizationMembers).set({ role: "owner" }).where(and(eq(organizationMembers.userId, other[0].id), eq(organizationMembers.organizationId, admin.orgId))),
    ).rejects.toThrow();
    expect(await authCode(signIn(ADMIN_EMAIL, ADMIN_PASSWORD))).toBe("ok");
  });
});
