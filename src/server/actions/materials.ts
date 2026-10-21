"use server";

import { createMaterial, deleteUsage, getPurchase, recordPurchase, recordUsage, updateMaterial, voidPurchase } from "../data/materials";
import { addReceipt } from "../data/receipts";
import { ValidationError } from "../errors";
import { run } from "./run";

export async function createMaterialAction(input: unknown) {
  return run((actor) => createMaterial(actor, input));
}

export async function updateMaterialAction(input: unknown) {
  return run((actor) => updateMaterial(actor, input));
}

/**
 * Purchase details as JSON in `data`, plus an optional receipt `file`. The receipt is
 * stored on the expense or bill that carries the purchase's money. A rejected file
 * is reported without losing the purchase.
 */
export async function recordPurchaseAction(form: FormData) {
  return run(async (actor) => {
    let data: unknown;
    try {
      data = JSON.parse(String(form.get("data") ?? ""));
    } catch {
      throw new ValidationError("The purchase couldn't be read. Reload and try again.");
    }
    const purchase = await recordPurchase(actor, data);
    const file = form.get("file");
    if (file instanceof File && file.size > 0) {
      try {
        await addReceipt(
          actor,
          {
            siteId: purchase.siteId,
            expenseId: purchase.expenseId ?? undefined,
            supplierBillId: purchase.bill?.id,
            fileName: file.name,
            contentType: file.type,
          },
          new Uint8Array(await file.arrayBuffer()),
        );
      } catch (err) {
        if (err instanceof ValidationError) {
          throw new ValidationError(`Purchase saved, but the receipt wasn't attached: ${err.message}`, err.fieldErrors);
        }
        throw err;
      }
    }
    return getPurchase(actor, purchase.id);
  });
}

export async function voidPurchaseAction(input: unknown) {
  return run((actor) => voidPurchase(actor, input));
}

export async function recordUsageAction(input: unknown) {
  return run((actor) => recordUsage(actor, input));
}

export async function deleteUsageAction(id: string) {
  return run((actor) => deleteUsage(actor, id));
}
