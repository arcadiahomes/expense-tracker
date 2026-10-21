"use client";

import Link from "next/link";
import { useState } from "react";
import { Building2, CalendarClock, CalendarDays, CalendarRange, ClipboardCheck, Mic, Plus, TrendingDown, TrendingUp } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { TapeMeter } from "@/components/tape-meter";
import { ExpenseFormDialog } from "@/components/expense-form-dialog";
import { Sparkline, SpendTrendChart } from "@/components/charts";
import type { Granularity } from "@/lib/analytics";
import { longDate } from "@/lib/format";
import { useFormat, useSession, useWritableSites } from "@/lib/session";
import type { AnalyticsData } from "@/server/data/analytics";
import type { DashboardData } from "@/server/data/dashboard";
import { AnalyticsFilters, BudgetAlerts, CategoryRanking, MoneyPosition, RecentTransactions, SiteComparison, UnpaidBalances } from "./analytics-panels";
import { cn } from "@/lib/utils";


export function DashboardView({ data, analytics, filterError }: { data: DashboardData; analytics: AnalyticsData; filterError?: string }) {
  const [adding, setAdding] = useState(false);
  const canWrite = useWritableSites().length > 0;
  return (
    <>
      <PageHeader
        title="Site expenses"
        description={`${longDate(data.today)}. Spending across all your sites.`}
        actions={
          canWrite && (
            <>
              <Button variant="outline" className="h-11 px-4" onClick={() => setAdding(true)}>
                <Plus aria-hidden /> Add expense
              </Button>
              <Link href="/voice" className={cn(buttonVariants(), "h-11 px-4")}>
                <Mic aria-hidden /> Log by voice
              </Link>
            </>
          )
        }
      />
      <PendingApprovals />
      <DashboardBody data={data} analytics={analytics} filterError={filterError} />
      <ExpenseFormDialog open={adding} onOpenChange={setAdding} />
    </>
  );
}

/** Site owners: submissions not yet in any figure on this page. */
function PendingApprovals() {
  const { pendingApprovals: n } = useSession();
  if (!n) return null;
  return (
    <Link
      href="/approvals"
      className="mb-5 flex items-center gap-3 rounded-xl border border-warn/40 bg-warn/10 p-4 transition-colors hover:bg-warn/15"
    >
      <ClipboardCheck className="size-5 shrink-0 text-warn" aria-hidden />
      <span className="min-w-0 flex-1 text-sm">
        <span className="font-semibold">
          {n} {n === 1 ? "expense is" : "expenses are"} waiting for your approval.
        </span>{" "}
        The figures below count approved expenses only.
      </span>
      <span className="shrink-0 text-sm font-semibold text-warn">Review</span>
    </Link>
  );
}

