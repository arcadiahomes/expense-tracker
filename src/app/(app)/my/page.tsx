import type { Metadata } from "next";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/states";
import { MyEntriesView } from "@/components/views/my-entries";
import { listMyExpenses, myStatusCounts } from "@/server/data/expenses";
import { listNotifications } from "@/server/data/notifications";
import { requireActor } from "@/server/session";
import { EXPENSE_STATUSES } from "@/server/validation";

export const metadata: Metadata = { title: "My entries" };

async function MyEntries({ searchParams }: PageProps<"/my">) {
  const q = await searchParams;
  const actor = await requireActor();
  const status = EXPENSE_STATUSES.find((s) => s === q.status);
  const [page, counts, notices] = await Promise.all([listMyExpenses(actor, { status }), myStatusCounts(actor), listNotifications(actor, 10)]);
  return <MyEntriesView page={page} status={status ?? null} counts={counts} notices={notices.items} />;
}

export default function MyEntriesPage(props: PageProps<"/my">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <MyEntries {...props} />
    </Suspense>
  );
}
