import { defineConfig } from "drizzle-kit";

// drizzle-kit doesn't read .env on its own (Next.js does, for the app).
try {
  process.loadEnvFile();
} catch {
  // No .env file; rely on the environment.
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  casing: "snake_case",
  // Migrations prefer the direct (non-pooled) connection when one is given.
  dbCredentials: {
    url: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || "",
  },
  strict: true,
});
