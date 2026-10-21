import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import type { DateFormat, Language, NumberStyle, Settings } from "@/lib/types";
import type { Actor } from "../authz";
import { NotFoundError } from "../errors";
import { preferencesInput } from "../validation";

export async function getSettings(actor: Actor): Promise<Settings> {
  const [u] = await db.select().from(users).where(eq(users.id, actor.userId)).limit(1);
  if (!u) throw new NotFoundError("User");
  return {
    name: u.name,
    phone: u.phone ?? "",
    email: u.email,
    role: u.jobTitle ?? "",
    company: actor.orgName,
    language: u.language as Language,
    dateFormat: u.dateFormat as DateFormat,
    numberStyle: u.numberStyle as NumberStyle,
  };
}

/** Users can only ever change their own profile and display preferences. */
export async function updatePreferences(actor: Actor, raw: unknown): Promise<Settings> {
  const input = preferencesInput.parse(raw);
  await db
    .update(users)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.phone !== undefined && { phone: input.phone || null }),
      ...(input.jobTitle !== undefined && { jobTitle: input.jobTitle }),
      ...(input.language && { language: input.language }),
      ...(input.dateFormat && { dateFormat: input.dateFormat }),
      ...(input.numberStyle && { numberStyle: input.numberStyle }),
    })
    .where(eq(users.id, actor.userId));
  return getSettings(actor);
}
