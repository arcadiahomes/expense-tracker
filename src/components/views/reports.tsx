"use client";

import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Download, FileSpreadsheet, FileText, FilterX, SearchX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { EmptyState } from "@/components/states";
import { SelectField } from "@/components/select-field";
import { CategoryBars } from "@/components/charts";
import { CategoryChip } from "@/components/category-chip";
import { ExpenseList } from "@/components/expense-list";
import { CATEGORY_META } from "@/lib/categories";
import { can } from "@/lib/permissions";
import { useFormat, useSession } from "@/lib/session";
import { loadExpensesAction } from "@/server/actions/expenses";
import type { ReportData } from "@/server/data/reports";
import { CATEGORIES, type Category, type Expense } from "@/lib/types";
import { cn } from "@/lib/utils";

export type Preset = "week" | "month" | "last-month" | "30" | "90" | "custom";
type Sort = "date_desc" | "date_asc" | "amount_desc" | "amount_asc";

const PRESETS: { value: Preset; label: string }[] = [
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "last-month", label: "Last month" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "custom", label: "Custom range" },
];

const PAYMENT_LABEL = { cash: "Cash", upi: "UPI", bank: "Bank", cheque: "Cheque", credit: "Credit" } as const;

/** URL query for the current filters; shared by navigation and the CSV export link. */
function toParams(f: Record<string, string | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v && v !== "all") p.set(k, v);
  return p;
}

