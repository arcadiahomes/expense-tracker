"use client";

import { useMemo, useState, useTransition } from "react";
import { Check, Mic, MoreVertical, Paperclip, Pencil, ReceiptText, RotateCcw, Send, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CategoryChip, CategoryIcon } from "@/components/category-chip";
import { ExpenseFormDialog } from "@/components/expense-form-dialog";
import { ReopenDialog, ReviewDialog, StatusBadge, SubmitButton } from "@/components/expense-review";
import { ReceiptsPanel } from "@/components/receipts-panel";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { can } from "@/lib/permissions";
import { EmptyState } from "@/components/states";
import { useFormat, useSession } from "@/lib/session";
import type { ActionResult, Expense, Page } from "@/lib/types";
import type { ExpenseFilters } from "@/server/validation";
import { deleteExpenseAction, loadExpensesAction, restoreExpenseAction, submitExpenseAction } from "@/server/actions/expenses";

/** Expense history grouped by day, with a running total per day. */
export function ExpenseList({
  expenses,
  nextCursor = null,
  filters,
  total,
  showSite = false,
  grouped = true,
  limit,
  emptyTitle = "No expenses yet",
  emptyDescription = "Entries you add by voice or by hand will show up here.",
  loader,
  review = false,
}: {
  /** First page, rendered on the server. */
  expenses: Expense[];
  /** Cursor for the next server page; "Show more" appears when set. */
  nextCursor?: string | null;
  /** Filters used for the first page, reused to fetch later pages. */
  filters?: ExpenseFilters;
  /** Total matching rows, when the caller knows it. */
  total?: number;
  showSite?: boolean;
  grouped?: boolean;
  /** Fixed number of rows, no "show more". */
  limit?: number;
  emptyTitle?: string;
  emptyDescription?: string;
  /** Fetches the next page, for lists other than the site's approved expenses. */
  loader?: (cursor: string) => Promise<ActionResult<Page<Expense>>>;
  /** Approval screens: statuses, who entered and reviewed each entry, and its actions as buttons. */
  review?: boolean;
}) {
  const { sites } = useSession();
  const fmt = useFormat();
  const [editing, setEditing] = useState<Expense | undefined>();
  const [receiptsFor, setReceiptsFor] = useState<Expense | undefined>();
  const [reviewing, setReviewing] = useState<{ expense: Expense; decision: "approve" | "reject" } | null>(null);
  const [reopening, setReopening] = useState<Expense | null>(null);
  const [loading, startLoading] = useTransition();

  // Pages fetched with "Show more". Reset whenever the server sends a new first page
  // (after any change, the router refresh re-renders the page with fresh data).
  const [paged, setPaged] = useState({ base: expenses, extra: [] as Expense[], cursor: nextCursor });
  if (paged.base !== expenses) setPaged({ base: expenses, extra: [], cursor: nextCursor });
  const all = paged.base === expenses ? [...expenses, ...paged.extra] : expenses;
  const cursor = paged.base === expenses ? paged.cursor : nextCursor;

  const siteName = useMemo(
    () => Object.fromEntries(sites.map((s) => [s.id, s.name])),
    [sites],
  );

  const shown = limit ? all.slice(0, limit) : all;
  const groups = useMemo(() => {
    const map = new Map<string, Expense[]>();
    for (const e of shown) {
      const list = map.get(e.date) ?? [];
      list.push(e);
      map.set(e.date, list);
    }
    return [...map.entries()];
  }, [shown]);

  if (all.length === 0) {
    return <EmptyState icon={ReceiptText} title={emptyTitle} description={emptyDescription} />;
  }

  async function remove(e: Expense) {
    const res = await deleteExpenseAction(e.id);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast("Expense deleted", {
      description: `${e.description}, ${fmt.money(e.amount)}`,
      action: {
        label: "Undo",
        onClick: async () => {
          const undo = await restoreExpenseAction(e.id);
          if (!undo.ok) toast.error(undo.error);
        },
      },
    });
  }

  async function sendForApproval(e: Expense) {
    const res = await submitExpenseAction(e.id).catch(() => null);
    if (!res?.ok) {
      toast.error(res ? res.error : "Couldn't reach the server, so we can't confirm it was sent. Check its status before trying again.");
      return;
    }
    toast.success(res.data.status === "approved" ? "Saved. It counts in the totals now." : "Sent for approval", { description: e.description });
  }

  function loadMore() {
    if (!cursor || !(filters || loader)) return;
    startLoading(async () => {
      const res = loader ? await loader(cursor) : await loadExpensesAction({ ...filters, cursor });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setPaged((p) => ({ ...p, extra: [...p.extra, ...res.data.items], cursor: res.data.nextCursor }));
    });
  }

  const row = (e: Expense) => (
    <li key={e.id} className="py-3">
      <div className="flex items-center gap-3">
        <CategoryIcon category={e.category} />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 font-medium">
            {e.description}
            {e.quantity && <span className="font-normal text-muted-foreground">, {e.quantity}</span>}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <CategoryChip category={e.category} />
            {showSite && <span className="truncate">{siteName[e.siteId] ?? "Deleted site"}</span>}
            {!grouped && <span>{fmt.date(e.date)}</span>}
            {(e.worker || e.supplier) && <span className="truncate">{e.worker ?? e.supplier}</span>}
            {e.receipts > 0 && (
              <span className="inline-flex items-center gap-0.5">
                <Paperclip className="size-3" aria-hidden />
                {e.receipts}
                <span className="sr-only">{e.receipts === 1 ? "receipt" : "receipts"}</span>
              </span>
            )}
            {e.viaVoice && (
              <span className="inline-flex items-center gap-0.5">
                <Mic className="size-3" aria-hidden />
                Voice
              </span>
            )}
            {review && <span>By {e.enteredBy}</span>}
          </p>
          {(review || e.status !== "approved") && <StatusBadge status={e.status} className="mt-1.5" />}
        </div>
        <p className="num shrink-0 text-right font-semibold">{fmt.money(e.amount)}</p>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon" className="no-print size-10 shrink-0 text-muted-foreground" aria-label={`Actions for ${e.description}`} />}
          >
            <MoreVertical />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem className="h-10" onClick={() => setReceiptsFor(e)}>
              <Paperclip /> Receipts{e.receipts > 0 && ` (${e.receipts})`}
            </DropdownMenuItem>
            {e.canSubmit && (
              <DropdownMenuItem className="h-10" onClick={() => sendForApproval(e)}>
                <Send /> {e.status === "rejected" ? "Resubmit" : "Send for approval"}
              </DropdownMenuItem>
            )}
            {e.canReview && (
              <>
                <DropdownMenuItem className="h-10" onClick={() => setReviewing({ expense: e, decision: "approve" })}>
                  <Check /> Approve
                </DropdownMenuItem>
                <DropdownMenuItem className="h-10" onClick={() => setReviewing({ expense: e, decision: "reject" })}>
                  <X /> Reject
                </DropdownMenuItem>
              </>
            )}
            {e.canReopen && (
              <DropdownMenuItem className="h-10" onClick={() => setReopening(e)}>
                <RotateCcw /> Send back for correction
              </DropdownMenuItem>
            )}
            {e.canEdit && (
              <>
                <DropdownMenuItem className="h-10" onClick={() => setEditing(e)}>
                  <Pencil /> Edit
                </DropdownMenuItem>
                <DropdownMenuItem className="h-10" variant="destructive" onClick={() => remove(e)}>
                  <Trash2 /> Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {e.rejectionReason && e.status !== "approved" && (
        <p className="mt-2 ml-12 rounded-lg border border-over/30 bg-over/5 px-3 py-2 text-sm">
          <span className="font-semibold text-over">{e.status === "rejected" ? "Rejected" : "Previously rejected"}{e.reviewedBy ? ` by ${e.reviewedBy}` : ""}:</span> {e.rejectionReason}
        </p>
      )}
      {review && e.status === "approved" && e.reviewedBy && (
        <p className="mt-1 ml-12 text-xs text-muted-foreground">
          Approved by {e.reviewedBy}
          {e.reviewedAt && ` on ${fmt.date(e.reviewedAt.slice(0, 10))}`}
          {e.approvalNote && `: ${e.approvalNote}`}
        </p>
      )}
      {review && (e.canReview || e.canSubmit) && (
        <div className="no-print mt-2 ml-12 flex flex-wrap gap-2">
          {e.canReview && (
            <>
              <Button className="h-11 gap-1.5" onClick={() => setReviewing({ expense: e, decision: "approve" })} aria-label={`Approve ${e.description}`}>
                <Check className="size-4" aria-hidden /> Approve
              </Button>
              <Button variant="outline" className="h-11 gap-1.5 border-over/40 text-over hover:bg-over/10" onClick={() => setReviewing({ expense: e, decision: "reject" })} aria-label={`Reject ${e.description}`}>
                <X className="size-4" aria-hidden /> Reject
              </Button>
            </>
          )}
          {e.canSubmit && <SubmitButton expense={e} />}
          {e.canSubmit && e.canEdit && (
            <Button variant="outline" className="h-11 gap-1.5" onClick={() => setEditing(e)}>
              <Pencil className="size-4" aria-hidden /> {e.status === "rejected" ? "Correct" : "Edit"}
            </Button>
          )}
        </div>
      )}
    </li>
  );

  return (
    <div>
      {grouped ? (
        <div className="space-y-4">
          {groups.map(([date, items]) => (
            <section key={date} aria-label={fmt.date(date)}>
              <div className="flex items-baseline justify-between rounded-lg bg-secondary/60 px-3 py-1.5 text-sm">
                <h3 className="font-semibold">{fmt.date(date)}</h3>
                <span className="num text-muted-foreground">
                  {fmt.money(items.reduce((t, e) => t + e.amount, 0))}
                </span>
              </div>
              <ul className="divide-y">{items.map(row)}</ul>
            </section>
          ))}
        </div>
      ) : (
        <ul className="divide-y">{shown.map(row)}</ul>
      )}

      {!limit && cursor && (filters || loader) && (
        <div className="mt-4 flex flex-col items-center gap-1">
          <Button variant="outline" className="h-11 px-5" onClick={loadMore} disabled={loading}>
            {loading ? "Loading…" : "Show more"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Showing {all.length}
            {total != null ? ` of ${total}` : ""}
          </span>
        </div>
      )}

      <Sheet open={!!receiptsFor} onOpenChange={(o) => !o && setReceiptsFor(undefined)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
          {receiptsFor && (
            <>
              <SheetHeader>
                <SheetTitle>{receiptsFor.description}</SheetTitle>
                <SheetDescription>
                  {fmt.money(receiptsFor.amount)} · {fmt.date(receiptsFor.date)} · {siteName[receiptsFor.siteId] ?? "Site"}
                </SheetDescription>
              </SheetHeader>
              <div className="px-4 pb-6">
                <ReceiptsPanel
                  siteId={receiptsFor.siteId}
                  expenseId={receiptsFor.id}
                  canUpload={receiptsFor.canManageReceipts && can(sites.find((x) => x.id === receiptsFor.siteId)?.role, "expense:create")}
                />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
      <ExpenseFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(undefined)}
        expense={editing}
      />
      <ReviewDialog expense={reviewing?.expense ?? null} decision={reviewing?.decision ?? "approve"} onClose={() => setReviewing(null)} />
      <ReopenDialog expense={reopening} onClose={() => setReopening(null)} />
    </div>
  );
}
