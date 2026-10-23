import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { db } from "@/db";

const TABLES = [
  "users",
  "sessions",
  "accounts",
  "verifications",
  "organizations",
  "organization_members",
  "construction_sites",
  "site_memberships",
  "site_budgets",
  "expense_categories",
  "expenses",
  "expense_items",
  "labour_workers",
  "labour_attendance",
  "suppliers",
  "supplier_bills",
  "receipts",
  "payments",
  "invitations",
  "invitation_sites",
  "voice_batches",
  "materials",
  "material_purchases",
  "material_purchase_items",
  "material_usage",
  "audit_log",
  "notifications",
  "rate_limits",
  "request_limits",
  "password_links",
  "client_invoices",
  "client_invoice_items",
  "client_payments",
];

describe("migrations", () => {
  it("create every table", async () => {
    const rows = (await db.execute(sql`
      select table_name from information_schema.tables where table_schema = 'public'
    `)) as unknown as { table_name: string }[];
    expect(rows.map((r) => r.table_name).sort()).toEqual([...TABLES].sort());
  });

  it("are idempotent when re-run", async () => {
    const client = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1, onnotice: () => {} });
    try {
      await migrate(drizzle(client), { migrationsFolder: "drizzle" });
      const [{ n }] = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
      expect(n).toBe(17);
    } finally {
      await client.end();
    }
  });

  it("add the key foreign keys and unique constraints", async () => {
    const fks = (await db.execute(sql`
      select tc.table_name, kcu.column_name, ccu.table_name as ref
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
      join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
      where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'
    `)) as unknown as { table_name: string; column_name: string; ref: string }[];
    const has = (t: string, c: string, ref: string) =>
      fks.some((f) => f.table_name === t && f.column_name === c && f.ref === ref);
    expect(has("expenses", "site_id", "construction_sites")).toBe(true);
    expect(has("expenses", "created_by", "users")).toBe(true);
    expect(has("expense_items", "expense_id", "expenses")).toBe(true);
    expect(has("site_budgets", "site_id", "construction_sites")).toBe(true);
    expect(has("payments", "supplier_bill_id", "supplier_bills")).toBe(true);
    expect(has("receipts", "expense_id", "expenses")).toBe(true);
    expect(has("construction_sites", "organization_id", "organizations")).toBe(true);
    expect(has("invitation_sites", "site_id", "construction_sites")).toBe(true);
    expect(has("invitations", "organization_id", "organizations")).toBe(true);
    expect(has("expenses", "reviewed_by", "users")).toBe(true);
    expect(has("notifications", "user_id", "users")).toBe(true);
    expect(has("notifications", "expense_id", "expenses")).toBe(true);

    const uniques = (await db.execute(sql`
      select indexdef from pg_indexes where schemaname = 'public' and indexdef ilike '%unique%'
    `)) as unknown as { indexdef: string }[];
    const defs = uniques.map((u) => u.indexdef).join("\n");
    expect(defs).toMatch(/site_budgets.*\(site_id, category_id\) NULLS NOT DISTINCT/);
    expect(defs).toMatch(/labour_attendance.*\(site_id, worker_id, work_date\)/);
    expect(defs).toMatch(/supplier_bills.*\(supplier_id, bill_number\)/);
  });

  it("give expenses an approval status that existing rows default to approved, with checks per status", async () => {
    const [col] = (await db.execute(sql`
      select udt_name, column_default, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'expenses' and column_name = 'status'
    `)) as unknown as { udt_name: string; column_default: string; is_nullable: string }[];
    expect(col).toMatchObject({ udt_name: "expense_status", is_nullable: "NO" });
    expect(col.column_default).toContain("approved");
    const checks = (await db.execute(sql`
      select conname from pg_constraint where conrelid = 'expenses'::regclass and contype = 'c'
    `)) as unknown as { conname: string }[];
    expect(checks.map((c) => c.conname)).toEqual(
      expect.arrayContaining(["expenses_submitted_has_time", "expenses_reviewed_has_reviewer", "expenses_rejected_has_reason"]),
    );
    const roles = (await db.execute(sql`select unnest(enum_range(null::site_role))::text as r`)) as unknown as { r: string }[];
    expect(roles.map((r) => r.r)).toContain("assistant");
  });

  it("store money as numeric(14,2) and compute item amounts in the database", async () => {
    const cols = (await db.execute(sql`
      select table_name, column_name, numeric_precision, numeric_scale, is_generated
      from information_schema.columns
      where table_schema = 'public' and column_name in ('total_amount', 'amount', 'unit_price')
    `)) as unknown as { table_name: string; column_name: string; numeric_precision: number; numeric_scale: number; is_generated: string }[];
    for (const c of cols) {
      expect([c.numeric_precision, c.numeric_scale]).toEqual([14, 2]);
    }
    expect(cols.find((c) => c.table_name === "expense_items" && c.column_name === "amount")?.is_generated).toBe("ALWAYS");
  });
});
