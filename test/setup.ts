import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { closeDb } from "@/db";
import { testDatabaseUrl } from "./env";

// The app reads DATABASE_URL; point it at the test branch for this process.
process.env.DATABASE_URL = testDatabaseUrl();
// A fixed Tuesday so date-based totals are deterministic.
process.env.APP_TODAY = "2026-10-20";
process.env.UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), "arcadia-uploads-"));
// Signs local file links in tests; production sets its own secret.
process.env.FILE_URL_SECRET ||= "test-file-url-secret";

afterAll(async () => {
  await closeDb();
});
