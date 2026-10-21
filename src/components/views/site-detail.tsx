"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ArrowLeft, Building2, CalendarDays, HardHat, Mic, Pencil, Plus, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { EmptyState } from "@/components/states";
import { TapeMeter } from "@/components/tape-meter";
import { ExpenseList } from "@/components/expense-list";
import { ExpenseFormDialog } from "@/components/expense-form-dialog";
import { SiteFormDialog } from "@/components/site-form-dialog";
import { SitePeople, type SiteMember } from "@/components/site-people";
import { SiteStatusBadge } from "@/components/site-status";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CategoryBars, SpendTrendChart } from "@/components/charts";
import { CATEGORY_META } from "@/lib/categories";
import { daysBetween } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { useCanManageOrg, useFormat } from "@/lib/session";
import { CATEGORIES, type Category } from "@/lib/types";
import { deleteSiteAction } from "@/server/actions/sites";
import type { BudgetLineUsage } from "@/server/data/analytics";
import type { SiteDetailData } from "@/server/data/dashboard";
import { BudgetPanel } from "@/components/budget-panel";
import { cn } from "@/lib/utils";

const backLink = (
  <Link href="/sites" className="mb-2 inline-flex h-9 items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
    <ArrowLeft className="size-4" aria-hidden /> Sites
  </Link>
);

export function SiteNotFound() {
  return (
    <>
      <PageHeader back={backLink} title="Site not found" />
      <EmptyState
        icon={Building2}
        title="This site doesn't exist"
        description="It may have been deleted, the link is wrong, or you don't have access. Pick a site from the list."
        action={<Link href="/sites" className={cn(buttonVariants({ variant: "outline" }), "h-11 px-5")}>Go to sites</Link>}
      />
    </>
  );
}

