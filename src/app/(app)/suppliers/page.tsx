import type { Metadata } from "next";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/states";
import { SuppliersView } from "@/components/views/suppliers";
import { supplierDirectory } from "@/server/data/suppliers";
import { requireRecordsReader } from "@/server/session";

export const metadata: Metadata = { title: "Suppliers" };

async function Suppliers() {
  const actor = await requireRecordsReader();
  return <SuppliersView suppliers={await supplierDirectory(actor)} />;
}

export default function SuppliersPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Suppliers />
    </Suspense>
  );
}
