"use server";

import { parseVoice, recordVoiceConsent, reviewVoice, saveVoice, withdrawVoiceConsent } from "../data/voice";
import { run } from "./run";

/** Read-only: transcript → drafts. */
export async function parseVoiceAction(input: unknown) {
  return run((actor) => parseVoice(actor, input), { write: false });
}

/** Read-only: open questions, likely duplicates and the server total for the reviewed drafts. */
export async function reviewVoiceAction(input: unknown) {
  return run((actor) => reviewVoice(actor, input), { write: false });
}

export async function saveVoiceAction(input: unknown) {
  return run((actor) => saveVoice(actor, input));
}

export async function recordVoiceConsentAction() {
  return run((actor) => recordVoiceConsent(actor), { write: false });
}

export async function withdrawVoiceConsentAction() {
  return run((actor) => withdrawVoiceConsent(actor), { write: false });
}
