"use server";

import { createWorker, recordLabourPayment, updateWorker, workerPayments } from "../data/labour";
import { run } from "./run";

export async function createWorkerAction(input: unknown) {
  return run((actor) => createWorker(actor, input));
}

export async function updateWorkerAction(input: unknown) {
  return run((actor) => updateWorker(actor, input));
}

export async function recordLabourPaymentAction(input: unknown) {
  return run((actor) => recordLabourPayment(actor, input));
}

/** Read-only: one worker's payments on a site. */
export async function loadWorkerPaymentsAction(siteId: string, workerId: string) {
  return run((actor) => workerPayments(actor, siteId, workerId), { write: false });
}
