import type { Metadata } from "next";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/states";
import { SitesView } from "@/components/views/sites";
import { listSites } from "@/server/data/sites";
import { requireRecordsReader } from "@/server/session";

export const metadata: Metadata = { title: "Sites" };

async function Sites() {
  const actor = await requireRecordsReader();
  return <SitesView summaries={await listSites(actor)} />;
}

export default function SitesPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Sites />
    </Suspense>
  );
}