export function ReportsView({ data, preset }: { data: ReportData & { error?: string }; preset: Preset }) {
  const { sites, workers, suppliers, today } = useSession();
  const fmt = useFormat();
  const router = useRouter();
  const pathname = usePathname();
  const [navigating, startNav] = useTransition();
  const [loadingMore, startMore] = useTransition();
  const [exporting, setExporting] = useState(false);

  const f = data.filters;
  const { from, to } = f;
  const siteId = f.siteId ?? "all";
  const category = (f.categoryCode ?? "all") as "all" | Category;
  const worker = f.workerName ?? "all";
  const supplier = f.supplierName ?? "all";
  const method = (f.paymentMethod ?? "all") as "all" | keyof typeof PAYMENT_LABEL;
  const sort = f.sort as Sort;
  const [custom, setCustom] = useState<[string, string]>([from, to]);

  const current = {
    preset,
    from: preset === "custom" ? from : undefined,
    to: preset === "custom" ? to : undefined,
    site: siteId,
    category,
    worker,
    supplier,
    method,
    sort: sort === "date_desc" ? undefined : sort,
  };
  function go(patch: Partial<typeof current>) {
    const params = toParams({ ...current, ...patch, preset: (patch.preset ?? preset) === "month" ? undefined : (patch.preset ?? preset) });
    startNav(() => router.replace(params.size ? `${pathname}?${params}` : pathname, { scroll: false }));
  }

  // Extra table pages from "Show more"; reset when the server sends a new report.
  const [paged, setPaged] = useState({ base: data, extra: [] as Expense[], cursor: data.page.nextCursor });
  if (paged.base !== data) setPaged({ base: data, extra: [], cursor: data.page.nextCursor });
  const rows = paged.base === data ? [...data.page.items, ...paged.extra] : data.page.items;
  const cursor = paged.base === data ? paged.cursor : data.page.nextCursor;
  function loadMore() {
    if (!cursor) return;
    startMore(async () => {
      const res = await loadExpensesAction({ ...f, cursor, limit: 50 });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setPaged((p) => ({ ...p, extra: [...p.extra, ...res.data.items], cursor: res.data.nextCursor }));
    });
  }

  const siteName = useMemo(() => Object.fromEntries(sites.map((s) => [s.id, s.name])), [sites]);
  const { summary, byCategory: cats, bySite } = data;

  const activeFilters = [siteId, category, worker, supplier, method].filter((v) => v !== "all").length;
  const clear = () => go({ site: "all", category: "all", worker: "all", supplier: "all", method: "all" });
  const toggleSort = (key: "date" | "amount") => {
    const next: Sort = sort.startsWith(key) ? (sort.endsWith("desc") ? `${key}_asc` : `${key}_desc`) : `${key}_desc`;
    go({ sort: next === "date_desc" ? undefined : next });
  };
  const exportFilters = { site: siteId, category, worker, supplier, method };
  const csvHref = `/api/reports/export?${toParams({ from, to, ...exportFilters, sort })}`;
  // Owners and accountants export; the server enforces this per site and skips sites you can't export.
  const exportable = sites.filter((s) => can(s.role, "report:export"));
  const canExport = siteId === "all" ? exportable.length > 0 : exportable.some((s) => s.id === siteId);
  const partialExport = siteId === "all" && exportable.length < sites.length;

  return (
    <>
      <PageHeader
        title="Reports"
        description={`${fmt.date(from)} to ${fmt.date(to)}${siteId !== "all" ? `, ${siteName[siteId] ?? "site"}` : ", all sites"}`}
        actions={
          canExport && (
          <Button className="h-11 px-4" onClick={() => setExporting(true)}>
            <Download aria-hidden /> Download report
          </Button>
          )
        }
      />

      <section aria-label="Filters" className="no-print mb-5 surface rounded-xl p-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <FilterField label="Date range" id="f-range" className="col-span-2 md:col-span-1">
            <SelectField
              id="f-range"
              value={preset}
              onChange={(v) => (v === "custom" ? go({ preset: v, from: custom[0], to: custom[1] }) : go({ preset: v, from: undefined, to: undefined }))}
              options={PRESETS}
            />
          </FilterField>
          <FilterField label="Site" id="f-site">
            <SelectField id="f-site" value={siteId} onChange={(v) => go({ site: v })} options={[{ value: "all", label: "All sites" }, ...sites.map((s) => ({ value: s.id, label: s.name }))]} />
          </FilterField>
          <FilterField label="Category" id="f-cat">
            <SelectField id="f-cat" value={category} onChange={(v) => go({ category: v })} options={[{ value: "all" as const, label: "All categories" }, ...CATEGORIES.map((c) => ({ value: c, label: CATEGORY_META[c].label }))]} />
          </FilterField>
          <FilterField label="Worker" id="f-worker">
            <SelectField id="f-worker" value={worker} onChange={(v) => go({ worker: v })} options={[{ value: "all", label: "All workers" }, ...workers.map((w) => ({ value: w, label: w }))]} />
          </FilterField>
          <FilterField label="Supplier" id="f-supplier">
            <SelectField id="f-supplier" value={supplier} onChange={(v) => go({ supplier: v })} options={[{ value: "all", label: "All suppliers" }, ...suppliers.map((s) => ({ value: s, label: s }))]} />
          </FilterField>
          <FilterField label="Paid by" id="f-method">
            <SelectField
              id="f-method"
              value={method}
              onChange={(v) => go({ method: v })}
              options={[{ value: "all" as const, label: "Any method" }, ...(Object.keys(PAYMENT_LABEL) as (keyof typeof PAYMENT_LABEL)[]).map((m) => ({ value: m, label: PAYMENT_LABEL[m] }))]}
            />
          </FilterField>
        </div>
        {preset === "custom" && (
          <form
            className="mt-3 grid grid-cols-[1fr_1fr_auto] items-end gap-3 md:max-w-lg"
            onSubmit={(e) => {
              e.preventDefault();
              go({ preset: "custom", from: custom[0], to: custom[1] });
            }}
          >
            <FilterField label="From" id="f-from">
              <Input id="f-from" type="date" max={today} className="h-11" value={custom[0]} onChange={(e) => setCustom([e.target.value, custom[1]])} />
            </FilterField>
            <FilterField label="To" id="f-to">
              <Input id="f-to" type="date" max={today} className="h-11" value={custom[1]} onChange={(e) => setCustom([custom[0], e.target.value])} />
            </FilterField>
            <Button type="submit" variant="outline" className="h-11">Apply</Button>
          </form>
        )}
        {(activeFilters > 0 || data.error) && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
            {data.error ? <p className="text-over" role="alert">{data.error}</p> : <p className="text-muted-foreground">{activeFilters} {activeFilters === 1 ? "filter" : "filters"} applied</p>}
            {activeFilters > 0 && (
              <Button variant="ghost" className="h-10" onClick={clear}>
                <FilterX aria-hidden /> Clear filters
              </Button>
            )}
          </div>
        )}
      </section>

      <div aria-busy={navigating} className={cn("transition-opacity", navigating && "opacity-60")}>
      {summary.count === 0 ? (
        <EmptyState
          icon={SearchX}
          title="No expenses in this report"
          description="Nothing matches these dates and filters. Widen the date range or clear a filter."
          action={activeFilters > 0 ? <Button variant="outline" className="h-11" onClick={clear}>Clear filters</Button> : undefined}
        />
      ) : (
        <div className="grid gap-4 lg:gap-5">
          <section aria-label="Summary" className="grid grid-cols-2 overflow-hidden surface rounded-xl lg:grid-cols-4">
            <Summary label="Total spent" value={fmt.money(summary.total)} strong />
            <Summary label="Entries" value={String(summary.count)} />
            <Summary label="Average per day" value={fmt.money(summary.avgPerDay)} />
            <Summary label="Largest category" value={summary.topCategory ? CATEGORY_META[summary.topCategory].label : "None"} />
          </section>

          <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
            <Panel title="By category">
              <CategoryBars data={cats} />
            </Panel>
            <Panel title="By site" bodyClassName="pt-2 sm:pt-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Site</TableHead>
                    <TableHead className="text-right">Entries</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bySite.map((s) => (
                    <TableRow key={s.siteId}>
                      <TableCell className="py-3 font-medium">{s.name}</TableCell>
                      <TableCell className="num text-right">{s.count}</TableCell>
                      <TableCell className="num text-right font-semibold">{fmt.money(s.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
          </div>

          <Panel title="Transactions" description={`${summary.count} entries`} bodyClassName="pt-2 sm:pt-2">
            {/* Mobile: list. Desktop: sortable table. */}
            <div className="md:hidden">
              <ExpenseList expenses={data.page.items} nextCursor={data.page.nextCursor} filters={{ ...f, limit: 50 }} total={summary.count} showSite grouped={false} />
            </div>
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead><SortButton label="Date" active={sort.startsWith("date")} dir={sort.endsWith("asc") ? "asc" : "desc"} onClick={() => toggleSort("date")} /></TableHead>
                    <TableHead>Site</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Worker / supplier</TableHead>
                    <TableHead>Paid by</TableHead>
                    <TableHead className="text-right"><SortButton label="Amount" active={sort.startsWith("amount")} dir={sort.endsWith("asc") ? "asc" : "desc"} onClick={() => toggleSort("amount")} align="right" /></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="num py-3 whitespace-nowrap">{fmt.date(e.date)}</TableCell>
                      <TableCell className="max-w-40 truncate">{siteName[e.siteId]}</TableCell>
                      <TableCell className="max-w-64 truncate font-medium">{e.description}{e.quantity && <span className="font-normal text-muted-foreground">, {e.quantity}</span>}</TableCell>
                      <TableCell><CategoryChip category={e.category} /></TableCell>
                      <TableCell className="max-w-44 truncate text-muted-foreground">{e.worker ?? e.supplier ?? "None"}</TableCell>
                      <TableCell className="text-muted-foreground">{PAYMENT_LABEL[e.paymentMode]}</TableCell>
                      <TableCell className="num text-right font-semibold">{fmt.money(e.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={6} className="py-3 font-semibold">
                      Total of {summary.count} entries
                    </TableCell>
                    <TableCell className="num text-right font-bold">{fmt.money(summary.total)}</TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
              {cursor && (
                <div className="no-print mt-4 flex flex-col items-center gap-1">
                  <Button variant="outline" className="h-11 px-5" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? "Loading…" : "Show more"}
                  </Button>
                  <span className="text-xs text-muted-foreground">Showing {rows.length} of {summary.count}. Exports include every entry.</span>
                </div>
              )}
            </div>
          </Panel>
        </div>
      )}
      </div>

      <DownloadDialog open={exporting} onClose={() => setExporting(false)} range={[from, to]} filters={exportFilters} csvHref={csvHref} partial={partialExport} />
    </>
  );
}

function FilterField({ label, id, className, children }: { label: string; id: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn("grid min-w-0 gap-1.5", className)}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function Summary({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn("border-r border-b p-4 last:border-r-0 sm:p-5 lg:border-b-0", strong && "shadow-[inset_0_4px_0_var(--brand)]")}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={cn("num font-display mt-1 font-bold", strong ? "text-2xl sm:text-[1.75rem]" : "text-xl sm:text-2xl")}>{value}</p>
    </div>
  );
}

function SortButton({ label, active, dir, onClick, align }: { label: string; active: boolean; dir: "asc" | "desc"; onClick: () => void; align?: "right" }) {
  const Icon = dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("inline-flex h-9 items-center gap-1 font-medium", align === "right" && "flex-row-reverse", active ? "text-foreground" : "text-muted-foreground")}
      aria-label={`Sort by ${label.toLowerCase()}`}
    >
      {label}
      <Icon className={cn("size-3.5", !active && "opacity-0")} aria-hidden />
    </button>
  );
}

const REPORTS: { value: string; label: string; hint: string }[] = [
  { value: "expenses", label: "Site expenses", hint: "Every expense with subtotals per site, plus category totals" },
  { value: "categories", label: "Category totals", hint: "Materials, labour, transport, equipment and other, per site" },
  { value: "purchases", label: "Material purchases", hint: "Deliveries with supplier, invoice, quantity and rate" },
  { value: "labour", label: "Labour attendance and wages", hint: "Days worked, wages earned and paid, advances, balances" },
  { value: "suppliers", label: "Supplier bills and balances", hint: "Bills, payments and what's outstanding at the end of the period" },
  { value: "budget", label: "Budget versus actual", hint: "Each budget line against spending in the period and to date" },
  { value: "payments", label: "Payment history", hint: "Every payment out, by method and type" },
];

type Period = "report" | "today" | "week" | "month" | "custom";

function DownloadDialog({
  open,
  onClose,
  range,
  filters,
  csvHref,
  partial,
}: {
  open: boolean;
  onClose: () => void;
  range: [string, string];
  filters: Record<string, string>;
  csvHref: string;
  /** Some visible sites can't be exported by this user; consolidated reports leave them out. */
  partial: boolean;
}) {
  const { today } = useSession();
  const [kind, setKind] = useState("expenses");
  const [period, setPeriod] = useState<Period>("report");
  const [custom, setCustom] = useState<[string, string]>(range);
  const monday = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  })();
  const [from, to] =
    period === "today" ? [today, today] : period === "week" ? [monday, today] : period === "month" ? [`${today.slice(0, 8)}01`, today] : period === "custom" ? custom : range;
  const href = (format: "pdf" | "xlsx") => `/api/reports/download?${toParams({ kind, format, from, to, ...filters })}`;
  const valid = !!from && !!to && from <= to && to <= today;

  function download(format: "pdf" | "xlsx") {
    // The server rebuilds the report from these filters and checks site access; nothing on this page is sent as data.
    window.location.assign(href(format));
    toast.success("Preparing your report", { description: `${REPORTS.find((r) => r.value === kind)?.label}, ${from} to ${to}` });
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">Download report</DialogTitle>
          <DialogDescription>
            Uses this page&apos;s site, category, worker, supplier and payment filters.
            {partial && " Consolidated reports include only sites where you're an owner or accountant."} Reports are internal statements, not tax invoices.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FilterField label="Report" id="d-kind">
            <SelectField id="d-kind" value={kind} onChange={setKind} options={REPORTS.map((r) => ({ value: r.value, label: r.label }))} />
          </FilterField>
          <p className="-mt-2 text-xs text-muted-foreground">{REPORTS.find((r) => r.value === kind)?.hint}</p>
          <FilterField label="Period" id="d-period">
            <SelectField
              id="d-period"
              value={period}
              onChange={setPeriod}
              options={[
                { value: "report" as const, label: `As on this page (${range[0]} to ${range[1]})` },
                { value: "today" as const, label: "Daily (today)" },
                { value: "week" as const, label: "Weekly (this week)" },
                { value: "month" as const, label: "Monthly (this month)" },
                { value: "custom" as const, label: "Custom range" },
              ]}
            />
          </FilterField>
          {period === "custom" && (
            <div className="grid grid-cols-2 gap-3">
              <FilterField label="From" id="d-from">
                <Input id="d-from" type="date" max={today} className="h-11" value={custom[0]} onChange={(e) => setCustom([e.target.value, custom[1]])} />
              </FilterField>
              <FilterField label="To" id="d-to">
                <Input id="d-to" type="date" max={today} className="h-11" value={custom[1]} onChange={(e) => setCustom([custom[0], e.target.value])} />
              </FilterField>
            </div>
          )}
          {!valid && <p className="text-sm text-over" role="alert">Pick a start on or before the end, ending today or earlier.</p>}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <a href={csvHref} className="inline-flex h-11 items-center text-sm text-muted-foreground underline underline-offset-4" onClick={onClose}>
            Expense rows as CSV
          </a>
          <div className="flex gap-2">
            <Button variant="outline" className="h-11" disabled={!valid} onClick={() => download("xlsx")}>
              <FileSpreadsheet aria-hidden /> Excel
            </Button>
            <Button className="h-11 px-5" disabled={!valid} onClick={() => download("pdf")}>
              <FileText aria-hidden /> PDF
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
