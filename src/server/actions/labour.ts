"use server";

import { createWorker, recordAttendanceBatch, recordLabourPayment, updateWorker, workerLedger } from "../data/labour";
import { run } from "./run";

export async function createWorkerAction(input: unknown) {
  return run((actor) => createWorker(actor, input));
}

export async function updateWorkerAction(input: unknown) {
  return run((actor) => updateWorker(actor, input));
}

export async function recordAttendanceAction(input: unknown) {
  return run((actor) => recordAttendanceBatch(actor, input));
}

export async function recordLabourPaymentAction(input: unknown) {
  return run((actor) => recordLabourPayment(actor, input));
}

/** Read-only: one worker's statement on a site. */
export async function loadWorkerLedgerAction(siteId: string, workerId: string) {
  return run((actor) => workerLedger(actor, siteId, workerId), { write: false });
}
