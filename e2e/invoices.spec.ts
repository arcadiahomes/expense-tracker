import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { expectAccessible, expectNoHorizontalOverflow, isMobile, signInAsNewAdmin } from "./helpers";

/** One account per browser project; the steps build on each other. */
test.describe.configure({ mode: "serial" });

let page: Page;
let email: string;
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  page = await context.newPage();
  ({ email } = await signInAsNewAdmin(page));
});
test.afterAll(async () => {
  await page.context().close();
});

/** Optional screenshots for a person to look at: E2E_SHOTS=/some/dir. */
async function shot(name: string) {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/${test.info().project.name}-${name}.png`, fullPage: true });
}

test("a client invoice is numbered, totalled on the server and downloads as a PDF", async () => {
  await page.goto("/sites");
  await page.getByRole("button", { name: "New site" }).first().click();
  await page.getByLabel("Site name").fill("Invoice Site");
  await page.getByLabel("Location").fill("Kochi");
  await page.getByLabel("Budget (₹)").fill("500000");
  await page.getByRole("button", { name: "Create site" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.goto("/invoices");
  await expect(page.getByText("No client invoices yet")).toBeVisible();
  await page.getByRole("button", { name: "New invoice" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New client invoice" });
  await dialog.getByLabel("Client", { exact: true }).fill("Mr. Thomas Varghese");
  await dialog.getByLabel("Item 1 description").fill("Foundation work, running bill 1");
  await dialog.getByLabel("Item 1 quantity").fill("2");
  await dialog.getByLabel("Item 1 rate in rupees").fill("1000.50");
  await dialog.getByRole("button", { name: "Add item" }).click();
  await dialog.getByLabel("Item 2 description").fill("Plastering");
  await dialog.getByLabel("Item 2 quantity").fill("3.5");
  await dialog.getByLabel("Item 2 rate in rupees").fill("100");
  await dialog.getByRole("combobox", { name: "GST" }).click();
  await page.getByRole("option", { name: "GST 18%" }).click();
  await expect(dialog.getByText("₹2,774")).toBeVisible();
  await shot("new-invoice");
  await expectNoHorizontalOverflow(page);
  await dialog.getByRole("button", { name: "Create invoice" }).click();
  await expect(dialog).toBeHidden();

  const list = page.getByRole("region", { name: "Invoices" });
  await expect(list.getByText("Mr. Thomas Varghese")).toBeVisible();
  await expect(list.getByText(/INV\/\d{4}-\d{2}\/0001/)).toBeVisible();
  await shot("client-list");
  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);

  await list.getByText("Mr. Thomas Varghese").click();
  const sheet = page.getByRole("dialog", { name: "Mr. Thomas Varghese" });
  await expect(sheet.getByText("GST @ 18%")).toBeVisible();
  const download = page.waitForEvent("download");
  await sheet.getByRole("link", { name: "Download PDF" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^invoice-inv-\d{4}-\d{2}-0001-mr-thomas-varghese\.pdf$/);

  await sheet.getByRole("button", { name: "Mark as paid" }).click();
  await sheet.getByLabel("Reference (optional)").fill("UTR123");
  await sheet.getByRole("button", { name: "Mark as paid" }).click();
  await expect(sheet.getByText(/Received on .*UTR123/)).toBeVisible();
  await shot("invoice-sheet");
});

test("a labour invoice shows the worker's period and downloads as a PDF", async () => {
  // A worker with attendance and a payment, written straight to the test database.
  const sql = postgres(process.env.DATABASE_URL_TEST!, { prepare: false, max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      const [{ org, uid, site }] = await tx`
        select m.organization_id as org, u.id as uid, s.id as site from users u
        join organization_members m on m.user_id = u.id
        join construction_sites s on s.organization_id = m.organization_id and s.name = 'Invoice Site'
        where u.email = ${email}`;
      const [worker] = await tx`insert into labour_workers (organization_id, name, trade, daily_wage) values (${org}, 'Anu Krishnan', 'Mason', 800) returning id`;
      const days = await tx`select (current_date - n)::date as d from generate_series(1, 3) n`;
      for (const { d } of days) {
        await tx`insert into labour_attendance (site_id, worker_id, work_date, status, day_rate, wage_amount, recorded_by) values (${site}, ${worker.id}, ${d}, 'present', 800, 800, ${uid})`;
      }
    });
  } finally {
    await sql.end();
  }

  await page.goto("/invoices");
  await page.getByRole("tab", { name: "Labour invoices" }).click();
  await page.getByRole("combobox", { name: "Worker" }).click();
  await page.getByRole("option", { name: "Anu Krishnan (Mason)" }).click();
  await expect(page.getByRole("heading", { name: "Anu Krishnan" })).toBeVisible();
  await expect(page.getByText("Wages earned")).toBeVisible();
  await shot("labour");
  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download PDF" }).click();
  expect((await download).suggestedFilename()).toMatch(/^labour-invoice-anu-krishnan-.*\.pdf$/);
});

test("the nav links to invoices", async () => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  if (isMobile(page)) await nav.getByRole("button", { name: "More" }).click();
  await expect(page.getByRole("link", { name: "Invoices" })).toBeVisible();
});
