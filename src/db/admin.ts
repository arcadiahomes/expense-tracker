/**
 * Server-side admin setup. Runs against DATABASE_URL; there is no web page for this.
 *
 *   npm run admin:bootstrap    Creates the organization and its one permanent admin, once.
 *                              Reads ADMIN_EMAIL, ADMIN_NAME and ORGANIZATION_NAME (server-only
 *                              variables; never NEXT_PUBLIC_*). Does nothing if an admin exists.
 *   npm run admin:reset-link   A one-time password link for the existing admin, e.g. a forgotten password.
 *
 * Passwords are never passed in: the admin sets theirs through the printed link, which works
 * once and expires in 48 hours. Print it only to your own terminal.
 */
import { bootstrapAdmin, issueAdminResetLink } from "@/server/data/accounts";
import { ValidationError } from "@/server/errors";
import { ZodError } from "zod";
import { closeDb } from "./index";

function origin() {
  const url = process.env.BETTER_AUTH_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
  return url.replace(/\/$/, "");
}

async function main(command: string | undefined) {
  if (command === "bootstrap") {
    const result = await bootstrapAdmin({
      email: process.env.ADMIN_EMAIL ?? "",
      name: process.env.ADMIN_NAME ?? "",
      organizationName: process.env.ORGANIZATION_NAME || "Arcadia Home",
    });
    if (result.status === "exists") {
      console.log(`An admin already exists (${result.email}). Nothing was changed.`);
      console.log("If they can't sign in, run: npm run admin:reset-link");
      return;
    }
    console.log(`Admin account ready for ${result.email}.`);
    if (result.link) {
      console.log(`Open this link to set the admin password (works once, expires ${result.link.expiresAt}):`);
      console.log(`  ${origin()}${result.link.path}`);
    } else {
      console.log("This account already had a password; sign in with it.");
    }
    return;
  }
  if (command === "reset-link") {
    const link = await issueAdminResetLink();
    console.log(`Password ${link.purpose} link for ${link.email} (works once, expires ${link.expiresAt}):`);
    console.log(`  ${origin()}${link.path}`);
    return;
  }
  throw new Error("Usage: tsx src/db/admin.ts bootstrap|reset-link");
}

main(process.argv[2])
  .then(() => closeDb())
  .catch(async (err) => {
    if (err instanceof ZodError) console.error(`Check ADMIN_EMAIL and ADMIN_NAME: ${err.issues.map((i) => i.message).join(" ")}`);
    else if (err instanceof ValidationError) console.error(err.message);
    else console.error(err);
    await closeDb();
    process.exit(1);
  });
