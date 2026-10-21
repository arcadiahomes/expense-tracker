import type { Metadata } from "next";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/states";
import { MaterialsNoSites, MaterialsView } from "@/components/views/materials";
import { listMaterials, listPurchases, listUsage, siteStock } from "@/server/data/materials";
import { pickSite } from "@/server/data/sites";
import { activeSiteCookie, requireRecordsReader } from "@/server/session";

export const metadata: Metadata = { title: "Materials" };

async function Materials({ searchParams }: PageProps<"/materials">) {
  const query = await searchParams;
  const actor = await requireRecordsReader();
  // ?site wins (links, the page's picker); otherwise the active site from the top bar.
  const siteId = await pickSite(actor, query.site ?? (await activeSiteCookie()));
  if (!siteId) {
    return <MaterialsNoSites />;
  }
  const [catalog, stock, purchases, usage] = await Promise.all([
    listMaterials(actor),
    siteStock(actor, siteId),
    listPurchases(actor, siteId),
    listUsage(actor, siteId),
  ]);
  return <MaterialsView siteId={siteId} catalog={catalog} stock={stock} purchases={purchases} usage={usage} />;
}

export default function MaterialsPage(props: PageProps<"/materials">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Materials {...props} />
    </Suspense>
  );
}
