"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Bell, Mic, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ExpenseFormDialog } from "@/components/expense-form-dialog";
import { ExpenseList } from "@/components/expense-list";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { useFormat, useWritableSites } from "@/lib/session";
import { EXPENSE_STATUS_LABEL, type Expense, type ExpenseStatus, type Page } from "@/lib/types";
import { cn } from "@/lib/utils";
import { loadMyExpensesAction, markNotificationsReadAction } from "@/server/actions/expenses";
import type { Notice } from "@/server/data/notifications";

const TABS: (ExpenseStatus | null)[] = [null, "draft", "pending_approval", "rejected", "approved"];

/**
 * An assistant engineer's home: a large voice button, manual entry, and their own entries
 * with where each one stands. Nothing here shows site totals or other people's entries.
 */
export function MyEntriesView({
  page,
  status,
  counts,
  notices,
}: {
  page: Page<Expense>;
  status: ExpenseStatus | null;
  counts: Record<ExpenseStatus, number>;
  notices: Notice[];
}) {
  const fmt = useFormat();
  const canAdd = useWritableSites().length > 0;
  const [adding, setAdding] = useState(false);
  const total = Object.values(counts).reduce((t, n) => t + n, 0);

  // Review results shown here count as read; the server only marks the user's own notices.
  const unread = notices.filter((n) => !n.read).map((n) => n.id);
  const unreadKey = unread.join(",");
  useEffect(() => {
    if (unreadKey) void markNotificationsReadAction(unreadKey.split(",")).catch(() => {});
  }, [unreadKey]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="My entries"
        description="What you've entered and where each one stands. An entry counts in the site's accounts once a site owner approves it."
      />

      {canAdd && (
        <section aria-label="Add an expense" className="surface flex flex-col items-center gap-4 rounded-xl p-5 sm:flex-row sm:justify-between">
          <Link
            href="/voice"
            className="brand-fill flex min-h-24 w-full items-center justify-center gap-3 rounded-2xl px-6 text-lg font-bold shadow-[0_10px_24px_-12px_rgb(22_101_52/0.9)] transition hover:brightness-110 sm:w-auto sm:min-w-72"
          >
            <span className="grid size-14 place-items-center rounded-full bg-white/15">
              <Mic className="size-8" aria-hidden />
            </span>
            Speak an expense
          </Link>
          <Button variant="outline" className="h-14 w-full gap-2 text-base sm:w-auto" onClick={() => setAdding(true)}>
            <Plus className="size-5" aria-hidden /> Type it in
          </Button>
        </section>
      )}

      {notices.length > 0 && (
        <Panel title="Review results" description="Approvals and rejections of what you sent.">
          <ul className="divide-y">
            {notices.map((n) => (
              <li key={n.id} className="flex items-start gap-3 py-2.5">
                <Bell className={cn("mt-0.5 size-4 shrink-0", n.read ? "text-muted-foreground" : "text-warn")} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className={cn("text-sm", !n.read && "font-semibold")}>
                    {!n.read && <span className="sr-only">New: </span>}
                    {n.title}
                  </p>
                  {n.body && <p className="text-sm text-muted-foreground">{n.body}</p>}
                </div>
                <time className="num shrink-0 text-xs text-muted-foreground" dateTime={n.createdAt}>
                  {fmt.date(n.createdAt.slice(0, 10))}
                </time>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel bodyClassName="pt-2 sm:pt-3">
        <nav aria-label="Filter by status" className="-mx-1 mb-2 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {TABS.map((t) => {
            const active = t === status;
            const n = t ? counts[t] : total;
            return (
              <Link
                key={t ?? "all"}
                href={t ? `/my?status=${t}` : "/my"}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors",
                  active ? "border-transparent bg-primary font-semibold text-primary-foreground" : "border-[var(--line)] bg-card hover:bg-secondary",
                )}
              >
                {t ? EXPENSE_STATUS_LABEL[t] : "All"}
                <span className="num text-xs opacity-80">{n}</span>
              </Link>
            );
          })}
        </nav>
        <ExpenseList
          expenses={page.items}
          nextCursor={page.nextCursor}
          loader={(cursor) => loadMyExpensesAction({ status: status ?? undefined, cursor })}
          grouped={false}
          showSite
          review
          emptyTitle={status ? `Nothing ${EXPENSE_STATUS_LABEL[status].toLowerCase()}` : "No entries yet"}
          emptyDescription="Expenses you speak or type show up here with their approval status."
        />
      </Panel>

      <ExpenseFormDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}
