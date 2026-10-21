"use server";

import { updatePreferences } from "../data/preferences";
import { run } from "./run";

export async function updatePreferencesAction(input: unknown) {
  return run((actor) => updatePreferences(actor, input));
}
