import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests against a production build (`next start`, so the service worker and
 * real caching headers are in play), using the TEST database, never the dev one.
 * Engines: Chromium and Firefox. WebKit (Safari) isn't covered here; see docs/mobile.md.
 */
try {
  process.loadEnvFile();
} catch {
  // CI provides the environment.
}
const PORT = 3100;
const baseURL = `http://localhost:${PORT}`;
if (!process.env.DATABASE_URL_TEST) throw new Error("DATABASE_URL_TEST is required for e2e tests.");

export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: { baseURL, trace: "retain-on-failure", actionTimeout: 30_000, navigationTimeout: 60_000 },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "desktop-firefox", use: { ...devices["Desktop Firefox"], viewport: { width: 1280, height: 800 } } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
    // Small iPhone-sized screen, emulated in Chromium (not Safari).
    { name: "mobile-small", use: { ...devices["Pixel 7"], viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 } },
  ],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `${baseURL}/sign-in`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      DATABASE_URL: process.env.DATABASE_URL_TEST,
      DIRECT_DATABASE_URL: process.env.DATABASE_URL_TEST,
      BETTER_AUTH_URL: baseURL,
      UPLOAD_DIR: ".e2e-uploads",
      FILE_URL_SECRET: "e2e-file-url-secret",
      // The UI paths under test don't need AI; keep them deterministic.
      ANTHROPIC_API_KEY: "",
      // Every test signs in again from one address; the limits have their own unit tests.
      RATE_LIMIT: "off",
    },
  },
});
