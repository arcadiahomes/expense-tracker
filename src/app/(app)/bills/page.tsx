import type { Metadata } from "next";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/states";
import { BillsView } from "@/components/views/bills";
import { billTotals, listBills } from "@/server/data/bills";
import { requireRecordsReader } from "@/server/session";

export const metadata: Metadata = { title: "Bills" };

const STATUSES = ["all", "pending", "partial", "overdue", "paid"] as const;
type Status = (typeof STATUSES)[number];

async function Bills({ searchParams }: PageProps<"/bills">) {
  const query = await searchParams;
  const actor = await requireRecordsReader();
  const status = (STATUSES.includes(query.status as Status) ? query.status : "all") as Status;
  const q = typeof query.q === "string" ? query.q.slice(0, 100) : "";
  const [page, totals] = await Promise.all([
    listBills(actor, { status, q: q || undefined }),
    billTotals(actor),
  ]);
  return <BillsView page={page} totals={totals} filter={status} query={q} />;
}

export default function BillsPage(props: PageProps<"/bills">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Bills {...props} />
    </Suspense>
  );
}
