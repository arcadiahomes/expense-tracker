"use server";

import { invoicePayments, listReceipts, recordClientPayment, refundClientPayment } from "../data/client-payments";
import { run } from "./run";

export async function recordClientPaymentAction(input: unknown) {
  return run((actor) => recordClientPayment(actor, input));
}

export async function refundClientPaymentAction(input: unknown) {
  return run((actor) => refundClientPayment(actor, input));
}

export async function loadReceiptsAction(filters: unknown) {
  return run((actor) => listReceipts(actor, filters), { write: false });
}

export async function loadInvoicePaymentsAction(invoiceId: string) {
  return run((actor) => invoicePayments(actor, invoiceId), { write: false });
}
