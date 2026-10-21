"use server";

import {
  acknowledgeDuplicate,
  addReceipt,
  confirmReceiptDetails,
  extractReceiptDetails,
  getReceipt,
  listReceipts,
  removeReceipt,
  replaceReceipt,
  scanUpload,
} from "../data/receipts";
import { ValidationError } from "../errors";
import { run } from "./run";

const fileFrom = (form: FormData) => {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) throw new ValidationError("Choose a file or take a photo.", { file: "Choose a file or take a photo." });
  return file;
};
const source = (form: FormData) => (form.get("captureSource") === "camera" ? ("camera" as const) : ("file" as const));

/** FormData: file, siteId, expenseId or supplierBillId, captureSource. */
export async function uploadReceiptAction(form: FormData) {
  return run(async (actor) => {
    const file = fileFrom(form);
    const row = await addReceipt(
      actor,
      {
        siteId: String(form.get("siteId") ?? ""),
        expenseId: (form.get("expenseId") as string) || undefined,
        supplierBillId: (form.get("supplierBillId") as string) || undefined,
        fileName: file.name,
        contentType: file.type,
        captureSource: source(form),
      },
      new Uint8Array(await file.arrayBuffer()),
    );
    return getReceipt(actor, row.id);
  });
}

/** FormData: id, file, captureSource. */
export async function replaceReceiptAction(form: FormData) {
  return run(async (actor) => {
    const file = fileFrom(form);
    const row = await replaceReceipt(actor, String(form.get("id") ?? ""), { fileName: file.name, contentType: file.type, captureSource: source(form) }, new Uint8Array(await file.arrayBuffer()));
    return getReceipt(actor, row.id);
  });
}

export async function removeReceiptAction(input: unknown) {
  return run((actor) => removeReceipt(actor, input));
}

export async function acknowledgeDuplicateAction(id: string) {
  return run((actor) => acknowledgeDuplicate(actor, id));
}

export async function extractReceiptAction(id: string) {
  return run((actor) => extractReceiptDetails(actor, id));
}

export async function confirmReceiptAction(input: unknown) {
  return run((actor) => confirmReceiptDetails(actor, input));
}

/** Read-only: files on an expense or bill, optionally with removed/replaced ones. */
export async function loadReceiptsAction(parent: { expenseId?: string; supplierBillId?: string }, history = false) {
  return run((actor) => listReceipts(actor, parent, { history }), { write: false });
}

/** Read-only: reads a file that hasn't been saved yet, to pre-fill a form. FormData: file, siteId. */
export async function scanUploadAction(form: FormData) {
  return run(async (actor) => {
    const file = fileFrom(form);
    return scanUpload(actor, String(form.get("siteId") ?? ""), file.type, new Uint8Array(await file.arrayBuffer()));
  }, { write: false });
}