/** `members` is null unless the user may manage this site's people. */
export function SiteDetailView({ data, members, budgetLines }: { data: SiteDetailData; members: SiteMember[] | null; budgetLines: BudgetLineUsage[] }) {
  const fmt = useFormat();
  const router = useRouter();
  const pathname = usePathname();
  const canDelete = useCanManageOrg();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [switching, startSwitch] = useTransition();

  const { summary, categories: cats, weekly: daily, history } = data;
  const site = summary.site;
  const tab: "all" | Category = data.category ?? "all";
  const canWrite = can(site.role, "expense:create") && site.status !== "completed";
  const isManager = can(site.role, "site:manage");

  // Category tabs filter on the server via the URL.
  function setTab(next: "all" | Category) {
    startSwitch(() => router.replace(next === "all" ? pathname : `${pathname}?category=${next}`, { scroll: false }));
  }

  const { spent, balance, utilisation, monthSpend: month } = summary;
  const perDay = data.last30 / 30;
  const daysLeft = perDay > 0 && balance > 0 ? Math.floor(balance / perDay) : null;
  const catTotal = (c: Category) => cats.find((x) => x.category === c)?.amount ?? 0;

  return (
    <>
      <PageHeader
        back={backLink}
        title={site.name}
        description={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <SiteStatusBadge status={site.status} />
            <span>{site.location}</span>
          </span>
        }
        actions={
          <>
            {isManager && (
              <Button variant="outline" size="icon" className="size-11" aria-label="Edit site" onClick={() => setEditing(true)}>
                <Pencil aria-hidden />
              </Button>
            )}
            {canDelete && (
              <Button variant="outline" size="icon" className="size-11 text-over" aria-label="Delete site" onClick={() => setDeleting(true)}>
                <Trash2 aria-hidden />
              </Button>
            )}
            {canWrite && (
              <>
                <Link href="/voice" className={cn(buttonVariants({ variant: "outline" }), "h-11 px-4")}>
                  <Mic aria-hidden /> Voice
                </Link>
                <Button className="h-11 px-4" onClick={() => setAdding(true)}>
                  <Plus aria-hidden /> Add expense
                </Button>
              </>
            )}
          </>
        }
      />

      <div className="grid gap-4 lg:gap-5">
        {/* Budget band */}
        <section aria-label="Budget" className="surface rounded-xl p-4 sm:p-5">
          <div className="grid gap-5 md:grid-cols-[1fr_auto] md:items-end">
            <div>
              <p className="text-sm text-muted-foreground">Balance left</p>
              <p className={cn("num font-display text-[2.25rem] leading-none font-bold sm:text-[2.75rem]", balance < 0 && "text-over")}>
                {fmt.money(balance)}
              </p>
            </div>
            <dl className="grid grid-cols-3 gap-4 text-sm md:gap-8">
              <div>
                <dt className="text-xs text-muted-foreground">Budget</dt>
                <dd className="num font-semibold">{fmt.money(site.budget)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Spent</dt>
                <dd className="num font-semibold">{fmt.money(spent)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">This month</dt>
                <dd className="num font-semibold">{fmt.money(month)}</dd>
              </div>
            </dl>
          </div>
          <TapeMeter utilisation={utilisation} alertAt={summary.alertAt} size="lg" className="mt-5" />
          <p className="mt-3 text-sm text-muted-foreground">
            {site.status !== "active"
              ? "Site isn't active, so no burn rate is projected."
              : daysLeft !== null
                ? `At the last 30 days' pace (${fmt.money(Math.round(perDay))} a day), the budget lasts about ${daysLeft} more days.`
                : balance < 0
                  ? "Budget is exhausted. Raise a revised estimate with the client."
                  : "No spending in the last 30 days."}
          </p>
        </section>

        <BudgetPanel siteId={site.id} lines={budgetLines} canManage={can(site.role, "finance:manage")} />

        <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr] lg:gap-5">
          <Panel title="Where the money went" description="All time, by category">
            <CategoryBars data={cats} />
          </Panel>
          <Panel title="Weekly spend" description="Last 12 weeks">
            <SpendTrendChart data={daily} height={220} />
          </Panel>
        </div>

        <section aria-labelledby="history-heading" className="surface rounded-xl">
          <div className="border-b px-4 pt-4 sm:px-5 sm:pt-5">
            <h2 id="history-heading" className="text-base font-semibold">Expense history</h2>
            <Tabs value={tab} onValueChange={(v) => setTab(v as "all" | Category)} className="-mx-4 mt-3 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
              <TabsList variant="line" className="h-auto! gap-0 p-0">
                <TabTrigger value="all" label="All" amount={fmt.money(spent)} />
                {CATEGORIES.map((c) => (
                  <TabTrigger key={c} value={c} label={CATEGORY_META[c].label} amount={fmt.money(catTotal(c))} color={CATEGORY_META[c].color} />
                ))}
              </TabsList>
            </Tabs>
          </div>
          <div className={cn("p-4 transition-opacity sm:p-5", switching && "opacity-60")} aria-busy={switching}>
            <ExpenseList
              expenses={history.items}
              nextCursor={history.nextCursor}
              filters={{ siteId: site.id, categoryCode: data.category ?? undefined, limit: 25 }}
              emptyTitle={tab === "all" ? "No expenses on this site yet" : `No ${CATEGORY_META[tab].label.toLowerCase()} expenses yet`}
              emptyDescription="Add one by hand or log it by voice from the site."
            />
          </div>
        </section>

        <Panel title="Site details">
          <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Detail icon={UserRound} label="Client" value={site.client || "Not set"} />
            <Detail icon={HardHat} label="Site engineer" value={site.engineer || "Not assigned"} />
            <Detail icon={CalendarDays} label="Started" value={`${fmt.date(site.startDate)}, ${Math.max(0, daysBetween(site.startDate, data.today))} days ago`} />
            <Detail icon={Building2} label="Entries" value={`${summary.entryCount} expenses recorded`} />
          </dl>
        </Panel>

        {members && <SitePeople siteId={site.id} siteName={site.name} members={members} />}
      </div>

      <ExpenseFormDialog open={adding} onOpenChange={setAdding} defaultSiteId={site.id} />
      <SiteFormDialog open={editing} onOpenChange={setEditing} site={site} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${site.name}?`}
        description={`This removes the site and its ${summary.entryCount} expenses. It can't be undone.`}
        confirmLabel="Delete site"
        onConfirm={async () => {
          const res = await deleteSiteAction(site.id);
          if (!res.ok) {
            toast.error(res.error);
            return;
          }
          toast.success("Site deleted", { description: site.name });
          router.push("/sites");
        }}
      />
    </>
  );
}

function TabTrigger({ value, label, amount, color }: { value: string; label: string; amount: string; color?: string }) {
  return (
    <TabsTrigger
      value={value}
      className="h-auto! flex-none flex-col items-start gap-0 rounded-none border-0 border-b-2 border-transparent px-3 pt-1 pb-2.5 data-active:border-primary data-active:bg-transparent! data-active:text-primary"
    >
      <span className="inline-flex items-center gap-1.5 text-sm">
        {color && <span className="size-2 rounded-full" style={{ backgroundColor: color }} aria-hidden />}
        {label}
      </span>
      <span className="num text-xs font-normal text-muted-foreground">{amount}</span>
    </TabsTrigger>
  );
}

function Detail({ icon: Icon, label, value }: { icon: typeof UserRound; label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div>
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="font-medium">{value}</dd>
      </div>
    </div>
  );
}
