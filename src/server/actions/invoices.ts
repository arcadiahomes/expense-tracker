"use server";

import { cancelInvoice, createClientInvoice, listClientInvoices, markInvoicePaid } from "../data/invoices";
import { run } from "./run";

export async function createClientInvoiceAction(input: unknown) {
  return run((actor) => createClientInvoice(actor, input));
}

export async function markInvoicePaidAction(input: unknown) {
  return run((actor) => markInvoicePaid(actor, input));
}

export async function cancelInvoiceAction(input: unknown) {
  return run((actor) => cancelInvoice(actor, input));
}

export async function loadInvoicesAction(filters: unknown) {
  return run((actor) => listClientInvoices(actor, filters), { write: false });
}
