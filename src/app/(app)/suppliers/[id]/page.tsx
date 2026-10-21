import type { Metadata } from "next";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/states";
import { SupplierDetailView, SupplierNotFound } from "@/components/views/suppliers";
import { supplierDetail } from "@/server/data/suppliers";
import { NotFoundError } from "@/server/errors";
import { requireRecordsReader } from "@/server/session";

export const metadata: Metadata = { title: "Supplier" };

async function Supplier({ params }: PageProps<"/suppliers/[id]">) {
  const { id } = await params;
  const actor = await requireRecordsReader();
  const data = await supplierDetail(actor, id).catch((err) => {
    if (err instanceof NotFoundError) return null;
    throw err;
  });
  if (!data) return <SupplierNotFound />;
  return <SupplierDetailView data={data} />;
}

export default function SupplierPage(props: PageProps<"/suppliers/[id]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Supplier {...props} />
    </Suspense>
  );
}
