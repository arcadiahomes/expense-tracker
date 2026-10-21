import { expect, test } from "@playwright/test";
import { expectAccessible, expectNoHorizontalOverflow } from "./helpers";

test.describe("before signing in", () => {
  test("sign-in fits the screen, is labelled and accessible", async ({ page }) => {
    const res = await page.goto("/sign-in");
    expect(res?.status()).toBe(200);
    await expect(page.locator("html")).toHaveAttribute("lang", "en-IN");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
    await expect(page.locator('meta[name="viewport"]')).not.toHaveAttribute("content", /user-scalable=no|maximum-scale=1/);
    await expectNoHorizontalOverflow(page);
    // Every field can be reached and named by assistive tech.
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await page.getByLabel("Email").focus();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Password")).toBeFocused();
    await expectAccessible(page);
  });

  test("pages are never stored in shared caches", async ({ request }) => {
    const res = await request.get("/sign-in");
    expect(res.headers()["cache-control"]).toMatch(/private/);
    expect(res.headers()["cache-control"]).toMatch(/no-store/);
    const app = await request.get("/", { maxRedirects: 0 });
    expect(app.status()).toBe(307);
  });

  test("the app is installable: manifest, icons, service worker, offline page", async ({ request }) => {
    const manifest = await request.get("/manifest.webmanifest");
    expect(manifest.status()).toBe(200);
    const m = await manifest.json();
    expect(m).toMatchObject({ name: expect.any(String), short_name: "Arcadia", display: "standalone", start_url: "/", scope: "/" });
    expect(m.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes}/${i.purpose}`)).toEqual(["192x192/any", "512x512/any", "512x512/maskable"]);
    for (const icon of m.icons) {
      const r = await request.get(icon.src);
      expect(r.status(), icon.src).toBe(200);
      expect(r.headers()["content-type"]).toBe("image/png");
    }
    expect((await request.get("/apple-icon.png")).status()).toBe(200);
    const sw = await request.get("/sw.js");
    expect(sw.status()).toBe(200);
    expect(sw.headers()["cache-control"]).toBe("no-cache");
    const offline = await request.get("/offline.html");
    expect(offline.status()).toBe(200);
    expect(await offline.text()).toContain("Nothing you entered here has been sent or saved");
  });
});
