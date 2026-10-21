import type { Metadata } from "next";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/states";
import { ReportsView, type Preset } from "@/components/views/reports";
import { monthStart, shiftDate, weekStart } from "@/lib/dates";
import { CATEGORIES } from "@/lib/types";
import { getReport, type ReportData } from "@/server/data/reports";
import { today } from "@/server/data/shared";
import { NotFoundError, ValidationError } from "@/server/errors";
import { requireRecordsReader } from "@/server/session";
import { reportFilters } from "@/server/validation";

export const metadata: Metadata = { title: "Reports" };

const PRESETS: Preset[] = ["week", "month", "last-month", "30", "90", "custom"];
const SORTS = ["date_desc", "date_asc", "amount_desc", "amount_asc"] as const;

function presetRange(p: Preset, t: string): [string, string] {
  switch (p) {
    case "week":
      return [weekStart(t), t];
    case "month":
      return [monthStart(t), t];
    case "last-month": {
      const end = shiftDate(monthStart(t), -1);
      return [monthStart(end), end];
    }
    case "30":
      return [shiftDate(t, -29), t];
    default:
      return [shiftDate(t, -89), t];
  }
}

const str = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : undefined);
const isDate = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

async function Reports({ searchParams }: PageProps<"/reports">) {
  const q = await searchParams;
  const actor = await requireRecordsReader();
  const t = today();
  const preset = (PRESETS.includes(q.preset as Preset) ? q.preset : "month") as Preset;
  const [from, to] =
    preset === "custom" && isDate(str(q.from)) && isDate(str(q.to)) ? [str(q.from)!, str(q.to)!] : presetRange(preset, t);
  const category = str(q.category);
  const sort = str(q.sort);
  const filters = {
    from,
    to,
    siteId: str(q.site),
    categoryCode: CATEGORIES.includes(category as never) ? category : undefined,
    workerName: str(q.worker),
    supplierName: str(q.supplier),
    paymentMethod: ["cash", "upi", "bank", "cheque", "credit"].includes(str(q.method) ?? "") ? str(q.method) : undefined,
    sort: SORTS.includes(sort as never) ? sort : undefined,
    limit: 50,
  };

  let data: ReportData & { error?: string };
  try {
    data = await getReport(actor, filters);
  } catch (err) {
    if (!(err instanceof ValidationError) && !(err instanceof NotFoundError)) throw err;
    // Bad range or a site the user can't see: render an empty report with the reason.
    const parsed = reportFilters.parse({ ...filters, from: t, to: t, siteId: undefined });
    data = {
      filters: { ...parsed, from, to },
      summary: { total: 0, count: 0, avgPerDay: 0, topCategory: null },
      byCategory: CATEGORIES.map((c) => ({ category: c, amount: 0 })),
      bySite: [],
      page: { items: [], nextCursor: null },
      error: err instanceof NotFoundError ? "That site isn't available to you." : err.message,
    };
  }
  return <ReportsView data={data} preset={preset} />;
}

export default function ReportsPage(props: PageProps<"/reports">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Reports {...props} />
    </Suspense>
  );
}
