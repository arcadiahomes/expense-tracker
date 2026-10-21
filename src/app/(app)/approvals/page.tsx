import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/states";
import { ApprovalsView } from "@/components/views/approvals";
import { scopeSiteIds } from "@/server/authz";
import { listReviewQueue, pendingSummary } from "@/server/data/expenses";
import { requireRecordsReader } from "@/server/session";

export const metadata: Metadata = { title: "Approvals" };

async function Approvals({ searchParams }: PageProps<"/approvals">) {
  const q = await searchParams;
  const actor = await requireRecordsReader();
  // Only site owners (and org owners/admins) review; everyone else goes home.
  if (!(await scopeSiteIds(actor, null, undefined, "expense:approve")).length) redirect("/");
  const status = q.status === "rejected" ? "rejected" : "pending_approval";
  const [page, summary] = await Promise.all([listReviewQueue(actor, { status }), pendingSummary(actor)]);
  return <ApprovalsView page={page} status={status} summary={summary} />;
}

export default function ApprovalsPage(props: PageProps<"/approvals">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Approvals {...props} />
    </Suspense>
  );
}
