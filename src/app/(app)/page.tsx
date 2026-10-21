import { Suspense } from "react";
import { PageSkeleton } from "@/components/states";
import { DashboardView } from "@/components/views/dashboard";
import { getAnalytics, type AnalyticsData } from "@/server/data/analytics";
import { getDashboard } from "@/server/data/dashboard";
import { NotFoundError, ValidationError } from "@/server/errors";
import { requireRecordsReader } from "@/server/session";

const str = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : undefined);

async function Dashboard({ searchParams }: PageProps<"/">) {
  const q = await searchParams;
  const actor = await requireRecordsReader();
  const filters = { from: str(q.from), to: str(q.to), siteId: str(q.site), q: str(q.q)?.slice(0, 100) };
  let analytics: AnalyticsData;
  let error: string | undefined;
  try {
    analytics = await getAnalytics(actor, filters);
  } catch (err) {
    const known = err instanceof ValidationError || err instanceof NotFoundError || (err as { name?: string })?.name === "ZodError";
    if (!known) throw err;
    // A bad range or a site the user can't see: show the reason and the default view.
    error = err instanceof NotFoundError ? "That site isn't available to you." : err instanceof ValidationError ? err.message : "Those filters aren't valid.";
    analytics = await getAnalytics(actor, {});
  }
  return <DashboardView data={await getDashboard(actor)} analytics={analytics} filterError={error} />;
}

export default function DashboardPage(props: PageProps<"/">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Dashboard {...props} />
    </Suspense>
  );
}
