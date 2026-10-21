import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/lib/auth";
import { loadActor, readsRecords, type Actor } from "./authz";
import { UnauthenticatedError } from "./errors";

/** The signed-in user (even one without an organization yet), or null. Cached per request. */
export const getSessionUser = cache(async () => {
  const session = await auth.api.getSession({ headers: await headers() });
  return session ? { id: session.user.id, email: session.user.email, name: session.user.name } : null;
});

/** The signed-in actor for this request, or null. Cached per request. */
export const getActor = cache(async (): Promise<Actor | null> => {
  const session = await getSessionUser();
  if (!session) return null;
  try {
    return await loadActor(session.id);
  } catch (err) {
    if (err instanceof UnauthenticatedError) return null;
    throw err;
  }
});

/** Use in pages and actions: sends signed-out visitors to /sign-in. */
export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect("/sign-in");
  return actor;
}

/**
 * For pages of site records (dashboard, sites, reports, bills, labour, materials, suppliers,
 * activity): someone who is only an assistant engineer goes to their own entries instead.
 * The data functions refuse them anyway; this keeps them off pages that would be empty.
 */
export async function requireRecordsReader(): Promise<Actor> {
  const actor = await requireActor();
  if (!(await readsRecords(actor))) redirect("/my");
  return actor;
}

/** The site the user last picked as active (cookie). Unverified: callers check access before using it. */
export async function activeSiteCookie(): Promise<string | undefined> {
  const { cookies } = await import("next/headers");
  const v = (await cookies()).get("active_site")?.value;
  return v && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined;
}
