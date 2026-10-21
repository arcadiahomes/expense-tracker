import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { organizationMembers, siteMemberships } from "@/db/schema";
import { loadActor, type Actor } from "@/server/authz";
import { upsertBudget } from "@/server/data/budgets";
import { createBill, deleteBill, recordPayment } from "@/server/data/bills";
import { deleteExpense, getExpense, updateExpense } from "@/server/data/expenses";
import { createAccount, issuePasswordLink } from "@/server/data/accounts";
import { listMyOrganizations, selectOrganization } from "@/server/data/organizations";
import { addReceipt, deleteReceipt, readReceipt } from "@/server/data/receipts";
import { reportRows } from "@/server/data/reports";
import {
  createSite,
  deleteSite,
  getSite,
  listSiteMembers,
  listSites,
  removeSiteMember,
  setSiteMemberRole,
  updateSite,
} from "@/server/data/sites";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { addExpense, expense, newUser, world } from "./fixtures";

// Route handlers resolve the caller through getActor; tests swap in fake actors.
const session = vi.hoisted(() => ({ actor: null as Actor | null }));
vi.mock("@/server/session", () => ({
  getActor: async () => session.actor,
  getSessionUser: async () => null,
  requireActor: async () => session.actor,
}));

let w: Awaited<ReturnType<typeof world>>;
let eng1Expense: string;

beforeAll(async () => {
  w = await world();
  eng1Expense = (await addExpense(w.a.eng1, w.site1, { description: "Eng1 entry" })).id;
  await addExpense(w.a.eng2, w.site2, { description: "Site two entry" });
});

const site1Update = () => ({ id: w.site1, name: "Site One", location: "Kochi", budget: "100000", startDate: "2026-01-01" });
const bill = (n: string, siteId = w.site1) => ({
  siteId,
  supplierName: "Access Test Supplier",
  billNumber: n,
  billDate: "2026-10-10",
  dueDate: "2026-10-30",
  amount: "1000",
});
const collect = async (it: AsyncGenerator<unknown>) => {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
};
const range = { from: "2026-10-01", to: "2026-10-20" };

