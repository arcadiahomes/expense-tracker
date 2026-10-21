"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Check, CircleDashed, Clock, RotateCcw, Send, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Field, useSubmit } from "@/components/form-bits";
import { useFormat } from "@/lib/session";
import { EXPENSE_STATUS_LABEL, type Expense, type ExpenseStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { reopenExpenseAction, reviewExpenseAction, submitExpenseAction } from "@/server/actions/expenses";

const STATUS_STYLE: Record<ExpenseStatus, { icon: typeof Check; className: string }> = {
  draft: { icon: CircleDashed, className: "border-[var(--line)] bg-secondary text-muted-foreground" },
  pending_approval: { icon: Clock, className: "border-warn/40 bg-warn/10 text-warn" },
  approved: { icon: Check, className: "border-good/40 bg-good/10 text-good" },
  rejected: { icon: X, className: "border-over/40 bg-over/10 text-over" },
};

/** The approval state as text and icon, never colour alone. */
export function StatusBadge({ status, className }: { status: ExpenseStatus; className?: string }) {
  const { icon: Icon, className: tone } = STATUS_STYLE[status];
  return (
    <span className={cn("inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs font-semibold", tone, className)}>
      <Icon className="size-3.5" aria-hidden />
      {EXPENSE_STATUS_LABEL[status]}
    </span>
  );
}

/** Sends the user's own draft or corrected entry for approval. A second tap while sending is ignored. */
export function SubmitButton({ expense, className }: { expense: Expense; className?: string }) {
  const [pending, start] = useTransition();
  const send = useSubmit();
  return (
    <Button
      type="button"
      className={cn("h-11 gap-1.5", className)}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const saved = await send(() => submitExpenseAction(expense.id), () => {});
          if (saved) toast.success(saved.status === "approved" ? "Saved. It counts in the totals now." : "Sent for approval", { description: expense.description });
        })
      }
    >
      <Send className="size-4" aria-hidden />
      {pending ? "Sending…" : expense.status === "rejected" ? "Resubmit" : "Send for approval"}
    </Button>
  );
}

/**
 * Approve (with an optional note) or reject (a reason is required) one waiting expense.
 * The dialog says what was decided only after the server confirms it.
 */
export function ReviewDialog({ expense, decision, onClose }: { expense: Expense | null; decision: "approve" | "reject"; onClose: () => void }) {
  return (
    <Dialog open={!!expense} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">{expense && <ReviewForm key={`${expense.id}-${decision}`} expense={expense} decision={decision} onDone={onClose} />}</DialogContent>
    </Dialog>
  );
}

function ReviewForm({ expense, decision, onDone }: { expense: Expense; decision: "approve" | "reject"; onDone: () => void }) {
  const fmt = useFormat();
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const send = useSubmit();
  const reject = decision === "reject";

  function save(e: FormEvent) {
    e.preventDefault();
    if (reject && !note.trim()) {
      setErrors({ note: "Give a reason so they can correct it." });
      return;
    }
    start(async () => {
      const saved = await send(() => reviewExpenseAction({ id: expense.id, decision, note: note.trim() || undefined }), setErrors);
      if (saved) {
        toast.success(reject ? "Rejected and sent back" : "Approved. It now counts in the totals.", { description: expense.description });
        onDone();
      }
    });
  }

  return (
    <form onSubmit={save} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle className="text-lg font-semibold">{reject ? "Reject this expense?" : "Approve this expense?"}</DialogTitle>
        <DialogDescription>
          {expense.description}, {fmt.money(expense.amount)}, on {fmt.date(expense.date)}, entered by {expense.enteredBy}.
          {reject ? " They'll see your reason and can correct and resubmit it." : " It will count in the site's totals and budgets."}
        </DialogDescription>
      </DialogHeader>
      <Field id="review-note" label={reject ? "Reason (required)" : "Note (optional)"} error={errors.note}>
        <Textarea
          id="review-note"
          value={note}
          maxLength={500}
          rows={3}
          required={reject}
          aria-required={reject}
          aria-invalid={!!errors.note}
          placeholder={reject ? "e.g. Amount doesn't match the bill. Attach the receipt." : ""}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" className="h-11" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" className={cn("h-11 px-5", reject && "bg-over text-white hover:bg-over/90")} disabled={pending}>
          {pending ? "Saving…" : reject ? "Reject" : "Approve"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Sends an approved entry back to whoever entered it, with a reason. It leaves the totals until it's approved again. */
export function ReopenDialog({ expense, onClose }: { expense: Expense | null; onClose: () => void }) {
  return (
    <Dialog open={!!expense} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">{expense && <ReopenForm key={expense.id} expense={expense} onDone={onClose} />}</DialogContent>
    </Dialog>
  );
}

function ReopenForm({ expense, onDone }: { expense: Expense; onDone: () => void }) {
  const fmt = useFormat();
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const send = useSubmit();

  function save(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim()) {
      setErrors({ reason: "Say what needs correcting." });
      return;
    }
    start(async () => {
      const saved = await send(() => reopenExpenseAction({ id: expense.id, reason: reason.trim() }), setErrors);
      if (saved) {
        toast.success("Sent back for correction", { description: `${expense.description} no longer counts until it's approved again.` });
        onDone();
      }
    });
  }

  return (
    <form onSubmit={save} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle className="text-lg font-semibold">Send back for correction?</DialogTitle>
        <DialogDescription>
          {expense.description}, {fmt.money(expense.amount)}, entered by {expense.enteredBy}. It leaves the totals until they correct it and you approve it again.
        </DialogDescription>
      </DialogHeader>
      <Field id="reopen-reason" label="What needs correcting (required)" error={errors.reason}>
        <Textarea id="reopen-reason" value={reason} maxLength={500} rows={3} required aria-required aria-invalid={!!errors.reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" className="h-11" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" className="h-11 gap-1.5 px-5" disabled={pending}>
          <RotateCcw className="size-4" aria-hidden />
          {pending ? "Sending…" : "Send back"}
        </Button>
      </DialogFooter>
    </form>
  );
}
