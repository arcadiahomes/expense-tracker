import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/server/authz";
import { createExpense } from "@/server/data/expenses";
import { expense, world } from "./fixtures";

// The route's only outside dependency is "who is asking"; everything else is real.
const session = vi.hoisted(() => ({ actor: null as Actor | null }));
vi.mock("@/server/session", () => ({ getActor: async () => session.actor, requireActor: async () => session.actor }));

const { GET } = await import("@/app/api/reports/download/route");

let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => {
  w = await world();
  await createExpense(w.a.owner, expense(w.site1, { description: "Cement", items: [{ description: "Cement", unitPrice: "1234.50" }] }));
}, 600_000);

const get = (as: Actor | null, q: Record<string, string>) => {
  session.actor = as;
  return GET(new Request(`http://test/api/reports/download?${new URLSearchParams(q)}`));
};
const q = (over: Record<string, string> = {}) => ({ kind: "expenses", format: "xlsx", from: "2026-10-01", to: "2026-10-20", ...over });

describe("report download route", () => {
  it("serves Excel and PDF files to owners and accountants", async () => {
    const xlsx = await get(w.a.accountant, q({ site: w.site1 }));
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(xlsx.headers.get("content-disposition")).toBe('attachment; filename="expenses-site-one-2026-10-01-to-2026-10-20.xlsx"');
    expect(xlsx.headers.get("cache-control")).toBe("private, no-store");
    // xlsx files are zip archives.
    expect(Buffer.from(await xlsx.arrayBuffer()).subarray(0, 2).toString()).toBe("PK");

    const pdf = await get(w.a.owner, q({ format: "pdf" }));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-disposition")).toContain("expenses-all-sites-");
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("answers with the right status when it can't", async () => {
    expect((await get(null, q())).status).toBe(401);
    expect((await get(w.a.eng1, q())).status).toBe(403);
    expect((await get(w.a.viewer, q({ site: w.site1 }))).status).toBe(403);
    expect((await get(w.a.eng2, q({ site: w.site1 }))).status).toBe(404);
    expect((await get(w.b.owner, q({ site: w.site1 }))).status).toBe(404);
    expect((await get(w.a.owner, q({ kind: "secrets" }))).status).toBe(400);
    expect((await get(w.a.owner, q({ from: "2026-10-20", to: "2026-10-01" }))).status).toBe(400);
    expect((await get(w.a.owner, q({ to: "2026-12-31" }))).status).toBe(400);
  });
});
