import type { Metadata } from "next";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/states";
import { ActivityUnavailable, ActivityView } from "@/components/views/activity";
import { accessibleSites, can } from "@/server/authz";
import { listAudit } from "@/server/data/audit";
import { requireRecordsReader } from "@/server/session";
import { uuid } from "@/server/validation";

export const metadata: Metadata = { title: "Activity" };

async function Activity({ searchParams }: PageProps<"/activity">) {
  const query = await searchParams;
  const actor = await requireRecordsReader();
  const roles = await accessibleSites(actor);
  const siteId = typeof query.site === "string" && uuid.safeParse(query.site).success && can(roles.get(query.site), "audit:read") ? query.site : undefined;
  const page = await listAudit(actor, { siteId });
  if (!page.items.length && ![...roles.values()].some((r) => can(r, "audit:read"))) {
    return <ActivityUnavailable />;
  }
  return <ActivityView key={siteId ?? "all"} siteId={siteId ?? null} page={page} />;
}

export default function ActivityPage(props: PageProps<"/activity">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Activity {...props} />
    </Suspense>
  );
}
