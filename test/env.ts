/** Resolves the test database URL and refuses anything that looks like the dev database. */
export function testDatabaseUrl() {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file; rely on the environment (e.g. CI secrets).
  }
  const url = process.env.DATABASE_URL_TEST;
  if (!url) {
    throw new Error("DATABASE_URL_TEST is not set. Point it at a separate Neon branch; tests drop and recreate its schema.");
  }
  for (const other of [process.env.DATABASE_URL, process.env.DIRECT_DATABASE_URL]) {
    if (other && sameDatabase(url, other)) {
      throw new Error("DATABASE_URL_TEST points at the same database as DATABASE_URL. Use a separate Neon branch for tests.");
    }
  }
  return url;
}

function sameDatabase(a: string, b: string) {
  const key = (u: string) => {
    const p = new URL(u);
    // Neon pooled and direct hosts differ only by "-pooler".
    return `${p.hostname.replace("-pooler", "")}${p.pathname}`;
  };
  try {
    return key(a) === key(b);
  } catch {
    return a === b;
  }
}
