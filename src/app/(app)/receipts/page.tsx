import type { Metadata } from "next";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/states";
import { ReceiptsNoAccess, ReceiptsView } from "@/components/views/client-receipts";
import { listReceipts, payableInvoices, projectCollections } from "@/server/data/client-payments";
import { invoiceSites } from "@/server/data/invoices";
import { requireRecordsReader } from "@/server/session";
import { isoDate, RECEIPT_STAGES } from "@/server/validation";

export const metadata: Metadata = { title: "Receipts" };

type Stage = (typeof RECEIPT_STAGES)[number];

async function Receipts({ searchParams }: PageProps<"/receipts">) {
  const query = await searchParams;
  const actor = await requireRecordsReader();
  const sites = await invoiceSites(actor);
  if (!sites.length) return <ReceiptsNoAccess />;

  const str = (v: unknown, max = 100) => (typeof v === "string" ? v.slice(0, max) : "");
  const filters = {
    siteId: sites.find((s) => s.id === query.site)?.id ?? "",
    stage: (RECEIPT_STAGES.includes(query.stage as Stage) ? query.stage : "all") as Stage,
    from: isoDate.safeParse(query.from).success ? str(query.from) : "",
    to: isoDate.safeParse(query.to).success ? str(query.to) : "",
    q: str(query.q),
  };
  if (filters.from && filters.to && filters.from > filters.to) filters.to = "";
  const tab = query.tab === "projects" ? "projects" : "receipts";
  const [page, collections, payable] = await Promise.all([
    listReceipts(actor, {
      siteId: filters.siteId || undefined,
      stage: filters.stage,
      from: filters.from || undefined,
      to: filters.to || undefined,
      q: filters.q || undefined,
    }),
    projectCollections(actor),
    payableInvoices(actor),
  ]);
  return (
    <ReceiptsView
      tab={tab}
      sites={sites.map((s) => ({ id: s.id, name: s.name }))}
      page={page}
      filters={filters}
      collections={collections}
      payable={payable}
    />
  );
}

export default function ReceiptsPage(props: PageProps<"/receipts">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Receipts {...props} />
    </Suspense>
  );
}