describe("accountant", () => {
  it("manages money on their site", async () => {
    const b = await createBill(w.a.accountant, bill("ACC-1"));
    await expect(recordPayment(w.a.accountant, { billId: b.id, amount: "100", paidOn: "2026-10-12" })).resolves.toBeTruthy();
    await expect(upsertBudget(w.a.accountant, { siteId: w.site1, amount: "123456" })).resolves.toBeTruthy();
    // Corrects anyone's expense, unlike an engineer.
    await expect(
      updateExpense(w.a.accountant, { ...expense(w.site1, { description: "Corrected by accounts" }), id: eng1Expense }),
    ).resolves.toMatchObject({ description: "Corrected by accounts" });
    expect((await getExpense(w.a.accountant, eng1Expense)).canEdit).toBe(true);
  });

  it("can't change the site or its people", async () => {
    await expect(updateSite(w.a.accountant, site1Update())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listSiteMembers(w.a.accountant, w.site1)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createAccount(w.a.accountant, { name: "X", email: "x@test.example", siteIds: [w.site1] })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(deleteSite(w.a.accountant, w.site1)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("sees nothing on sites they aren't on", async () => {
    await expect(getSite(w.a.accountant, w.site2)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createBill(w.a.accountant, bill("ACC-2", w.site2))).rejects.toBeInstanceOf(NotFoundError);
    expect((await listSites(w.a.accountant)).map((s) => s.site.id)).toEqual([w.site1]);
  });
});

describe("engineer and viewer", () => {
  it("engineers can't touch bills, budgets, receipts deletion or people", async () => {
    await expect(createBill(w.a.eng1, bill("ENG-1"))).rejects.toBeInstanceOf(ForbiddenError);
    const b = await createBill(w.a.owner, bill("ENG-2"));
    await expect(deleteBill(w.a.eng1, b.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordPayment(w.a.eng1, { billId: b.id, amount: "1", paidOn: "2026-10-12" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(upsertBudget(w.a.eng1, { siteId: w.site1, amount: "1" })).rejects.toBeInstanceOf(ForbiddenError);
    const r = await addReceipt(
      w.a.eng1,
      { siteId: w.site1, supplierBillId: b.id, fileName: "r.pdf", contentType: "application/pdf" },
      new TextEncoder().encode("%PDF-1.4"),
    );
    await expect(deleteReceipt(w.a.eng1, r.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listSiteMembers(w.a.eng1, w.site1)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("viewers can't write anything", async () => {
    await expect(addExpense(w.a.viewer, w.site1)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateExpense(w.a.viewer, { ...expense(w.site1), id: eng1Expense })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createBill(w.a.viewer, bill("VIEW-1"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(upsertBudget(w.a.viewer, { siteId: w.site1, amount: "1" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createAccount(w.a.viewer, { name: "Y", email: "y@test.example", siteIds: [w.site1] })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe("site owner who isn't an org admin", () => {
  it("edits their site and sees its people, but not other sites", async () => {
    await expect(updateSite(w.a.siteOwner, site1Update())).resolves.toBeTruthy();
    const people = await listSiteMembers(w.a.siteOwner, w.site1);
    expect(people.map((p) => p.role).sort()).toEqual(["accountant", "engineer", "owner", "owner", "viewer"]);
    await expect(listSiteMembers(w.a.siteOwner, w.site2)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateSite(w.a.siteOwner, { ...site1Update(), id: w.site2, name: "Site Two" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("can't create or delete sites (org owners/admins only)", async () => {
    await expect(createSite(w.a.siteOwner, { name: "New", location: "x", budget: "1", startDate: "2026-01-01" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(deleteSite(w.a.siteOwner, w.site1)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("changes roles of others, but can't escalate to owner, demote owners or change themselves", async () => {
    const eng1 = w.a.eng1.userId;
    await setSiteMemberRole(w.a.siteOwner, { siteId: w.site1, userId: eng1, role: "viewer" });
    await expect(addExpense(await loadActor(eng1), w.site1)).rejects.toBeInstanceOf(ForbiddenError);
    await setSiteMemberRole(w.a.siteOwner, { siteId: w.site1, userId: eng1, role: "engineer" });
    await expect(addExpense(await loadActor(eng1), w.site1)).resolves.toBeTruthy();

    await expect(setSiteMemberRole(w.a.siteOwner, { siteId: w.site1, userId: eng1, role: "owner" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      setSiteMemberRole(w.a.siteOwner, { siteId: w.site1, userId: w.a.owner.userId, role: "viewer" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(removeSiteMember(w.a.siteOwner, w.site1, w.a.owner.userId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      setSiteMemberRole(w.a.siteOwner, { siteId: w.site1, userId: w.a.siteOwner.userId, role: "accountant" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Someone who isn't on the site can't be "changed" onto it.
    await expect(setSiteMemberRole(w.a.siteOwner, { siteId: w.site1, userId: w.a.eng2.userId, role: "viewer" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("removal takes effect on the next request", async () => {
    const temp = await newUser("Temp Viewer");
    await db.execute(sql`insert into organization_members (organization_id, user_id) values (${w.orgA}, ${temp.id})`);
    await db.insert(siteMemberships).values({ siteId: w.site1, userId: temp.id, role: "viewer" });
    const actor = await loadActor(temp.id);
    await expect(getSite(actor, w.site1)).resolves.toBeTruthy();
    await removeSiteMember(w.a.siteOwner, w.site1, temp.id);
    await expect(getSite(actor, w.site1)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("cross-organization and direct object references", () => {
  it("another org can't manage people, accounts or receipts on our sites", async () => {
    await expect(listSiteMembers(w.b.owner, w.site1)).rejects.toBeInstanceOf(NotFoundError);
    await expect(setSiteMemberRole(w.b.owner, { siteId: w.site1, userId: w.a.eng1.userId, role: "owner" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(removeSiteMember(w.b.owner, w.site1, w.a.eng1.userId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createAccount(w.b.owner, { name: "Z", email: "z@test.example", siteIds: [w.site1] })).rejects.toBeInstanceOf(NotFoundError);
    // Mixing an own site with a foreign one is rejected as a whole.
    await expect(createAccount(w.a.owner, { name: "Mix", email: "mix@test.example", siteIds: [w.site1, w.siteB] })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // Org A's people are invisible to org B's admin.
    await expect(issuePasswordLink(w.b.owner, w.a.eng1.userId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("malformed and unknown ids are simply not found", async () => {
    await expect(getSite(w.a.owner, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
    await expect(getSite(w.a.owner, crypto.randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    await expect(readReceipt(w.a.owner, crypto.randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteExpense(w.b.owner, eng1Expense)).rejects.toBeInstanceOf(NotFoundError);
    await expect(issuePasswordLink(w.a.owner, "nope")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("exports", () => {
  it("only owners and accountants export, and only their sites", async () => {
    await expect(collect(reportRows(w.a.eng1, range))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(collect(reportRows(w.a.viewer, range))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(collect(reportRows(w.a.viewer, { ...range, siteId: w.site1 }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(collect(reportRows(w.a.accountant, { ...range, siteId: w.site2 }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(collect(reportRows(w.b.owner, { ...range, siteId: w.site1 }))).rejects.toBeInstanceOf(NotFoundError);

    const rows = (await collect(reportRows(w.a.accountant, range))) as { siteId: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.siteId === w.site1)).toBe(true);
    const all = (await collect(reportRows(w.a.owner, range))) as { siteId: string }[];
    expect(new Set(all.map((r) => r.siteId))).toEqual(new Set([w.site1, w.site2]));
  });

  it("the CSV route enforces the same rules and neutralises formulas", async () => {
    const { GET } = await import("@/app/api/reports/export/route");
    const req = (q: string) => new Request(`http://app.local/api/reports/export?from=2026-10-01&to=2026-10-20${q}`);

    session.actor = null;
    expect((await GET(req(""))).status).toBe(401);
    session.actor = w.a.eng1;
    expect((await GET(req(""))).status).toBe(403);
    session.actor = w.b.owner;
    expect((await GET(req(`&site=${w.site1}`))).status).toBe(404);

    await addExpense(w.a.eng1, w.site1, { description: '=HYPERLINK("http://evil.example","x")' });
    session.actor = w.a.accountant;
    const res = await GET(req(`&site=${w.site1}`));
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    expect(csv).not.toContain("Site two entry");
    session.actor = null;
  });

  it("the receipt route needs a session and site access", async () => {
    const { GET } = await import("@/app/api/receipts/[id]/route");
    const b = await createBill(w.a.owner, bill("RCPT-ROUTE"));
    const r = await addReceipt(
      w.a.owner,
      { siteId: w.site1, supplierBillId: b.id, fileName: "r.pdf", contentType: "application/pdf" },
      new TextEncoder().encode("%PDF-1.4"),
    );
    const get = () => GET(new Request("http://app.local"), { params: Promise.resolve({ id: r.id }) } as never);
    session.actor = null;
    expect((await get()).status).toBe(401);
    session.actor = w.b.owner;
    expect((await get()).status).toBe(404);
    session.actor = w.a.eng2;
    expect((await get()).status).toBe(404);
    // Readers are redirected to a short-lived signed link, which serves the file.
    session.actor = w.a.viewer;
    const res = await get();
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location).toMatch(/^\/api\/files\//);
    const { GET: file } = await import("@/app/api/files/[token]/route");
    const served = await file(new Request(`http://app.local${location}`), { params: Promise.resolve({ token: location.split("/").pop()! }) } as never);
    expect(served.status).toBe(200);
    expect(new TextDecoder().decode(await served.arrayBuffer())).toBe("%PDF-1.4");
    session.actor = null;
  });
});

describe("workspaces", () => {
  it("someone in two organizations acts in the one they pick, and only in theirs", async () => {
    // Org B's owner is also a viewer in org A, which they joined later and last selected.
    await db.insert(organizationMembers).values({ organizationId: w.orgA, userId: w.b.owner.userId, role: "member", selectedAt: new Date() });
    await db.insert(siteMemberships).values({ siteId: w.site2, userId: w.b.owner.userId, role: "viewer" });

    let actor = await loadActor(w.b.owner.userId);
    expect(actor.orgId).toBe(w.orgA);
    expect((await listSites(actor)).map((s) => s.site.id)).toEqual([w.site2]);
    // Being an owner elsewhere grants nothing here.
    await expect(addExpense(actor, w.site2)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listMyOrganizations(actor)).length).toBe(2);

    const orgB = (await listMyOrganizations(actor)).find((o) => o.id !== w.orgA)!.id;
    await selectOrganization(actor, orgB);
    actor = await loadActor(w.b.owner.userId);
    expect(actor.orgId).toBe(orgB);
    expect((await listSites(actor)).map((s) => s.site.id)).toEqual([w.siteB]);

    await expect(selectOrganization(w.a.eng1, orgB)).rejects.toBeInstanceOf(NotFoundError);
    await expect(selectOrganization(w.a.eng1, "garbage")).rejects.toBeInstanceOf(NotFoundError);
  });
});
