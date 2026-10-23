import "server-only";

/**
 * Production configuration problems, checked once at server start (src/instrumentation.ts)
 * so a bad deploy fails loudly instead of on the first sign-in or upload. Never prints values.
 */
export function productionEnvProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  if (!env.DATABASE_URL) problems.push("DATABASE_URL is not set (use the Neon pooled connection string).");
  else if (!/sslmode=require|sslmode=verify/.test(env.DATABASE_URL) && !/localhost|127\.0\.0\.1/.test(env.DATABASE_URL))
    problems.push("DATABASE_URL should include sslmode=require.");
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32)
    problems.push("BETTER_AUTH_SECRET must be at least 32 characters (openssl rand -base64 32).");
  if (!env.BETTER_AUTH_URL && !env.VERCEL_URL) problems.push("BETTER_AUTH_URL is not set (the app's public https origin).");
  else if (env.BETTER_AUTH_URL && !/^https:\/\//.test(env.BETTER_AUTH_URL) && !/^http:\/\/localhost/.test(env.BETTER_AUTH_URL))
    problems.push("BETTER_AUTH_URL must be an https:// origin in production.");
  if (env.VERCEL && env.STORAGE_DRIVER !== "s3" && env.STORAGE_DRIVER !== "blob")
    problems.push("STORAGE_DRIVER must be s3 or blob on Vercel: its file system doesn't keep uploads.");
  if (env.STORAGE_DRIVER === "s3" && !env.S3_BUCKET) problems.push("STORAGE_DRIVER=s3 needs S3_BUCKET.");
  if (env.STORAGE_DRIVER === "blob" && !env.BLOB_READ_WRITE_TOKEN && !env.BLOB_STORE_ID)
    problems.push("STORAGE_DRIVER=blob needs BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID (connect a private Blob store to the project).");
  return problems;
}
