import type { Metadata } from "next";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/states";
import { LabourNoSites, LabourView } from "@/components/views/labour";
import { labourBalances, listAttendance, listWorkers } from "@/server/data/labour";
import { today } from "@/server/data/shared";
import { pickSite } from "@/server/data/sites";
import { activeSiteCookie, requireRecordsReader } from "@/server/session";
import { isoDate } from "@/server/validation";

export const metadata: Metadata = { title: "Labour" };

async function Labour({ searchParams }: PageProps<"/labour">) {
  const query = await searchParams;
  const actor = await requireRecordsReader();
  // ?site wins (links, the page's picker); otherwise the active site from the top bar.
  const siteId = await pickSite(actor, query.site ?? (await activeSiteCookie()));
  if (!siteId) {
    return <LabourNoSites />;
  }
  const t = today();
  const parsed = isoDate.safeParse(query.date);
  const date = parsed.success && parsed.data <= t ? parsed.data : t;
  const [balances, day, workers] = await Promise.all([labourBalances(actor, siteId), listAttendance(actor, siteId, date, date), listWorkers(actor)]);
  return (
    <LabourView
      siteId={siteId}
      date={date}
      balances={balances}
      day={day.map((d) => ({ workerId: d.workerId, status: d.status, workType: d.workType, dayRate: d.dayRate, wageAmount: d.wageAmount }))}
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
