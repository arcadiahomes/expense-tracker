"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { AlertTriangle, CircleAlert, OctagonAlert, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CategoryBars, SiteComparisonChart } from "@/components/charts";
import { ExpenseList } from "@/components/expense-list";
import { Panel } from "@/components/panel";
import { SelectField } from "@/components/select-field";
import { CATEGORY_META } from "@/lib/categories";
import { monthStart, shiftDate, weekStart } from "@/lib/dates";
import { useFormat, useSession } from "@/lib/session";
import type { AnalyticsData, SpendKind } from "@/server/data/analytics";
import { cn } from "@/lib/utils";

const n = (v: string | number | null | undefined) => Number(v ?? 0);
const pct = (u: number) => `${Math.round(u * 100)}%`;
const ALL = "all";

const KIND_LABEL: Record<SpendKind, { label: string; hint: string }> = {
  bill_payments: { label: "Supplier bill payments", hint: "Paid against bills" },
  purchases: { label: "Materials paid on the spot", hint: "Cash, UPI or bank at purchase" },
  wages: { label: "Wages paid", hint: "To workers for work done" },
  advances: { label: "Advances paid", hint: "To workers, before the work" },
  other: { label: "Other expenses", hint: "Everything else entered" },
};

type Preset = "today" | "week" | "month" | "last-month" | "30" | "custom";

function presetRange(p: Preset, t: string): [string, string] | null {
  if (p === "today") return [t, t];
  if (p === "week") return [weekStart(t), t];
  if (p === "month") return [monthStart(t), t];
  if (p === "last-month") {
    const end = shiftDate(monthStart(t), -1);
    return [monthStart(end), end];
  }
  if (p === "30") return [shiftDate(t, -29), t];
  return null;
}

/** Range, site and search live in the URL, because the server computes everything from them. */
export function AnalyticsFilters({ data, error }: { data: AnalyticsData; error?: string }) {
  const { sites, today } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const matches = (Object.keys({ today: 0, week: 0, month: 0, "last-month": 0, "30": 0 }) as Preset[]).find((p) => {
    const r = presetRange(p, today);
    return r && r[0] === data.range.from && r[1] === data.range.to;
  });
  const [preset, setPreset] = useState<Preset>(matches ?? "custom");
  const [from, setFrom] = useState(data.range.from);
  const [to, setTo] = useState(data.range.to);
  const [q, setQ] = useState(data.q ?? "");

  const go = (patch: Record<string, string | null>) =>
    start(() => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      router.push(next.size ? `${pathname}?${next}` : pathname, { scroll: false });
    });

  const choosePreset = (p: Preset) => {
    setPreset(p);
    const r = presetRange(p, today);
    if (r) {
      setFrom(r[0]);
      setTo(r[1]);
      go({ from: r[0], to: r[1] });
    }
  };

  const search = (e: FormEvent) => {
    e.preventDefault();
    go({ q: q.trim() || null });
  };

  return (
    <section aria-label="Filters" className={cn("surface grid gap-3 rounded-xl p-4 sm:p-5", pending && "opacity-70")}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto]">
        <div className="grid gap-1.5">
          <Label htmlFor="an-range" className="text-sm font-medium">Period</Label>
          <SelectField
            id="an-range"
            value={preset}
            onChange={choosePreset}
            options={[
              { value: "today", label: "Today" },
              { value: "week", label: "This week" },
              { value: "month", label: "This month" },
              { value: "last-month", label: "Last month" },
              { value: "30", label: "Last 30 days" },
              { value: "custom", label: "Custom range" },
            ]}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="an-site" className="text-sm font-medium">Sites</Label>
          <SelectField
            id="an-site"
            value={data.siteId ?? ALL}
            onChange={(v) => go({ site: v === ALL ? null : v })}
            options={[{ value: ALL, label: "All my sites" }, ...sites.map((s) => ({ value: s.id, label: s.name }))]}
          />
        </div>
        {preset === "custom" && (
          <form
            className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-1"
            onSubmit={(e) => {
              e.preventDefault();
              go({ from, to });
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="an-from" className="text-sm font-medium">From</Label>
              <Input id="an-from" type="date" className="h-11" max={today} value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="an-to" className="text-sm font-medium">To</Label>
              <Input id="an-to" type="date" className="h-11" max={today} value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <Button type="submit" variant="outline" className="h-11" disabled={!from || !to}>Apply</Button>
          </form>
        )}
      </div>
      <form role="search" onSubmit={search} className="flex gap-2">
        <Label htmlFor="an-q" className="sr-only">Search transactions</Label>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input id="an-q" type="search" className="h-11 pl-9" maxLength={100} placeholder="Search by description, supplier or worker" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Button type="submit" className="h-11">Search</Button>
        {data.q && (
          <Button type="button" variant="ghost" className="h-11" aria-label="Clear search" onClick={() => { setQ(""); go({ q: null }); }}>
            <X aria-hidden />
          </Button>
        )}
      </form>
      {error && (
        <p role="alert" className="flex items-center gap-2 text-sm font-medium text-over">
          <CircleAlert className="size-4" aria-hidden /> {error} Showing this month for all your sites instead.
        </p>
      )}
    </section>
  );
}

