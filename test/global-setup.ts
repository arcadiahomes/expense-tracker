import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { testDatabaseUrl } from "./env";

/** Fresh schema for every run: drop everything, then apply the real migrations. */
export default async function setup() {
  const url = testDatabaseUrl();
  const client = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
  try {
    await client.unsafe("drop schema if exists drizzle cascade; drop schema if exists public cascade; create schema public;");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  } finally {
    await client.end();
  }
}
