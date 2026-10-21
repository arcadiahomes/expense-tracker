import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { productionEnvProblems } from "@/server/env";
import { ValidationError } from "@/server/errors";
import { enforce, hit, RateLimitError } from "@/server/rate-limit";

describe("rate limits", () => {
  beforeAll(() => {
    process.env.RATE_LIMIT = "on";
  });
  afterAll(() => {
    delete process.env.RATE_LIMIT;
  });

  it("allow up to the limit in a window, then refuse with the seconds left", async () => {
    const key = `test:${crypto.randomUUID()}`;
    const limit = { max: 3, windowSec: 600 };
    for (let i = 0; i < 3; i++) expect((await hit(key, limit)).allowed).toBe(true);
    const refused = await hit(key, limit);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter).toBeGreaterThan(590);
    expect(refused.retryAfter).toBeLessThanOrEqual(600);
  });

  it("count each key separately", async () => {
    const limit = { max: 1, windowSec: 600 };
    const a = `test:${crypto.randomUUID()}`;
    expect((await hit(a, limit)).allowed).toBe(true);
    expect((await hit(a, limit)).allowed).toBe(false);
    expect((await hit(`test:${crypto.randomUUID()}`, limit)).allowed).toBe(true);
  });

  it("start a new window once the old one has passed", async () => {
    const key = `test:${crypto.randomUUID()}`;
    const limit = { max: 1, windowSec: 60 };
    await hit(key, limit);
    expect((await hit(key, limit)).allowed).toBe(false);
    await db.execute(sql`update request_limits set window_start = now() - interval '61 seconds' where key = ${key}`);
    expect((await hit(key, limit)).allowed).toBe(true);
  });

  it("count concurrent requests atomically", async () => {
    const key = `test:${crypto.randomUUID()}`;
    const limit = { max: 5, windowSec: 600 };
    const results = await Promise.all(Array.from({ length: 12 }, () => hit(key, limit)));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it("throw a form-friendly error from enforce", async () => {
    const key = `test:${crypto.randomUUID()}`;
    const limit = { max: 1, windowSec: 600 };
    await enforce(key, limit);
    const err = await enforce(key, limit).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/Try again in 10 minutes/);
  });

  it("are off in tests unless switched on", async () => {
    delete process.env.RATE_LIMIT;
    const key = `test:${crypto.randomUUID()}`;
    for (let i = 0; i < 3; i++) expect((await hit(key, { max: 1, windowSec: 600 })).allowed).toBe(true);
    process.env.RATE_LIMIT = "on";
  });
});

describe("production configuration check", () => {
  const good = {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://u:p@ep-x-pooler.ap-southeast-1.aws.neon.tech/app?sslmode=require",
    BETTER_AUTH_SECRET: "x".repeat(44),
    BETTER_AUTH_URL: "https://ledger.example.com",
    VERCEL: "1",
    STORAGE_DRIVER: "s3",
    S3_BUCKET: "receipts",
  } as unknown as NodeJS.ProcessEnv;

  it("passes a complete Vercel setup", () => {
    expect(productionEnvProblems(good)).toEqual([]);
  });

  it("flags missing or unsafe settings without echoing values", () => {
    const problems = productionEnvProblems({
      ...good,
      DATABASE_URL: "postgresql://u:secretpw@db.example.com/app",
      BETTER_AUTH_SECRET: "short",
      BETTER_AUTH_URL: "http://ledger.example.com",
      STORAGE_DRIVER: undefined,
      SEED_DEMO_PASSWORD: "demo-pass",
      VERCEL_ENV: "production",
    });
    expect(problems).toHaveLength(5);
    expect(problems.join(" ")).not.toContain("secretpw");
    expect(problems.join(" ")).not.toContain("demo-pass");
  });
});
