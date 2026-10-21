import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Brings the test database up to date without dropping it. (`npm run e2e` builds the app first.) */
export default async function setup() {
  const url = process.env.DATABASE_URL_TEST!;
  for (const other of [process.env.DATABASE_URL, process.env.DIRECT_DATABASE_URL]) {
    if (other && other === url) throw new Error("DATABASE_URL_TEST must be a separate database.");
  }
  const client = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  } finally {
    await client.end();
  }
}
