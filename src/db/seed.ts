/**
 * Demo data: `npm run db:seed`. Idempotent: it removes the demo organization and
 * demo users, then recreates them. Never touches other organizations.
 *
 * Bulk expenses are inserted directly for speed; bills, payments and receipts go
 * through the real data layer so the seed exercises the same rules as the app.
 */
import { hashPassword } from "better-auth/crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { daysBetween, shiftDate } from "@/lib/dates";
import { loadActor } from "@/server/authz";
import { createBill, recordPayment } from "@/server/data/bills";
import { recordClientPayment, refundClientPayment } from "@/server/data/client-payments";
import { createExpense, reviewExpense } from "@/server/data/expenses";
import { createClientInvoice } from "@/server/data/invoices";
import { createOrganization, updateOrganizationProfile } from "@/server/data/organizations";
import { addReceipt } from "@/server/data/receipts";
import { today } from "@/server/data/shared";
import { closeDb, db } from "./index";
import {
  accounts,
  constructionSites,
  expenseCategories,
  expenseItems,
  expenses,
  labourAttendance,
  labourWorkers,
  organizations,
  siteBudgets,
  siteMemberships,
  suppliers,
  users,
} from "./schema";
import { BILLS, SEED_REFERENCE_DATE, SITES, SUPPLIERS, TEMPLATES, WORKERS, mulberry32 } from "./seed-data";

const DEMO_SLUG = "arcadia-home-demo";

const PEOPLE = [
  { key: "arun", name: "Arun Varghese", email: "arun@arcadia.example", jobTitle: "Site engineer", orgRole: "owner" as const },
  { key: "suresh", name: "Suresh Gowda", email: "suresh@arcadia.example", jobTitle: "Site engineer", orgRole: "member" as const },
  { key: "priya", name: "Priya Natarajan", email: "priya@arcadia.example", jobTitle: "Site engineer", orgRole: "member" as const },
  { key: "neethu", name: "Neethu Thomas", email: "neethu@arcadia.example", jobTitle: "Site engineer", orgRole: "member" as const },
  { key: "omkar", name: "Omkar Patil", email: "omkar@arcadia.example", jobTitle: "Site engineer", orgRole: "member" as const },
  { key: "kavya", name: "Kavya Rao", email: "kavya@arcadia.example", jobTitle: "Client representative", orgRole: "member" as const },
  { key: "meera", name: "Meera Iyer", email: "meera@arcadia.example", jobTitle: "Accountant", orgRole: "member" as const },
  { key: "rahul", name: "Rahul Menon", email: "rahul@arcadia.example", jobTitle: "Assistant engineer", orgRole: "member" as const },
];

const ENGINEER_KEY: Record<string, string> = {
  "Arun Varghese": "arun",
  "Suresh Gowda": "suresh",
  "Priya Natarajan": "priya",
  "Neethu Thomas": "neethu",
  "Omkar Patil": "omkar",
};

/** "100 bags" → { quantity: "100", unit: "bags" }; "4,000 nos" works too. */
function splitQuantity(label?: string) {
  const m = label?.match(/^([\d,.]+)\s*(.+)$/);
  if (!m) return { quantity: "1", unit: "lot" };
  return { quantity: m[1].replace(/,/g, ""), unit: m[2] };
}

const PDF_BYTES = new TextEncoder().encode(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);
// 1×1 transparent PNG.
const PNG_BYTES = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"),
);

async function wipe() {
  const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, DEMO_SLUG));
  if (org) {
    // Sites first: their cascade removes expenses, bills, payments, receipts and attendance,
    // which otherwise block deleting categories, suppliers and workers.
    await db.delete(constructionSites).where(eq(constructionSites.organizationId, org.id));
    await db.delete(organizations).where(eq(organizations.id, org.id));
  }
  await db.delete(users).where(inArray(users.email, PEOPLE.map((p) => p.email)));
}

