import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, expectNoHorizontalOverflow, isMobile, signInAsNewAdmin } from "./helpers";

const EXAMPLE = "Site A, 20 bags cement, 8,000 rupees. Sand 5,000. Anu labour 1,000 and Akhil labour 800.";

/** One account per browser project; the steps build on each other. */
test.describe.configure({ mode: "serial" });

let page: Page;
test.beforeAll(async ({ browser }) => {
  // A context (not browser.newPage) so axe-core can open its own pages; the project's device settings apply.
  const context = await browser.newContext();
  page = await context.newPage();
  await signInAsNewAdmin(page);
});
test.afterAll(async () => {
  await page.context().close();
});

/** The total on the Reports page for this month: what the server actually stored. */
async function reportedTotal() {
  await page.goto("/reports");
  const summary = page.getByRole("region", { name: "Summary" });
  await expect(summary).toBeVisible();
  return (await summary.textContent()) ?? "";
}

test("navigation fits the device", async () => {
  // The hidden bar (sidebar on phones, bottom bar on desktop) is out of the accessibility tree,
  // so screen readers meet exactly one main navigation.
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav).toHaveCount(1);
  if (isMobile(page)) {
    await expect(nav.getByRole("button", { name: "More" })).toBeVisible();
    await nav.getByRole("button", { name: "More" }).click();
    const sheet = page.getByRole("dialog", { name: "More" });
    await expect(sheet.getByRole("link", { name: "Materials" })).toBeVisible();
    await expect(sheet.getByRole("link", { name: "Suppliers" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  } else {
    await expect(nav.getByRole("link", { name: "Labour" })).toBeVisible();
    await expect(nav.getByRole("button", { name: "More" })).toHaveCount(0);
    // Keyboard users can skip straight to the content.
    await page.goto("/");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  }
  await expectNoHorizontalOverflow(page);
});

test("a new site, created once however often it's tapped, becomes the visible active site", async () => {
  await page.goto("/sites");
  await page.getByRole("button", { name: "New site" }).first().click();
  await page.getByLabel("Site name").fill("Site A");
  await page.getByLabel("Location").fill("Kochi");
  await page.getByLabel("Budget (₹)").fill("500000");
  await page.getByRole("button", { name: "Create site" }).dblclick({ force: true });
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.goto("/sites");
  await expect(page.getByRole("button", { name: "Actions for Site A" })).toHaveCount(1);
  await page.goto("/voice");
  if (isMobile(page)) await expect(page.getByRole("button", { name: "Active site: Site A. Change site" })).toBeVisible();
  else await expect(page.getByRole("combobox", { name: "Active site" })).toContainText("Site A");
});

test("pages fit the screen and are private", async () => {
  for (const path of ["/", "/voice", "/materials", "/labour", "/reports", "/bills", "/suppliers", "/engineers"]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    expect(res?.headers()["cache-control"], path).toMatch(/private.*no-store|no-store.*private/);
    await expectNoHorizontalOverflow(page);
  }
});

test("voice: a large mic, then one save however often Confirm is tapped", async () => {
  await page.goto("/voice");
  const mic = page.getByRole("button", { name: "Start recording" });
  const box = await mic.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(96);
  expect(box!.height).toBeGreaterThanOrEqual(96);
  await expect(mic).toHaveAttribute("aria-describedby", "voice-status");

  await page.getByRole("button", { name: "Type it" }).click();
  await page.getByLabel("Type what you paid for").fill(EXAMPLE);
  await page.getByRole("button", { name: "Find expenses" }).click();
  await expect(page.getByRole("article", { name: /^Entry \d$/ })).toHaveCount(4);
  // Payment mode wasn't said: nothing is guessed, the user sets it.
  await expect(page.getByText("Payment mode wasn't said")).toBeVisible();
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: "Review and save" }).click();
  const dialog = page.getByRole("dialog", { name: "Save 4 expenses?" });
  await expect(dialog).toContainText("14,800");
  const confirm = dialog.getByRole("button", { name: "Confirm and save" });
  await confirm.dblclick({ force: true });
  await expect(page.getByRole("region", { name: "Entries" }).getByText("4 expenses saved", { exact: true })).toBeVisible();
  expect(await reportedTotal()).toContain("14,800");
});

test("offline: kept as an unsynced draft, sent when back online, never claimed early", async () => {
  await page.goto("/voice");
  await page.getByRole("button", { name: "Type it" }).click();
  await page.getByLabel("Type what you paid for").fill("sand 3000 cash");
  await page.getByRole("button", { name: "Find expenses" }).click();
  await expect(page.getByRole("article", { name: "Entry 1" })).toBeVisible();

  await page.context().setOffline(true);
  await expect(page.getByText("You're offline.").first()).toBeVisible();
  await page.getByRole("button", { name: "Keep on this device" }).click();
  const drafts = page.getByRole("region", { name: /Unsynced drafts on this device \(1\)/ });
  await expect(drafts).toBeVisible();
  await expect(drafts).toContainText("Unsynced, on this device only");
  await expect(drafts).toContainText("Captured");
  await expect(page.getByText("Not saved to the server")).toBeVisible();
  await expect(page.getByText(/expenses? saved/)).toHaveCount(0);

  await page.context().setOffline(false);
  await expect(page.getByText("Synced 1 expense")).toBeVisible({ timeout: 60_000 });
  await expect(drafts).toBeHidden();
  expect(await reportedTotal()).toContain("17,800");
});

test("the service worker caches build assets only, never data", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "Service worker inspection runs in Chromium.");
  await page.goto("/");
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toMatch(/\/$/);
  await page.goto("/voice");
  await page.goto("/reports");
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) urls.push(new URL(req.url).pathname);
    return urls;
  });
  expect(cached.length).toBeGreaterThan(0);
  expect(cached.filter((u) => !/^\/(_next\/static\/|icons\/|offline\.html$)/.test(u))).toEqual([]);
});

test("main screens pass an accessibility scan", async () => {
  for (const path of ["/", "/voice", "/labour", "/materials"]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    await expectAccessible(page);
  }
});
