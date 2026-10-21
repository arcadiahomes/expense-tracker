"use client";

import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { ExpenseList } from "@/components/expense-list";
import { Stat } from "@/components/form-bits";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { useFormat, useSession } from "@/lib/session";
import type { Expense, Page } from "@/lib/types";
import { cn } from "@/lib/utils";
import { loadReviewQueueAction } from "@/server/actions/expenses";

type Summary = { count: number; amount: number; bySite: { siteId: string; count: number; amount: number }[] };

/** The main engineer's queue: assistant engineers' submissions, oldest first, and what was sent back. */
export function ApprovalsView({ page, status, summary }: { page: Page<Expense>; status: "pending_approval" | "rejected"; summary: Summary }) {
  const fmt = useFormat();
  const { sites } = useSession();
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const tabs = [
    { key: "pending_approval", label: "Waiting", href: "/approvals" },
    { key: "rejected", label: "Sent back", href: "/approvals?status=rejected" },
  ] as const;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Approvals"
        description="Expenses from assistant engineers. They count in totals, budgets and reports only after you approve them."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Waiting for you" value={summary.count} tone={summary.count ? "warn" : undefined} />
        <Stat label="Waiting amount" value={fmt.money(summary.amount)} hint="Not in any total yet" />
        <div className="surface rounded-xl p-4">
          <p className="text-xs font-medium text-muted-foreground">By site</p>
          {summary.bySite.length ? (
            <ul className="mt-1 space-y-0.5 text-sm">
              {summary.bySite.map((s) => (
                <li key={s.siteId} className="flex justify-between gap-2">
                  <span className="truncate">{siteName.get(s.siteId) ?? "Site"}</span>
                  <span className="num shrink-0 text-muted-foreground">
                    {s.count} · {fmt.money(s.amount)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">Nothing waiting</p>
          )}
        </div>
      </div>

      <Panel bodyClassName="pt-2 sm:pt-3">
        <nav aria-label="Approval lists" className="mb-2 flex gap-1.5">
          {tabs.map((t) => {
            const active = t.key === status;
            return (
              <Link
                key={t.key}
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-10 items-center rounded-full border px-4 text-sm transition-colors",
                  active ? "border-transparent bg-primary font-semibold text-primary-foreground" : "border-[var(--line)] bg-card hover:bg-secondary",
                )}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
        <ExpenseList
          expenses={page.items}
          nextCursor={page.nextCursor}
          loader={(cursor) => loadReviewQueueAction({ status, cursor })}
          grouped={false}
          showSite
          review
          emptyTitle={status === "rejected" ? "Nothing sent back" : "All caught up"}
          emptyDescription={
            status === "rejected" ? "Rejected entries wait here until whoever entered them corrects and resubmits them." : "New submissions from assistant engineers will appear here."
          }
        />
      </Panel>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <ClipboardCheck className="size-4" aria-hidden />
        To correct an approved entry, use &ldquo;Send back for correction&rdquo; from its menu in any expense list.
      </p>
    </div>
  );
}
