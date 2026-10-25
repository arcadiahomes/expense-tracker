"use client";

import { useState, useTransition, type FormEvent } from "react";
import { CircleCheck, Flag, HandCoins, ReceiptText, Undo2, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PAYMENT_OPTIONS } from "@/components/expense-form-dialog";
import { Field, useSubmit } from "@/components/form-bits";
import { SelectField } from "@/components/select-field";
import { formatINRExact as exact } from "@/lib/format";
import { useSlowNotice } from "@/lib/network";
import { useSession } from "@/lib/session";
import type { ClientReceipt, PaymentMode, ReceiptStage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { recordClientPaymentAction, recordStandaloneReceiptAction, refundClientPaymentAction } from "@/server/actions/client-payments";

/** An invoice that still has something to receive, as the payment form needs it. */
export type PayableInvoice = {
  id: string;
  invoiceNo: string;
  date: string;
  client: string;
  siteName: string;
  total: number;
  paid: number;
  balance: number;
  overdue: boolean;
};

export const RECEIVED_OPTIONS = PAYMENT_OPTIONS.filter((o) => o.value !== "credit");
export const methodLabel = (m: PaymentMode) => RECEIVED_OPTIONS.find((o) => o.value === m)?.label ?? m;

/** The receipt's PDF; the route checks access again. `inline` opens it to view or print. */
export const receiptPdfHref = (id: string, inline = false) => `/api/invoices/receipts/${id}${inline ? "?inline=1" : ""}`;

export const STAGE = {
  advance: { label: "Advance payment", icon: Wallet, className: "bg-primary/10 text-primary" },
  part: { label: "Part payment", icon: HandCoins, className: "bg-warn/12 text-warn" },
  final: { label: "Final payment", icon: CircleCheck, className: "bg-good/12 text-good" },
  general: { label: "General receipt", icon: ReceiptText, className: "bg-secondary text-foreground" },
  refund: { label: "Refund", icon: Undo2, className: "bg-over/10 text-over" },
  reversal: { label: "Reversal", icon: Flag, className: "bg-over/10 text-over" },
} as const satisfies Record<ReceiptStage, unknown>;

export function StageBadge({ stage, className }: { stage: ReceiptStage; className?: string }) {
  const s = STAGE[stage];
  const Icon = s.icon;
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap", s.className, className)}>
      <Icon className="size-3.5" aria-hidden />
      {s.label}
    </span>
  );
}

/** Rupees typed in a field → paise, or null if it isn't a valid amount. Preview only: the server re-checks in SQL. */
function toPaise(v: string) {
  const clean = v.trim().replace(/,/g, "");
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(clean)) return null;
  const [r, p = ""] = clean.split(".");
  return Number(r) * 100 + Number(p.padEnd(2, "0"));
}

/** Paise → rupees as a string the server accepts, e.g. 50000050 → "500000.50". */
const fromPaise = (p: number) => `${Math.floor(p / 100)}.${String(p % 100).padStart(2, "0")}`;

/**
 * Records money received against an invoice. Shows the balance before and after, and what
 * kind of receipt it'll be, as you type. The form's clientKey is sent with every try, so a
 * double tap or a retry after a dropped connection returns the same receipt instead of a second one.
 */
