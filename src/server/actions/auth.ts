"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/lib/auth";
import type { ActionResult } from "@/lib/types";
import { loadActor, readsRecords } from "../authz";
import { setPasswordWithLink } from "../data/accounts";
import { clientIp, enforce, LIMITS } from "../rate-limit";
import { fieldErrors, setPasswordInput } from "../validation";
import { actionError } from "./run";

const signInInput = z.object({
  email: z.email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
  next: z.string().optional(),
});

/** Only same-site paths, so `?next=` can't send people to another origin. */
function safeNext(next: unknown) {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  try {
    const url = new URL(next, "http://app.local");
    return url.origin === "http://app.local" ? `${url.pathname}${url.search}` : "/";
  } catch {
    return "/";
  }
}

function authMessage(err: unknown, fallback: string) {
  const code = (err as { body?: { code?: string } })?.body?.code;
  if (code === "INVALID_EMAIL_OR_PASSWORD") return "That email and password don't match.";
  // Thrown by the session hook in lib/auth.ts, so only after the right password.
  if (code === "ACCOUNT_INACTIVE") return "This account is deactivated. Ask the admin to reactivate it.";
  return fallback;
}

/**
 * Where to go after signing in: the page they were sent away from, else the admin's
 * dashboard, or "My entries" for an assistant engineer (who reads no site's records).
 */
async function homeFor(userId: string, next?: unknown) {
  const back = safeNext(next);
  if (back !== "/") return back;
  try {
    return (await readsRecords(await loadActor(userId))) ? "/" : "/my";
  } catch {
    return "/";
  }
}

export async function signInAction(raw: unknown): Promise<ActionResult> {
  const parsed = signInInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
  const { email, password, next } = parsed.data;
  try {
    // Better Auth's own limiter only covers /api/auth/*; calls from here skip it.
    await enforce(`sign-in:ip:${await clientIp()}`, LIMITS.signInIp);
    await enforce(`sign-in:email:${email.toLowerCase()}`, LIMITS.signInEmail);
  } catch (err) {
    return actionError(err);
  }
  let userId: string;
  try {
    const res = await auth.api.signInEmail({ body: { email, password }, headers: await headers() });
    userId = res.user.id;
  } catch (err) {
    return { ok: false, error: authMessage(err, "Couldn't sign you in. Try again.") };
  }
  redirect(await homeFor(userId, next));
}

/** Sets the password from a one-time link the admin issued, then signs the person in. */
export async function setPasswordAction(raw: unknown): Promise<ActionResult> {
  const parsed = setPasswordInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
  let email: string;
  try {
    await enforce(`password-link:ip:${await clientIp()}`, LIMITS.passwordLinkIp);
    ({ email } = await setPasswordWithLink(parsed.data));
  } catch (err) {
    return actionError(err);
  }
  let userId: string;
  try {
    const res = await auth.api.signInEmail({ body: { email, password: parsed.data.password }, headers: await headers() });
    userId = res.user.id;
  } catch {
    // The password is saved; let them sign in by hand.
    redirect("/sign-in?password=set");
  }
  redirect(await homeFor(userId));
}

export async function signOutAction(next?: unknown) {
  await auth.api.signOut({ headers: await headers() });
  const back = safeNext(next);
  redirect(back === "/" ? "/sign-in" : `/sign-in?next=${encodeURIComponent(back)}`);
}
