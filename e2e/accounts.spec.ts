import { expect, test } from "@playwright/test";
import { signIn, signInAsNewAdmin } from "./helpers";

/**
 * The single-admin account model in a real browser against the production build: no public
 * registration, the admin creates an assistant engineer who sets a password from a one-time
 * link, role-based landing pages, deactivation and sign-out. The flows aren't layout-specific,
 * so they run in one desktop browser.
 */
test.describe.configure({ mode: "serial" });
test.skip(({ browserName, isMobile }) => browserName !== "chromium" || isMobile, "Account flows run in desktop Chromium.");

test("public registration is off in the UI and the API, and cross-site posts are refused", async ({ page, request }) => {
  await page.goto("/sign-up");
  await expect(page.getByRole("heading", { name: "Accounts are created by the admin" })).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveCount(0);
  await page.goto("/sign-in");
  await expect(page.getByRole("link", { name: /create an account/i })).toHaveCount(0);

  const signUp = await request.post("/api/auth/sign-up/email", {
    data: { email: "self@test.example", password: "Passw0rd-long", name: "Self" },
    headers: { origin: test.info().project.use.baseURL! },
  });
  expect(signUp.status()).toBe(404);

  const crossSite = await request.post("/api/auth/sign-in/email", {
    data: { email: "x@test.example", password: "whatever-long" },
    headers: { origin: "https://evil.example", cookie: "better-auth.session_token=x" },
  });
  expect(crossSite.status()).toBe(403);
});

test("wrong password is refused with a clear message", async ({ page }) => {
  const admin = await signInAsNewAdmin(page);
  await page.context().clearCookies();
  await signIn(page, admin.email, "not-the-password");
  await expect(page.getByRole("alert")).toHaveText("That email and password don't match.");
  await expect(page).toHaveURL(/\/sign-in/);
});

test("the admin creates an assistant engineer who sets a password and lands on their own page", async ({ page, browser }) => {
  const admin = await signInAsNewAdmin(page);
  await page.goto("/sites");
  await page.getByRole("button", { name: "New site" }).first().click();
  await page.getByLabel("Site name").fill("Site A");
  await page.getByLabel("Location").fill("Kochi");
  await page.getByLabel("Budget (₹)").fill("500000");
  await page.getByRole("button", { name: "Create site" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.goto("/engineers");
  await page.getByRole("button", { name: "Add assistant engineer" }).first().click();
  const form = page.getByRole("dialog");
  const email = `asst.${Date.now().toString(36)}@test.example`;
  await form.getByLabel("Full name").fill("Anu Joseph");
  await form.getByLabel("Email").fill(email);
  await form.getByText("Site A").click();
  await form.getByRole("button", { name: "Create account" }).click();
  const link = await page.getByLabel("Password link").inputValue();
  expect(link).toMatch(/\/set-password\/[A-Za-z0-9_-]{43}$/);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("Password not set")).toBeVisible();

  // The same email can't be used twice.
  await page.getByRole("button", { name: "Add assistant engineer" }).first().click();
  await form.getByLabel("Full name").fill("Copy");
  await form.getByLabel("Email").fill(email.toUpperCase());
  await form.getByText("Site A").click();
  await form.getByRole("button", { name: "Create account" }).click();
  await expect(form.getByText("An account already uses this email.").first()).toBeVisible();
  await form.getByRole("button", { name: "Cancel" }).click();

  // The assistant engineer, in their own browser.
  const theirs = await browser.newContext();
  const asst = await theirs.newPage();
  await asst.goto(link);
  await asst.getByLabel("New password").fill("Asst-passw0rd-long");
  await asst.getByLabel("Repeat password").fill("Asst-passw0rd-long");
  await asst.getByRole("button", { name: "Save password and sign in" }).click();
  await expect(asst.getByRole("heading", { name: "My entries" })).toBeVisible({ timeout: 60_000 });
  // Admin pages and site records are off limits.
  for (const path of ["/engineers", "/", "/reports", "/approvals"]) {
    await asst.goto(path);
    await expect(asst).toHaveURL(/\/my$/);
  }
  // The link worked once.
  await asst.goto(link);
  await expect(asst.getByRole("heading", { name: "This link can’t be used" })).toBeVisible();

  // Signing in again from the login page goes to their page too.
  await theirs.clearCookies();
  await signIn(asst, email, "Asst-passw0rd-long");
  await expect(asst).toHaveURL(/\/my$/);

  // Deactivated: the open session ends at once and signing in is refused.
  await page.reload();
  await page.getByRole("button", { name: "Deactivate Anu Joseph" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Deactivate" }).click();
  await expect(page.getByText("Deactivated", { exact: true })).toBeVisible();
  await asst.goto("/my");
  await expect(asst).toHaveURL(/\/sign-in/);
  await signIn(asst, email, "Asst-passw0rd-long");
  await expect(asst.getByRole("alert")).toHaveText("This account is deactivated. Ask the admin to reactivate it.");
  await theirs.close();

  // The admin signs out; protected pages send them to sign in.
  await page.goto("/settings");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await page.goto("/engineers");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fengineers/);
  await page.getByLabel("Email").fill(admin.email);
  await page.getByLabel("Password").fill(admin.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/engineers$/);
});
