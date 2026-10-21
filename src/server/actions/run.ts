import "server-only";
import { refresh } from "next/cache";
import { after } from "next/server";
import { ZodError } from "zod";
import type { ActionResult } from "@/lib/types";
import type { Actor } from "../authz";
import { ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from "../errors";
import { reportError } from "../monitoring";
import { requireActor } from "../session";
import { fieldErrors } from "../validation";

/**
 * Runs a data-layer call for a server action: resolves the actor (redirecting
 * signed-out users), maps domain errors to form-friendly results, and refreshes
 * the client router after successful writes so server-rendered totals update.
 */
export async function run<T>(fn: (actor: Actor) => Promise<T>, opts: { write?: boolean } = { write: true }): Promise<ActionResult<T>> {
  const actor = await requireActor();
  try {
    const data = await fn(actor);
    if (opts.write !== false) refresh();
    return { ok: true, data };
  } catch (err) {
    return actionError(err);
  }
}

/** Domain error → form-friendly result. Anything unexpected is logged, never echoed to the client. */
export function actionError(err: unknown): { ok: false; error: string; fieldErrors?: Record<string, string> } {
  if (err instanceof ZodError) {
    const errors = fieldErrors(err);
    return { ok: false, error: Object.values(errors)[0] ?? "Check the highlighted fields.", fieldErrors: errors };
  }
  if (err instanceof ValidationError) return { ok: false, error: err.message, fieldErrors: err.fieldErrors };
  if (err instanceof NotFoundError || err instanceof ForbiddenError || err instanceof UnauthenticatedError) {
    return { ok: false, error: err.message };
  }
  // Malformed ids reaching Postgres (invalid_text_representation) are just records that don't exist.
  const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
  if (code === "22P02") return { ok: false, error: new NotFoundError().message };
  // Sent after the response so the user isn't kept waiting on the monitoring service.
  after(() => reportError(err, { source: "action" }));
  return { ok: false, error: "Something went wrong saving that. Try again in a moment." };
}