export function PaymentForm({
  invoices,
  invoiceId,
  onDone,
  onCancel,
  idPrefix = "pay",
}: {
  invoices: PayableInvoice[];
  invoiceId?: string;
  onDone: (receipt: ClientReceipt) => void;
  onCancel: () => void;
  idPrefix?: string;
}) {
  const { today } = useSession();
  const send = useSubmit();
  const [pending, start] = useTransition();
  useSlowNotice(pending);
  const [clientKey] = useState(() => crypto.randomUUID());
  const [form, setForm] = useState({
    invoiceId: invoiceId ?? (invoices.length === 1 ? invoices[0].id : ""),
    amount: "",
    paidOn: today,
    method: "bank" as PaymentMode,
    reference: "",
    notes: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const inv = invoices.find((i) => i.id === form.invoiceId);

  const balance = inv ? Math.round(inv.balance * 100) : 0;
  const amount = toPaise(form.amount);
  const after = amount === null ? null : balance - amount;
  const stage: ReceiptStage | null = !inv || amount === null || amount <= 0 || (after ?? 0) < 0 ? null : after === 0 ? "final" : inv.paid > 0 ? "part" : "advance";
  const over = amount !== null && inv && amount > balance;

  function save(e: FormEvent) {
    e.preventDefault();
    if (!inv) return setErrors({ invoiceId: "Pick the invoice this payment is for." });
    start(async () => {
      const res = await send(
        () =>
          recordClientPaymentAction({
            ...form,
            amount: form.amount.replace(/,/g, ""),
            reference: form.reference || undefined,
            notes: form.notes || undefined,
            clientKey,
          }),
        setErrors,
      );
      if (res) {
        toast.success(`Receipt ${res.receiptNo} created`, {
          description: `${exact(res.amount)} from ${res.client}${(res.balanceAfter ?? 0) > 0 ? `, ${exact(res.balanceAfter!)} left` : ", invoice fully paid"}`,
          action: { label: "Download", onClick: () => window.location.assign(receiptPdfHref(res.id)) },
        });
        onDone(res);
      }
    });
  }

  return (
    <form className="grid gap-4" onSubmit={save} aria-busy={pending}>
      {!invoiceId && (
        <Field id={`${idPrefix}-invoice`} label="Invoice" error={errors.invoiceId}>
          <SelectField
            id={`${idPrefix}-invoice`}
            value={form.invoiceId || null}
            placeholder={invoices.length ? "Pick an invoice" : "No invoices with a balance"}
            onChange={(id) => set("invoiceId", id)}
            options={invoices.map((i) => ({ value: i.id, label: `${i.invoiceNo} · ${i.client} · ${i.siteName}` }))}
          />
        </Field>
      )}

      {inv && (
        <dl className="num grid grid-cols-3 gap-2 rounded-xl bg-secondary/70 p-3 text-sm">
          <div><dt className="text-xs text-muted-foreground">Invoice total</dt><dd className="font-semibold">{exact(inv.total)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Paid so far</dt><dd className="font-semibold">{exact(inv.paid)}</dd></div>
          <div><dt className={cn("text-xs", inv.overdue ? "text-over" : "text-muted-foreground")}>{inv.overdue ? "Overdue" : "Balance"}</dt><dd className="font-semibold">{exact(inv.balance)}</dd></div>
        </dl>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${idPrefix}-amount`} label="Amount received (₹)" error={errors.amount ?? (over ? `That's more than the ${exact(inv!.balance)} balance.` : undefined)}>
          <div className="flex gap-2">
            <Input
              id={`${idPrefix}-amount`}
              inputMode="decimal"
              autoComplete="off"
              className="num h-11"
              placeholder="e.g. 500000"
              aria-invalid={!!errors.amount || !!over}
              value={form.amount}
              onChange={(e) => set("amount", e.target.value.replace(/[^\d.,]/g, ""))}
            />
            <Button type="button" variant="outline" className="h-11 shrink-0" disabled={!inv || balance <= 0} onClick={() => set("amount", fromPaise(balance))}>
              Full balance
            </Button>
          </div>
        </Field>
        <Field id={`${idPrefix}-date`} label="Received on" error={errors.paidOn}>
          <Input id={`${idPrefix}-date`} type="date" max={today} min={inv?.date} className="h-11" value={form.paidOn} onChange={(e) => set("paidOn", e.target.value)} />
        </Field>
        <Field id={`${idPrefix}-method`} label="Payment method" error={errors.method}>
          <SelectField id={`${idPrefix}-method`} value={form.method} onChange={(m) => set("method", m)} options={RECEIVED_OPTIONS} />
        </Field>
        <Field id={`${idPrefix}-ref`} label="Transaction reference (optional)" error={errors.reference}>
          <Input id={`${idPrefix}-ref`} className="h-11" maxLength={120} placeholder={form.method === "cheque" ? "Cheque number" : form.method === "cash" ? "Not needed for cash" : "UTR or UPI reference"} value={form.reference} onChange={(e) => set("reference", e.target.value)} />
        </Field>
        <Field id={`${idPrefix}-notes`} label="Description (optional)" error={errors.notes} className="sm:col-span-2">
          <Textarea id={`${idPrefix}-notes`} rows={2} maxLength={500} placeholder="e.g. Second installment, after slab work" value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </div>

      {inv && stage && after !== null && (
        <div aria-live="polite" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/25 bg-primary/5 p-3 text-sm">
          <StageBadge stage={stage} />
          <span>
            Balance after this payment: <span className="num font-semibold">{exact(after / 100)}</span>
          </span>
        </div>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" className="h-11" onClick={onCancel} disabled={pending}>Cancel</Button>
        <Button type="submit" className="h-11 px-5" disabled={pending || !inv || !stage}>
          {pending ? "Saving…" : "Record payment"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Each payment gets its own numbered receipt. Client payments are income: they aren&rsquo;t added to the site&rsquo;s expenses.</p>
    </form>
  );
}

/**
 * Records money received without an invoice (a token advance, a deposit, a one-off job) as a
 * general receipt on one site, numbered in the same series as every other receipt. Like
 * PaymentForm, its clientKey makes a retry return the same receipt.
 */
export function StandaloneReceiptForm({
  sites,
  onDone,
  onCancel,
}: {
  sites: { id: string; name: string }[];
  onDone: (receipt: ClientReceipt) => void;
  onCancel: () => void;
}) {
  const { today } = useSession();
  const send = useSubmit();
  const [pending, start] = useTransition();
  useSlowNotice(pending);
  const [clientKey] = useState(() => crypto.randomUUID());
  const [form, setForm] = useState({
    siteId: sites.length === 1 ? sites[0].id : "",
    receivedFrom: "",
    amount: "",
    paidOn: today,
    method: "bank" as PaymentMode,
    reference: "",
    notes: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const amount = toPaise(form.amount);

  function save(e: FormEvent) {
    e.preventDefault();
    if (!form.siteId) return setErrors({ siteId: "Pick the project this money is for." });
    start(async () => {
      const res = await send(
        () =>
          recordStandaloneReceiptAction({
            ...form,
            amount: form.amount.replace(/,/g, ""),
            reference: form.reference || undefined,
            notes: form.notes || undefined,
            clientKey,
          }),
        setErrors,
      );
      if (res) {
        toast.success(`Receipt ${res.receiptNo} created`, {
          description: `${exact(res.amount)} from ${res.client}`,
          action: { label: "Download", onClick: () => window.location.assign(receiptPdfHref(res.id)) },
        });
        onDone(res);
      }
    });
  }

  return (
    <form className="grid gap-4" onSubmit={save} aria-busy={pending}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="gr-site" label="Project" error={errors.siteId}>
          <SelectField id="gr-site" value={form.siteId || null} placeholder="Pick a project" onChange={(id) => set("siteId", id)} options={sites.map((s) => ({ value: s.id, label: s.name }))} />
        </Field>
        <Field id="gr-from" label="Received from" error={errors.receivedFrom}>
          <Input id="gr-from" className="h-11" maxLength={200} autoComplete="off" placeholder="Name of the person or company" value={form.receivedFrom} onChange={(e) => set("receivedFrom", e.target.value)} />
        </Field>
        <Field id="gr-amount" label="Amount received (₹)" error={errors.amount}>
          <Input id="gr-amount" inputMode="decimal" autoComplete="off" className="num h-11" placeholder="e.g. 25000" aria-invalid={!!errors.amount} value={form.amount} onChange={(e) => set("amount", e.target.value.replace(/[^\d.,]/g, ""))} />
        </Field>
        <Field id="gr-date" label="Received on" error={errors.paidOn}>
          <Input id="gr-date" type="date" max={today} className="h-11" value={form.paidOn} onChange={(e) => set("paidOn", e.target.value)} />
        </Field>
        <Field id="gr-method" label="Payment method" error={errors.method}>
          <SelectField id="gr-method" value={form.method} onChange={(m) => set("method", m)} options={RECEIVED_OPTIONS} />
        </Field>
        <Field id="gr-ref" label="Transaction reference (optional)" error={errors.reference}>
          <Input id="gr-ref" className="h-11" maxLength={120} placeholder={form.method === "cheque" ? "Cheque number" : form.method === "cash" ? "Not needed for cash" : "UTR or UPI reference"} value={form.reference} onChange={(e) => set("reference", e.target.value)} />
        </Field>
        <Field id="gr-notes" label="What it's for (optional)" error={errors.notes} className="sm:col-span-2">
          <Textarea id="gr-notes" rows={2} maxLength={500} placeholder="e.g. Token advance for kitchen work" value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" className="h-11" onClick={onCancel} disabled={pending}>Cancel</Button>
        <Button type="submit" className="h-11 px-5" disabled={pending || !form.siteId || !form.receivedFrom.trim() || amount === null || amount <= 0}>
          {pending ? "Saving…" : "Create receipt"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">A general receipt isn&rsquo;t tied to an invoice, so it doesn&rsquo;t change any invoice balance or the project&rsquo;s collections. It&rsquo;s income: it isn&rsquo;t added to the site&rsquo;s expenses.</p>
    </form>
  );
}

/**
 * Gives money back against one payment as a new linked record: a refund (any part of what's
 * left of it) or a reversal (all of it, e.g. a bounced cheque). The original receipt stays.
 */
export function RefundForm({ payment, onDone, onCancel }: { payment: ClientReceipt; onDone: (record: ClientReceipt) => void; onCancel: () => void }) {
  const { today } = useSession();
  const send = useSubmit();
  const [pending, start] = useTransition();
  useSlowNotice(pending);
  const [clientKey] = useState(() => crypto.randomUUID());
  const left = Math.round((payment.amount - payment.refunded) * 100);
  const canReverse = payment.refunded === 0;
  const [form, setForm] = useState({ kind: (canReverse ? "reversal" : "refund") as "refund" | "reversal", amount: "", paidOn: today, method: payment.method, reference: "", reason: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const amount = form.kind === "reversal" ? left : toPaise(form.amount);
  const over = amount !== null && amount > left;

  function save(e: FormEvent) {
    e.preventDefault();
    start(async () => {
      const res = await send(
        () =>
          refundClientPaymentAction({
            paymentId: payment.id,
            kind: form.kind,
            amount: form.kind === "refund" ? form.amount.replace(/,/g, "") : undefined,
            paidOn: form.paidOn,
            method: form.method,
            reference: form.reference || undefined,
            reason: form.reason,
            clientKey,
          }),
        setErrors,
      );
      if (res) {
        toast.success(`${res.kind === "reversal" ? "Reversal" : "Refund"} ${res.receiptNo} recorded`, {
          description: `${exact(res.amount)} against ${payment.receiptNo}${res.balanceAfter === null ? "" : `; ${exact(res.balanceAfter)} now to receive`}`,
        });
        onDone(res);
      }
    });
  }

  return (
    <form className="grid gap-3 rounded-xl bg-over/6 p-4" onSubmit={save} aria-busy={pending}>
      <p className="text-sm font-medium">Give money back against {payment.receiptNo}</p>
      <Field id="rf-kind" label="What happened">
        <SelectField
          id="rf-kind"
          value={form.kind}
          onChange={(k) => set("kind", k)}
          options={[
            ...(canReverse ? [{ value: "reversal" as const, label: "Reverse the whole payment (bounced, entered twice)" }] : []),
            { value: "refund" as const, label: "Refund part or all of it to the client" },
          ]}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        {form.kind === "refund" ? (
          <Field id="rf-amount" label="Amount refunded (₹)" error={errors.amount ?? (over ? `At most ${exact(left / 100)}.` : undefined)} hint={`Up to ${exact(left / 100)}`}>
            <Input id="rf-amount" inputMode="decimal" className="num h-11" aria-invalid={!!errors.amount || over} value={form.amount} onChange={(e) => set("amount", e.target.value.replace(/[^\d.,]/g, ""))} />
          </Field>
        ) : (
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">Amount reversed</span>
            <span className="num flex h-11 items-center font-semibold">{exact(left / 100)}</span>
          </div>
        )}
        <Field id="rf-date" label="Date" error={errors.paidOn}>
          <Input id="rf-date" type="date" min={payment.date} max={today} className="h-11" value={form.paidOn} onChange={(e) => set("paidOn", e.target.value)} />
        </Field>
        {form.kind === "refund" && (
          <>
            <Field id="rf-method" label="Refunded by" error={errors.method}>
              <SelectField id="rf-method" value={form.method} onChange={(m) => set("method", m)} options={RECEIVED_OPTIONS} />
            </Field>
            <Field id="rf-ref" label="Reference (optional)" error={errors.reference}>
              <Input id="rf-ref" className="h-11" maxLength={120} value={form.reference} onChange={(e) => set("reference", e.target.value)} />
            </Field>
          </>
        )}
      </div>
      <Field id="rf-reason" label="Reason" error={errors.reason}>
        <Textarea id="rf-reason" rows={2} maxLength={500} placeholder={form.kind === "reversal" ? "e.g. Cheque 004512 bounced" : "e.g. Wardrobe scope reduced by agreement"} value={form.reason} onChange={(e) => set("reason", e.target.value)} />
      </Field>
      <p className="text-xs text-muted-foreground">This adds a linked {form.kind} record with its own number. Receipt {payment.receiptNo} is kept as it is.</p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" className="h-11" onClick={onCancel} disabled={pending}>Back</Button>
        <Button type="submit" variant="destructive" className="h-11 px-5" disabled={pending || !form.reason.trim() || amount === null || amount <= 0 || over}>
          {pending ? "Saving…" : form.kind === "reversal" ? "Reverse payment" : "Record refund"}
        </Button>
      </div>
    </form>
  );
}