async function main() {
  // Demo users with a shared password must never exist in production.
  if (process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production") {
    throw new Error("Refusing to seed demo data in production. Seed a development or preview database instead.");
  }
  const password = process.env.SEED_DEMO_PASSWORD;
  if (!password || password.length < 8) {
    throw new Error("Set SEED_DEMO_PASSWORD (8+ characters) in .env before seeding.");
  }
  const t = today();
  const offset = daysBetween(SEED_REFERENCE_DATE, t);
  const shift = (d: string) => shiftDate(d, offset);
  console.log(`Seeding demo data ending ${t}…`);

  await wipe();

  // ---- People and organization ----
  const hash = await hashPassword(password);
  const userIds: Record<string, string> = {};
  for (const p of PEOPLE) {
    const id = crypto.randomUUID();
    userIds[p.key] = id;
    await db.insert(users).values({ id, name: p.name, email: p.email, emailVerified: true, jobTitle: p.jobTitle, phone: "+91 98470 21356" });
    await db.insert(accounts).values({ id: crypto.randomUUID(), accountId: id, providerId: "credential", userId: id, password: hash });
  }
  const org = await createOrganization(userIds.arun, "Arcadia Home");
  await db.update(organizations).set({ slug: DEMO_SLUG }).where(eq(organizations.id, org.id));
  await db.execute(sql`
    insert into organization_members (organization_id, user_id, role)
    select ${org.id}, u.id, 'member' from users u where u.id in ${PEOPLE.filter((p) => p.orgRole === "member").map((p) => userIds[p.key])}
  `);

  const cats = await db.select().from(expenseCategories).where(eq(expenseCategories.organizationId, org.id));
  const catId = Object.fromEntries(cats.map((c) => [c.code, c.id]));

  const supplierRows = await db
    .insert(suppliers)
    .values(SUPPLIERS.map((name) => ({ organizationId: org.id, name })))
    .returning();
  const supplierId = Object.fromEntries(supplierRows.map((s) => [s.name, s.id]));
  const workerRows = await db
    .insert(labourWorkers)
    .values(
      WORKERS.map((label) => {
        const [, name, trade] = label.match(/^(.+?) \((.+)\)$/) ?? [label, label, null];
        return { organizationId: org.id, name: label, trade: trade ?? undefined, dailyWage: name ? "900.00" : undefined };
      }),
    )
    .returning();
  const workerId = Object.fromEntries(workerRows.map((w) => [w.name, w.id]));

  // ---- Sites, budgets, memberships ----
  const siteId: Record<string, string> = {};
  for (const s of SITES) {
    const [row] = await db
      .insert(constructionSites)
      .values({
        organizationId: org.id,
        name: s.name,
        location: s.location,
        clientName: s.client,
        status: s.status === "on-hold" ? "on_hold" : s.status,
        startDate: shift(s.startDate),
        createdBy: userIds.arun,
      })
      .returning({ id: constructionSites.id });
    siteId[s.id] = row.id;
    await db.insert(siteBudgets).values({ siteId: row.id, amount: s.budget.toFixed(2), updatedBy: userIds.arun });
    const engineer = ENGINEER_KEY[s.engineer];
    if (engineer && engineer !== "arun") {
      await db.insert(siteMemberships).values({ siteId: row.id, userId: userIds[engineer], role: "engineer", addedBy: userIds.arun });
    }
  }
  // Kavya is the client's representative: read-only on one site.
  await db.insert(siteMemberships).values({ siteId: siteId["whitefield-villa"], userId: userIds.kavya, role: "viewer", addedBy: userIds.arun });
  // Meera keeps the books (bills, payments, budgets, exports) on every site.
  await db.insert(siteMemberships).values(
    Object.values(siteId).map((id) => ({ siteId: id, userId: userIds.meera, role: "accountant" as const, addedBy: userIds.arun })),
  );

  // Rahul is an assistant engineer on one site: his entries wait for Arun's approval.
  await db.insert(siteMemberships).values({ siteId: siteId["whitefield-villa"], userId: userIds.rahul, role: "assistant", addedBy: userIds.arun });

  // ---- Expenses with line items (deterministic) ----
  const rand = mulberry32(42);
  const pick = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  const modes = ["cash", "upi", "upi", "bank", "credit"] as const;
  const expenseRows: (typeof expenses.$inferInsert)[] = [];
  const itemRows: Omit<typeof expenseItems.$inferInsert, "expenseId">[][] = [];

  for (const s of SITES) {
    const lastDay = s.status === "completed" ? -150 : s.status === "on-hold" ? -38 : 0;
    const intensity = s.budget > 10_000_000 ? 4 : s.budget > 5_000_000 ? 3 : 2;
    const creator = userIds[ENGINEER_KEY[s.engineer] ?? "arun"];
    for (let day = daysBetween(SEED_REFERENCE_DATE, s.startDate); day <= lastDay; day++) {
      const date = shiftDate(t, day);
      const isSunday = new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
      const count = isSunday ? 0 : Math.floor(rand() * intensity) + 1;
      for (let i = 0; i < count; i++) {
        const tpl = pick(TEMPLATES);
        const amount = Math.round((tpl.min + rand() * (tpl.max - tpl.min)) / 10) * 10;
        const { quantity, unit } = splitQuantity(tpl.quantity);
        const unitPrice = (amount / Number(quantity)).toFixed(2);
        const viaVoice = rand() < 0.35;
        expenseRows.push({
          siteId: siteId[s.id],
          categoryId: catId[tpl.category],
          expenseDate: date,
          description: tpl.description,
          paymentMethod: tpl.category === "labour" ? "cash" : pick([...modes]),
          source: viaVoice ? "voice" : "manual",
          supplierId: tpl.supplier ? supplierId[pick(SUPPLIERS)] : null,
          labourWorkerId: tpl.worker ? workerId[pick(WORKERS)] : null,
          voiceTranscript: viaVoice ? `${tpl.description} ${tpl.quantity ?? ""} ${amount} rupees`.replace(/\s+/g, " ") : null,
          createdBy: creator,
          // Demo entries were all entered directly, so they count.
          status: "approved" as const,
          submittedAt: new Date(`${date}T12:00:00+05:30`),
          reviewedBy: creator,
          reviewedAt: new Date(`${date}T12:00:00+05:30`),
        });
        itemRows.push([{ position: 0, description: tpl.description, quantity, unit, unitPrice }]);
      }
    }
  }

  const CHUNK = 400;
  for (let i = 0; i < expenseRows.length; i += CHUNK) {
    const inserted = await db.insert(expenses).values(expenseRows.slice(i, i + CHUNK)).returning({ id: expenses.id });
    await db.insert(expenseItems).values(
      inserted.flatMap((row, j) => itemRows[i + j].map((it) => ({ ...it, expenseId: row.id }))),
    );
  }
  // Totals always come from items, computed by Postgres.
  await db.execute(sql`
    update expenses e set total_amount = s.total
    from (select expense_id, sum(amount) as total from expense_items group by expense_id) s
    where s.expense_id = e.id and e.site_id in ${Object.values(siteId)}
  `);
  console.log(`  ${expenseRows.length} expenses`);

  // ---- Labour attendance for the last ~120 days on active sites ----
  const attendance: (typeof labourAttendance.$inferInsert)[] = [];
  const crew = WORKERS.slice(0, 6);
  for (const s of SITES.filter((x) => x.status === "active")) {
    const start = Math.max(-120, daysBetween(SEED_REFERENCE_DATE, s.startDate));
    for (let day = start; day <= 0; day++) {
      const date = shiftDate(t, day);
      if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue;
      for (const w of crew) {
        if (rand() < 0.45) continue;
        const half = rand() < 0.15;
        attendance.push({
          siteId: siteId[s.id],
          workerId: workerId[w],
          workDate: date,
          status: half ? "half_day" : "present",
          hours: half ? "4.0" : "8.0",
          wageAmount: half ? "450.00" : "900.00",
          recordedBy: userIds[ENGINEER_KEY[s.engineer] ?? "arun"],
        });
      }
    }
  }
  for (let i = 0; i < attendance.length; i += CHUNK) await db.insert(labourAttendance).values(attendance.slice(i, i + CHUNK));
  console.log(`  ${attendance.length} attendance records`);

  // ---- Bills, payments and receipts through the data layer ----
  const owner = await loadActor(userIds.arun);

  // Submissions from the assistant engineer: one waiting, one sent back with a reason, one draft.
  const rahul = await loadActor(userIds.rahul);
  const entry = (description: string, unitPrice: string, submit: boolean) =>
    createExpense(rahul, {
      siteId: siteId["whitefield-villa"],
      categoryCode: "materials",
      expenseDate: t,
      description,
      paymentMethod: "cash",
      items: [{ description, quantity: "1", unit: "lot", unitPrice }],
      submit,
    });
  await entry("Binding wire", "1850", true);
  const rejected = await entry("PVC conduit pipes", "4200", true);
  await reviewExpense(owner, { id: rejected.id, decision: "reject", note: "The bill says 3,950. Attach the bill and correct the amount." });
  await entry("Tile spacers", "320", false);
  for (const b of BILLS) {
    const bill = await createBill(owner, {
      siteId: siteId[b.siteId],
      supplierName: b.supplier,
      billNumber: b.billNo,
      billDate: shift(b.date),
      dueDate: shift(b.dueDate),
      amount: b.amount.toFixed(2),
      categoryCode: /transport/i.test(b.supplier) ? "transport" : /earthmovers/i.test(b.supplier) ? "equipment" : "materials",
      description: b.description,
    });
    if (b.paid > 0) {
      const paidOn = shift(b.date) > t ? t : shiftDate(shift(b.date), Math.min(3, daysBetween(shift(b.date), t)));
      await recordPayment(owner, { billId: bill.id, amount: b.paid.toFixed(2), paidOn, method: "bank", reference: `NEFT-${b.billNo}` });
    }
    if (b.attachment) {
      await addReceipt(
        owner,
        {
          siteId: bill.siteId,
          supplierBillId: bill.id,
          fileName: b.attachment.name,
          contentType: b.attachment.kind === "pdf" ? "application/pdf" : "image/png",
        },
        b.attachment.kind === "pdf" ? PDF_BYTES : PNG_BYTES,
      );
    }
  }
  console.log(`  ${BILLS.length} bills with payments and receipts`);

  // ---- Client invoices and receipts ----
  await updateOrganizationProfile(owner, {
    address: "2nd Floor, Infopark Road, Kakkanad, Kochi, Kerala 682042",
    phone: "+91 98470 21356",
    email: "accounts@arcadia.example",
    website: "arcadia.example",
  });
  const project = await createClientInvoice(owner, {
    siteId: siteId[SITES[0].id],
    invoiceDate: shiftDate(t, -80),
    dueDate: shiftDate(t, 20),
    clientName: SITES[0].client ?? "Mr. Thomas Varghese",
    clientAddress: "Kakkanad, Kochi 682030",
    clientPhone: "+91 94470 55555",
    items: [
      { description: "Structure and finishing, as per agreement", quantity: "1", unit: "lot", unitPrice: "900000" },
      { description: "Interiors: modular kitchen and wardrobes", quantity: "1", unit: "lot", unitPrice: "600000" },
    ],
  });
  const receive = (invoiceId: string, amount: string, daysAgo: number, method: "bank" | "cheque" | "upi", reference: string, notes?: string) =>
    recordClientPayment(owner, { invoiceId, amount, paidOn: shiftDate(t, -daysAgo), method, reference, notes, clientKey: crypto.randomUUID() });
  await receive(project.id, "500000", 78, "bank", "NEFT-AX2231", "Advance on signing the agreement");
  await receive(project.id, "200000", 40, "bank", "NEFT-AX5120", "Second installment after slab work");
  const bounced = await receive(project.id, "150000", 12, "cheque", "Cheque 004512");
  await refundClientPayment(owner, { paymentId: bounced.id, kind: "reversal", paidOn: shiftDate(t, -9), method: "cheque", reason: "Cheque 004512 returned unpaid", clientKey: crypto.randomUUID() });
  const small = await createClientInvoice(owner, {
    siteId: siteId[SITES[1].id],
    invoiceDate: shiftDate(t, -30),
    dueDate: shiftDate(t, -15),
    clientName: SITES[1].client ?? "Client",
    items: [{ description: "Design consultation and drawings", quantity: "1", unit: "lot", unitPrice: "75000" }],
    gstPercent: "18",
  });
  await receive(small.id, "50000", 25, "upi", "UPI 6021 4410 8821");
  await receive(small.id, "38500", 10, "upi", "UPI 6021 9932 1176", "Final payment");
  console.log("  2 client invoices with receipts and a reversal");

  console.log("\nDemo sign-ins (password is SEED_DEMO_PASSWORD):");
  for (const p of PEOPLE) {
    const role =
      p.orgRole === "owner"
        ? "org owner, owns every site"
        : p.key === "kavya"
          ? "viewer on Whitefield Villa 12"
          : p.key === "meera"
            ? "accountant on every site"
            : p.key === "rahul"
              ? "assistant engineer on Whitefield Villa 12 (entries need approval)"
              : "engineer on their site";
    console.log(`  ${p.email.padEnd(26)} ${role}`);
  }
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
