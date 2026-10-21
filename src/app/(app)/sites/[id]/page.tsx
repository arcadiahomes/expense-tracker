import { Suspense } from "react";
import { PageSkeleton } from "@/components/states";
import { SiteDetailView, SiteNotFound } from "@/components/views/site-detail";
import { can } from "@/lib/permissions";
import { CATEGORIES, type Category } from "@/lib/types";
import { getAnalytics } from "@/server/data/analytics";
import { getSiteDetail } from "@/server/data/dashboard";
import { listSiteMembers } from "@/server/data/sites";
import { NotFoundError } from "@/server/errors";
import { requireRecordsReader } from "@/server/session";
import { uuid } from "@/server/validation";

async function SiteDetail({ params, searchParams }: PageProps<"/sites/[id]">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const actor = await requireRecordsReader();
  // Malformed ids and sites the user can't see look the same: not found.
  if (!uuid.safeParse(id).success) return <SiteNotFound />;
  const raw = typeof query.category === "string" ? query.category : undefined;
  const category = CATEGORIES.includes(raw as Category) ? (raw as Category) : undefined;
  const data = await getSiteDetail(actor, id, category).catch((err) => {
    if (err instanceof NotFoundError) return null;
    throw err;
  });
  if (!data) return <SiteNotFound />;
  const [members, analytics] = await Promise.all([
    can(data.summary.site.role, "site:manage") ? listSiteMembers(actor, id) : Promise.resolve(null),
    getAnalytics(actor, { siteId: id }),
  ]);
  return <SiteDetailView data={data} members={members} budgetLines={analytics.budgetLines} />;
}

export default function SiteDetailPage(props: PageProps<"/sites/[id]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <SiteDetail {...props} />
    </Suspense>
  );
}
