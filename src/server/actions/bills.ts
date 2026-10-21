"use server";

import { createBill, deleteBill, getBill, listBills, recordPayment } from "../data/bills";
import { addReceipt } from "../data/receipts";
import { ValidationError } from "../errors";
import { run } from "./run";

/**
 * Bill details plus an optional receipt file, posted as FormData from the upload dialog.
 * The bill is created first; a rejected file is reported without losing the bill.
 */
export async function createBillAction(form: FormData) {
  return run(async (actor) => {
    const fields = Object.fromEntries(
      ["siteId", "supplierName", "billNumber", "billDate", "dueDate", "amount", "categoryCode", "description"].map((k) => [
        k,
        (form.get(k) as string | null) ?? undefined,
      ]),
    );
    const bill = await createBill(actor, fields);
    const file = form.get("file");
    if (file instanceof File && file.size > 0) {
      try {
        await addReceipt(
          actor,
          { siteId: bill.siteId, supplierBillId: bill.id, fileName: file.name, contentType: file.type },
          new Uint8Array(await file.arrayBuffer()),
        );
      } catch (err) {
        if (err instanceof ValidationError) {
          throw new ValidationError(`Bill saved, but the file wasn't attached: ${err.message}`, err.fieldErrors);
        }
        throw err;
      }
    }
    return getBill(actor, bill.id);
  });
}

export async function recordPaymentAction(input: unknown) {
  return run((actor) => recordPayment(actor, input));
}

export async function deleteBillAction(id: string) {
  return run((actor) => deleteBill(actor, id));
}

export async function loadBillsAction(filters: unknown) {
  return run((actor) => listBills(actor, filters), { write: false });
}