/** Spent vs committed: what left, and what's owed but not yet paid. Never added into each other twice. */
export function MoneyPosition({ data }: { data: AnalyticsData }) {
  const fmt = useFormat();
  const { commitments: c } = data;
  const spent = n(data.totals.range);
  return (
    <Panel
      title="Spent and committed"
      description={`${fmt.date(data.range.from)} to ${fmt.date(data.range.to)} · ${data.totals.rangeCount} entries`}
    >
      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Spent in this period</p>
          <p className="num font-display mt-1 text-3xl font-bold">{fmt.money(spent)}</p>
          <p className="text-xs text-muted-foreground">Every payment made, counted once</p>
          <ul className="mt-3 divide-y rounded-lg border text-sm">
            {data.spendKinds.map((k) => (
              <li key={k.kind} className="flex items-center justify-between gap-3 px-3 py-2">
                <span>
                  {KIND_LABEL[k.kind].label}
                  <span className="block text-xs text-muted-foreground">{KIND_LABEL[k.kind].hint}</span>
                </span>
                <span className="num text-right">
                  <span className="font-semibold">{fmt.money(n(k.amount))}</span>
                  <span className="block text-xs text-muted-foreground">{k.count} entries</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Committed, not yet paid (today)</p>
          <p className={cn("num font-display mt-1 text-3xl font-bold", n(c.total) > 0 && "text-warn")}>{fmt.money(n(c.total))}</p>
          <p className="text-xs text-muted-foreground">Owed now, not part of what was spent</p>
          <ul className="mt-3 divide-y rounded-lg border text-sm">
            <li className="flex items-center justify-between gap-3 px-3 py-2">
              <span>
                <Link href="/suppliers" className="underline-offset-4 hover:underline">Supplier bills outstanding</Link>
                {n(c.supplierOverdue) > 0 && <span className="block text-xs text-over">{fmt.money(n(c.supplierOverdue))} overdue</span>}
              </span>
              <span className="num font-semibold">{fmt.money(n(c.supplierOutstanding))}</span>
            </li>
            <li className="flex items-center justify-between gap-3 px-3 py-2">
              <Link href="/labour" className="underline-offset-4 hover:underline">Unpaid wages</Link>
              <span className="num font-semibold">{fmt.money(n(c.unpaidWages))}</span>
            </li>
            <li className="flex items-center justify-between gap-3 px-3 py-2 text-muted-foreground">
              <span>
                Advances not yet worked off
                <span className="block text-xs">Already in spent; shown for reference</span>
              </span>
              <span className="num">{fmt.money(n(c.advancesOutstanding))}</span>
            </li>
          </ul>
        </div>
      </div>
    </Panel>
  );
}

export function BudgetAlerts({ data }: { data: AnalyticsData }) {
  const fmt = useFormat();
  if (!data.alerts.length) {
    return (
      <Panel title="Budget alerts" description="Lines past their alert threshold">
        <p className="text-sm text-muted-foreground">
          {data.budgetLines.length ? "Every budget line is below its alert threshold." : "No budgets set yet. Set them on each site's page."}
        </p>
      </Panel>
    );
  }
  return (
    <Panel title="Budget alerts" description={`${data.alerts.length} ${data.alerts.length === 1 ? "line needs" : "lines need"} attention`}>
      <ul className="space-y-2" aria-live="polite">
        {data.alerts.map((a) => {
          const over = a.level === "over";
          const Icon = over ? OctagonAlert : AlertTriangle;
          return (
            <li key={`${a.siteId}-${a.category ?? "total"}`}>
              <Link
                href={`/sites/${a.siteId}`}
                className={cn("flex items-start gap-3 rounded-lg border p-3 text-sm hover:bg-secondary/50", over ? "border-over/40" : "border-warn/40")}
              >
                <Icon className={cn("mt-0.5 size-4 shrink-0", over ? "text-over" : "text-warn")} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">
                    {a.site} · {a.category ? CATEGORY_META[a.category].label : "Total budget"}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {over ? "Over budget" : `Past the ${a.alertPercent}% alert`}: {fmt.money(n(a.spent))} of {fmt.money(n(a.budget))}
                    {n(a.committed) > 0 && `, ${fmt.money(n(a.committed))} more committed`}
                  </span>
                </span>
                <span className={cn("num font-semibold", over ? "text-over" : "text-warn")}>{n(a.budget) > 0 ? pct(a.utilisation) : "No budget"}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

export function CategoryRanking({ data }: { data: AnalyticsData }) {
  const fmt = useFormat();
  const ranked = [...data.byCategory].sort((a, b) => n(b.amount) - n(a.amount));
  const top = data.topCategories[0];
  return (
    <Panel
      title="Highest-spending categories"
      description={top ? `${CATEGORY_META[top.category].label} leads with ${pct(top.share)} of ${fmt.money(n(data.totals.range))}` : "Nothing spent in this period"}
    >
      {top ? <CategoryBars data={ranked.map((c) => ({ category: c.category, amount: n(c.amount) }))} /> : <p className="text-sm text-muted-foreground">No expenses in this period.</p>}
    </Panel>
  );
}

export function SiteComparison({ data }: { data: AnalyticsData }) {
  const fmt = useFormat();
  const chart = data.sites.filter((s) => n(s.rangeSpent) > 0).map((s) => ({ name: s.name, amount: n(s.rangeSpent) }));
  return (
    <Panel title="Site comparison" description="Spend in this period, budgets over the whole project">
      {data.sites.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sites to compare.</p>
      ) : (
        <>
          {chart.length > 0 ? <SiteComparisonChart data={chart} /> : <p className="mb-3 text-sm text-muted-foreground">No spending in this period.</p>}
          <div className="-mx-4 mt-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[640px] text-sm">
              <caption className="sr-only">Budget, spending, commitments and balance per site</caption>
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">Site</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">This period</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Spent to date</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Committed</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Budget</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Remaining</th>
                  <th scope="col" className="py-2 text-right font-medium">Used</th>
                </tr>
              </thead>
              <tbody>
                {data.sites.map((s) => {
                  const over = s.utilisation !== null && s.utilisation > 1;
                  const warn = s.utilisation !== null && s.utilisation >= s.alertPercent / 100;
                  return (
                    <tr key={s.siteId} className="border-b last:border-0">
                      <th scope="row" className="py-2 pr-3 text-left font-medium">
                        <Link href={`/sites/${s.siteId}`} className="hover:underline">{s.name}</Link>
                      </th>
                      <td className="num py-2 pr-3 text-right">{fmt.money(n(s.rangeSpent))}</td>
                      <td className="num py-2 pr-3 text-right">{fmt.money(n(s.spent))}</td>
                      <td className="num py-2 pr-3 text-right">{fmt.money(n(s.committed))}</td>
                      <td className="num py-2 pr-3 text-right">{s.budget ? fmt.money(n(s.budget)) : "–"}</td>
                      <td className={cn("num py-2 pr-3 text-right", s.remaining !== null && n(s.remaining) < 0 && "text-over")}>
                        {s.remaining !== null ? fmt.money(n(s.remaining)) : "–"}
                        {s.remainingAfterCommitments !== null && n(s.committed) > 0 && (
                          <span className="block text-xs text-muted-foreground">{fmt.money(n(s.remainingAfterCommitments))} after commitments</span>
                        )}
                      </td>
                      <td className={cn("num py-2 text-right font-semibold", over ? "text-over" : warn ? "text-warn" : "")}>
                        {s.utilisation !== null ? pct(s.utilisation) : "–"}
                        {(over || warn) && <span className="sr-only">{over ? ", over budget" : ", past alert threshold"}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}

export function UnpaidBalances({ data }: { data: AnalyticsData }) {
  const fmt = useFormat();
  return (
    <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
      <Panel title="Workers owed" description={`${fmt.money(n(data.commitments.unpaidWages))} in unpaid wages`} action={<Link href="/labour" className="text-sm font-medium underline-offset-4 hover:underline">Labour</Link>}>
        {data.workersOwed.length === 0 ? (
          <p className="text-sm text-muted-foreground">No wages owed.</p>
        ) : (
          <ul className="divide-y text-sm">
            {data.workersOwed.map((w) => (
              <li key={`${w.siteId}-${w.workerId}`} className="flex justify-between gap-3 py-2">
                <span>
                  {w.worker} <span className="text-xs text-muted-foreground">· {w.site}</span>
                </span>
                <span className="num font-semibold text-warn">{fmt.money(n(w.amount))}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Suppliers owed" description={`${fmt.money(n(data.commitments.supplierOutstanding))} outstanding`} action={<Link href="/suppliers" className="text-sm font-medium underline-offset-4 hover:underline">Suppliers</Link>}>
        {data.suppliersOwed.length === 0 ? (
          <p className="text-sm text-muted-foreground">No supplier balances outstanding.</p>
        ) : (
          <ul className="divide-y text-sm">
            {data.suppliersOwed.map((s) => (
              <li key={s.supplierId} className="flex justify-between gap-3 py-2">
                <Link href={`/suppliers/${s.supplierId}`} className="hover:underline">
                  {s.supplier} <span className="text-xs text-muted-foreground">· {s.openBills} open {s.openBills === 1 ? "bill" : "bills"}</span>
                </Link>
                <span className="num text-right font-semibold">
                  {fmt.money(n(s.amount))}
                  {n(s.overdue) > 0 && <span className="block text-xs font-normal text-over">{fmt.money(n(s.overdue))} overdue</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

export function RecentTransactions({ data }: { data: AnalyticsData }) {
  return (
    <Panel
      title={data.q ? `Results for “${data.q}”` : "Recent transactions"}
      description={data.q ? "Matching description, supplier, worker or notes, any date" : "Latest in this period"}
      action={<Link href="/reports" className="text-sm font-medium underline-offset-4 hover:underline">Full report</Link>}
      bodyClassName="pt-1 sm:pt-1"
    >
      {data.recent.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">{data.q ? "Nothing matches that search." : "No transactions in this period."}</p>
      ) : (
        <ExpenseList expenses={data.recent} showSite grouped={false} limit={10} />
      )}
    </Panel>
  );
}
