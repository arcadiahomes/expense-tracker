import type { Metadata } from "next";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/states";
import { LabourNoSites, LabourView } from "@/components/views/labour";
import { labourTotals, listWorkers } from "@/server/data/labour";
import { pickSite } from "@/server/data/sites";
import { activeSiteCookie, requireRecordsReader } from "@/server/session";

export const metadata: Metadata = { title: "Labour" };

async function Labour({ searchParams }: PageProps<"/labour">) {
  const query = await searchParams;
  const actor = await requireRecordsReader();
  // ?site wins (links, the page's picker); otherwise the active site from the top bar.
  const siteId = await pickSite(actor, query.site ?? (await activeSiteCookie()));
  if (!siteId) {
    return <LabourNoSites />;
  }
  const [totals, workers] = await Promise.all([labourTotals(actor, siteId), listWorkers(actor)]);
  return (
    <LabourView
      siteId={siteId}
      totals={totals}
      workers={workers.map((w) => ({ id: w.id, name: w.name, trade: w.trade, phone: w.phone, dailyWage: w.dailyWage == null ? null : String(w.dailyWage), active: w.active }))}
    />
  );
}

export default function LabourPage(props: PageProps<"/labour">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Labour {...props} />
    </Suspense>
  );
}
