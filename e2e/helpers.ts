import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { hashPassword } from "better-auth/crypto";
import postgres from "postgres";

/**
 * Nothing on the page is wider than the screen. Compared with the device width, not
 * innerWidth: a mobile browser widens its layout viewport (and zooms out) to fit an
 * over-wide page, which would hide the overflow from an innerWidth check.
 */
export async function expectNoHorizontalOverflow(page: Page) {
  const { scroll, inner, screenW } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
    // The device's CSS width: the visual viewport at its current zoom.
    screenW: window.visualViewport ? Math.round(window.visualViewport.width * window.visualViewport.scale) : window.innerWidth,
  }));
  const width = Math.min(inner, screenW);
  expect(scroll, `page is ${scroll}px wide on a ${width}px screen`).toBeLessThanOrEqual(width + 1);
  expect(inner, `layout viewport widened to ${inner}px on a ${screenW}px screen (page zoomed out)`).toBeLessThanOrEqual(screenW + 1);
}

/** No serious or critical WCAG 2.1 A/AA violations from axe-core. */
export async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.help} (${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("; ")})`)).toEqual([]);
}

export const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1024) < 768;

/**
 * A fresh organization and its owner (the admin) in the test database, created the way
 * `npm run db:seed` does, since there is no public sign-up. Returns the credentials.
 */
export async function provisionAdmin() {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const email = `e2e.${id}@test.example`;
  const password = `Passw0rd!${id}`;
  const sql = postgres(process.env.DATABASE_URL_TEST!, { prepare: false, max: 1, onnotice: () => {} });
  try {
    const userId = crypto.randomUUID();
    await sql.begin(async (tx) => {
      await tx`insert into users (id, name, email, email_verified) values (${userId}, ${`E2E ${id}`}, ${email}, true)`;
      await tx`insert into accounts (id, account_id, provider_id, user_id, password) values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId}, ${await hashPassword(password)})`;
      const [org] = await tx`insert into organizations (name, slug) values (${`E2E Builders ${id}`}, ${`e2e-${id}`}) returning id`;
      await tx`insert into organization_members (organization_id, user_id, role) values (${org.id}, ${userId}, 'owner')`;
      await tx`insert into expense_categories (organization_id, code, name, sort_order)
        select ${org.id}, c.code, c.name, c.i from (values ('materials', 'Materials', 0), ('labour', 'Labour', 1), ('transport', 'Transport', 2), ('equipment', 'Equipment', 3), ('other', 'Other', 4)) as c(code, name, i)`;
    });
  } finally {
    await sql.end();
  }
  return { email, password };
}

export async function signIn(page: Page, email: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** A fresh admin for this test run, signed in. */
export async function signInAsNewAdmin(page: Page) {
  const admin = await provisionAdmin();
  await signIn(page, admin.email, admin.password);
  await expect(page.getByRole("heading", { name: "Site expenses" })).toBeVisible({ timeout: 60_000 });
  return admin;
}
