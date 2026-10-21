import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/** The only place DATABASE_URL is read. Never import this from client code. */
function connectionString() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  return url;
}

export function createDb(url: string) {
  // `prepare: false` is required by Neon's transaction-mode pooler.
  const client = postgres(url, { prepare: false, max: 10 });
  return { db: drizzle({ client, schema, casing: "snake_case" }), client };
}

export type Db = ReturnType<typeof createDb>["db"];
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Reuse one pool across dev hot reloads instead of opening a new one per edit.
const globalForDb = globalThis as unknown as { arcadiaDb?: ReturnType<typeof createDb> };

function instance() {
  if (!globalForDb.arcadiaDb) globalForDb.arcadiaDb = createDb(connectionString());
  return globalForDb.arcadiaDb;
}

/** Lazily connected so importing this module never needs the env var (e.g. during build). */
export const db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = instance().db;
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export async function closeDb() {
  await globalForDb.arcadiaDb?.client.end({ timeout: 5 });
  globalForDb.arcadiaDb = undefined;
}

export { schema };
