import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { PageSkeleton } from "@/components/states";
import { SessionProvider, type SessionData } from "@/lib/session";
import { SITE_STATUS_FROM_DB } from "@/server/data/shared";
import { can, isOrgAdmin } from "@/server/authz";
import { billTotals } from "@/server/data/bills";
import { expenseFilterOptions, pendingSummary } from "@/server/data/expenses";
import { listNotifications } from "@/server/data/notifications";
import { knownNames } from "@/server/data/voice";
import { listSuppliers } from "@/server/data/suppliers";
import { listWorkers } from "@/server/data/labour";
import { getSettings } from "@/server/data/preferences";
import { listOrgMembers } from "@/server/data/sites";
import { accessibleSites } from "@/server/authz";
import { today } from "@/server/data/shared";
import { activeSiteCookie, requireActor } from "@/server/session";
import { ocrAvailable } from "@/server/receipt-ocr";
import { db } from "@/db";
import { constructionSites } from "@/db/schema";
import { inArray } from "drizzle-orm";

/** Loads the signed-in user's session data once per request for every app screen. */
async function Session({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  const roles = await accessibleSites(actor);
  const ids = [...roles.keys()];
  // Assistant engineers read no site's records: no worker or supplier records, bills or totals, only names to type with.
  const readsRecords = isOrgAdmin(actor) || [...roles.values()].some((r) => can(r, "site:read"));
  const [settings, siteRows, members, workers, suppliers, used, bills, names, pending, notices] = await Promise.all([
    getSettings(actor),
    ids.length
      ? db
          .select({ id: constructionSites.id, name: constructionSites.name, location: constructionSites.location, status: constructionSites.status })
          .from(constructionSites)
          .where(inArray(constructionSites.id, ids))
          .orderBy(constructionSites.name)
      : Promise.resolve([]),
    isOrgAdmin(actor) ? listOrgMembers(actor) : Promise.resolve([]),
    readsRecords ? listWorkers(actor) : Promise.resolve([]),
    readsRecords ? listSuppliers(actor) : Promise.resolve([]),
    expenseFilterOptions(actor),
    billTotals(actor),
    readsRecords ? Promise.resolve(null) : knownNames(actor),
    pendingSummary(actor),
    listNotifications(actor, 1),
  ]);

  const cookieSite = await activeSiteCookie();
  const visible = siteRows.map((s) => s.id);
  const firstWritable = siteRows.find((s) => s.status !== "completed" && can(roles.get(s.id), "expense:create"))?.id;
  const value: SessionData = {
    user: { id: actor.userId, name: settings.name, email: actor.email },
    org: { id: actor.orgId, name: actor.orgName, role: actor.orgRole },
    settings,
    today: today(),
    sites: siteRows.map((s) => ({ ...s, status: SITE_STATUS_FROM_DB[s.status], role: roles.get(s.id) ?? "viewer" })),
    members: members.map((m) => ({ id: m.id, name: m.name })),
    workers: [...new Set([...workers.filter((w) => w.active).map((w) => w.name), ...used.workers, ...(names?.workers ?? [])])].sort(),
    suppliers: [...new Set([...suppliers.map((s) => s.name), ...used.suppliers, ...(names?.suppliers ?? [])])].sort(),
    overdueBills: bills.overdueCount,
    readsRecords,
    pendingApprovals: pending.count,
    unreadNotices: notices.unread,
    features: { receiptOcr: ocrAvailable() },
    activeSiteId: cookieSite && visible.includes(cookieSite) ? cookieSite : (firstWritable ?? visible[0] ?? null),
  };
  return (
    <SessionProvider value={value}>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-[1320px] px-4 pt-8 sm:px-6 lg:px-10">
          <PageSkeleton />
        </div>
      }
    >
      <Session>{children}</Session>
    </Suspense>
  );
}
