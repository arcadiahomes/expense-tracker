import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // `server-only` throws outside React Server Components; tests run on the server anyway.
      "server-only": path.resolve(__dirname, "test/empty.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/setup.ts"],
    // One shared test database: run files one after another.
    fileParallelism: false,
    // Generous: tests hit a real remote database, and each call is several round trips.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