function DeltaPill({ now, before, period, onBrand }: { now: number; before: number; period: string; onBrand?: boolean }) {
  if (before === 0) return null;
  const change = Math.round(((now - before) / before) * 100);
  const up = change >= 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span
      title={`${Math.abs(change)}% ${up ? "more" : "less"} than ${period}`}
      className={cn(
        "num inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs font-semibold",
        onBrand ? "bg-white/20 text-white dark:bg-emerald-950/15 dark:text-emerald-950" : up ? "bg-warn/12 text-warn" : "bg-good/12 text-good",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {Math.abs(change)}%
      <span className="sr-only">{up ? "more" : "less"} than {period}</span>
    </span>
  );
}

/** Pure presentation: every number here was computed by the server from stored records. */
function DashboardBody({ data, analytics, filterError }: { data: DashboardData; analytics: AnalyticsData; filterError?: string }) {
  const fmt = useFormat();
  const [granularity, setGranularity] = useState<Granularity>("daily");

  const { totals } = data;
  const summaries = data.sites;
  const sites = summaries.map((s) => s.site);
  const series = data.trends[granularity];
  const dailySpark = data.trends.daily.map((p) => p.total);
  const weeklySpark = data.trends.weekly.map((p) => p.total);
  const monthlySpark = data.trends.monthly.map((p) => p.total);

  const counts = {
    active: sites.filter((s) => s.status === "active").length,
    hold: sites.filter((s) => s.status === "on-hold").length,
    done: sites.filter((s) => s.status === "completed").length,
  };
  const running = summaries
    .filter((s) => s.site.status !== "completed")
    .sort((a, b) => b.utilisation - a.utilisation);

  const ledger = [
    { label: "Today", icon: CalendarDays, amount: totals.today, before: totals.yesterday, period: "yesterday", series: dailySpark },
    { label: "This week", icon: CalendarRange, amount: totals.week, before: totals.lastWeekToDate, period: "same point last week", series: weeklySpark },
    { label: "This month", icon: CalendarClock, amount: totals.month, before: totals.lastMonthToDate, period: "same point last month", series: monthlySpark },
  ];
  const runningBudget = running.reduce((t, s) => t + s.site.budget, 0);
  const portfolio = {
    budget: runningBudget,
    pct: runningBudget ? Math.round((running.reduce((t, s) => t + s.spent, 0) / runningBudget) * 100) : 0,
  };

  return (
    <div className="grid gap-4 lg:gap-5">
      {/* The three numbers a site engineer reports every evening, plus the portfolio. */}
      <section aria-label="Spending totals" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 lg:gap-5">
        {ledger.map((row, i) => {
          const hero = i === 0;
          const Icon = row.icon;
          return (
            <article
              key={row.label}
              className={cn(
                "relative flex flex-col overflow-hidden rounded-xl p-5",
                hero ? "brand-fill brand-sheen shadow-[0_18px_36px_-18px_rgb(22_101_52/0.85)]" : "surface",
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2.5">
                  <span className={cn("grid size-9 place-items-center rounded-xl", hero ? "bg-white/20" : "bg-accent text-primary")}>
                    <Icon className="size-[18px]" aria-hidden />
                  </span>
                  <span className={cn("text-sm font-medium", hero ? "text-white/90 dark:text-emerald-950/80" : "text-muted-foreground")}>{row.label}</span>
                </span>
                <DeltaPill now={row.amount} before={row.before} period={row.period} onBrand={hero} />
              </div>
              <p className="num font-display mt-4 text-[1.875rem] leading-none font-bold">{fmt.money(row.amount)}</p>
              <p className={cn("mt-1.5 text-xs", hero ? "text-white/80 dark:text-emerald-950/70" : "text-muted-foreground")}>
                {fmt.money(row.before)} {row.period}
              </p>
              <div className="-mx-5 -mb-5 mt-3 h-14">
                <Sparkline data={row.series} color={hero ? "rgb(255 255 255 / 0.9)" : "var(--primary)"} id={`spark-${i}`} />
              </div>
            </article>
          );
        })}

        <article className="surface flex flex-col rounded-xl p-5">
          <div className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-xl bg-accent text-primary">
              <Building2 className="size-[18px]" aria-hidden />
            </span>
            <span className="text-sm font-medium text-muted-foreground">Projects</span>
          </div>
          <p className="mt-4 flex items-baseline gap-2">
            <span className="num font-display text-[1.875rem] leading-none font-bold">{sites.length}</span>
            <span className="text-sm text-muted-foreground">sites in total</span>
          </p>
          <div className="mt-3 flex h-2 gap-0.5 overflow-hidden rounded-full bg-secondary" aria-hidden>
            <span className="bg-primary" style={{ width: `${(counts.active / Math.max(1, sites.length)) * 100}%` }} />
            <span className="bg-warn" style={{ width: `${(counts.hold / Math.max(1, sites.length)) * 100}%` }} />
            <span className="bg-muted-foreground/40" style={{ width: `${(counts.done / Math.max(1, sites.length)) * 100}%` }} />
          </div>
          <ul className="mt-3 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
            <li><span className="num block text-base font-semibold text-foreground">{counts.active}</span><span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full bg-primary" />Active</span></li>
            <li><span className="num block text-base font-semibold text-foreground">{counts.hold}</span><span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full bg-warn" />On hold</span></li>
            <li><span className="num block text-base font-semibold text-foreground">{counts.done}</span><span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full bg-muted-foreground/50" />Done</span></li>
          </ul>
          <p className="mt-auto border-t border-[var(--line)] pt-3 text-xs text-muted-foreground">
            Running sites have used <span className="num font-semibold text-foreground">{portfolio.pct}%</span> of {fmt.money(portfolio.budget)}
          </p>
        </article>
      </section>

      <Panel
        title="Spending trend"
        description={granularity === "daily" ? "Last 14 days" : granularity === "weekly" ? "Last 12 weeks" : "Last 8 months"}
        action={
          <Tabs value={granularity} onValueChange={(v) => setGranularity(v as Granularity)}>
            <TabsList className="h-10!">
              <TabsTrigger value="daily" className="px-3">Daily</TabsTrigger>
              <TabsTrigger value="weekly" className="px-3">Weekly</TabsTrigger>
              <TabsTrigger value="monthly" className="px-3">Monthly</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      >
        <SpendTrendChart data={series} />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-[1.25fr_1fr] lg:gap-5">
        <Panel
          title="Budget used"
          description="Sites still running, most used first"
          action={<Link href="/sites" className="text-sm font-medium underline-offset-4 hover:underline">All sites</Link>}
        >
          {running.length === 0 && <p className="text-sm text-muted-foreground">No running sites. Add a site to track its budget.</p>}
          <ul className="space-y-5">
            {running.map((s) => (
              <li key={s.site.id}>
                <Link href={`/sites/${s.site.id}`} className="group block rounded-sm">
                  <div className="mb-1.5 flex items-baseline justify-between gap-3">
                    <span className="truncate font-medium group-hover:underline">{s.site.name}</span>
                    <span className="num shrink-0 text-sm text-muted-foreground">
                      {fmt.money(s.spent)} <span className="text-xs">of {fmt.money(s.site.budget)}</span>
                    </span>
                  </div>
                  <TapeMeter utilisation={s.utilisation} alertAt={s.alertAt} label={`Budget used, ${s.site.name}`} />
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
        <BudgetAlerts data={analytics} />
      </div>

      <div className="no-print">
        <AnalyticsFilters data={analytics} error={filterError} />
      </div>
      <MoneyPosition data={analytics} />
      <div className="grid gap-4 lg:grid-cols-[1fr_1.25fr] lg:gap-5">
        <CategoryRanking data={analytics} />
        <RecentTransactions data={analytics} />
      </div>
      <SiteComparison data={analytics} />
      <UnpaidBalances data={analytics} />
    </div>
  );
}
