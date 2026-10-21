"use server";

import { createSupplier, updateSupplier } from "../data/suppliers";
import { run } from "./run";

export async function createSupplierAction(input: unknown) {
  return run((actor) => createSupplier(actor, input));
}

export async function updateSupplierAction(id: string, input: unknown) {
  return run((actor) => updateSupplier(actor, id, input));
}
