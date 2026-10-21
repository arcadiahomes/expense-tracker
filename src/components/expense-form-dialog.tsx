"use client";

import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectField } from "@/components/select-field";
import { CATEGORY_META } from "@/lib/categories";
import { can } from "@/lib/permissions";
import { useDefaultWritableSiteId, useFormat, useSession, useWritableSites } from "@/lib/session";
import { createExpenseAction, updateExpenseAction } from "@/server/actions/expenses";
import { uploadReceiptAction } from "@/server/actions/receipts";
import { FilePickers } from "@/components/receipts-panel";
import { useSlowNotice, useSubmitGuard } from "@/lib/network";
import { CATEGORIES, type Category, type Expense, type PaymentMode } from "@/lib/types";
import { cn } from "@/lib/utils";

export const PAYMENT_OPTIONS: { value: PaymentMode; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "bank", label: "Bank transfer" },
  { value: "cheque", label: "Cheque" },
  { value: "credit", label: "On credit" },
];

const UNITS = ["nos", "bags", "t", "kg", "loads", "units", "trips", "hrs", "days", "L", "sq ft", "lot"];

/** Category picker as large tappable chips. */
export function CategoryPicker({
  value,
  onChange,
  name,
}: {
  value: Category;
  onChange: (c: Category) => void;
  name: string;
}) {
  return (
    <div role="radiogroup" aria-label="Category" className="flex flex-wrap gap-2">
      {CATEGORIES.map((c) => {
        const meta = CATEGORY_META[c];
        const Icon = meta.icon;
        const checked = value === c;
        return (
          <label
            key={c}
            className={cn(
              "inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border px-3.5 text-sm transition-colors has-focus-visible:outline-2 has-focus-visible:outline-ring",
              checked
                ? "brand-fill border-transparent shadow-[0_6px_14px_-8px_rgb(4_120_87/0.7)]"
                : "border-[var(--line)] bg-card hover:border-primary/40 hover:bg-secondary",
            )}
          >
            <input
              type="radio"
              name={name}
              value={c}
              checked={checked}
              onChange={() => onChange(c)}
              className="sr-only"
            />
            <Icon className="size-4" style={checked ? undefined : { color: meta.color }} aria-hidden />
            {meta.label}
          </label>
        );
      })}
    </div>
  );
}

export function ExpenseFormDialog({
  open,
  onOpenChange,
  expense,
  defaultSiteId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when editing. */
  expense?: Expense;
  defaultSiteId?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        {open && (
          <ExpenseForm
            expense={expense}
            defaultSiteId={defaultSiteId}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type Line = { description: string; quantity: string; unit: string; unitPrice: string };

const blankLine = (): Line => ({ description: "", quantity: "1", unit: "nos", unitPrice: "" });

/** Preview only: quantity × rate in paise, mirroring the database's round(q × p, 2). */
function lineTotal(l: Line) {
  const q = Number(l.quantity);
  const p = Number(l.unitPrice);
  if (!Number.isFinite(q) || !Number.isFinite(p)) return 0;
  return Math.round(q * p * 100) / 100;
}

function ExpenseForm({
  expense,
  defaultSiteId,
  onDone,
}: {
  expense?: Expense;
  defaultSiteId?: string;
  onDone: () => void;
}) {
  const { today, workers, suppliers, sites } = useSession();
  const fmt = useFormat();
  const writable = useWritableSites();
  // Editing an expense on a completed site keeps that site selectable.
  const own = expense ? sites.find((s) => s.id === expense.siteId) : undefined;
  const siteChoices = own && !writable.includes(own) ? [own, ...writable] : writable;
  const activeDefault = useDefaultWritableSiteId();
  const [siteId, setSiteId] = useState(expense?.siteId ?? defaultSiteId ?? (activeDefault || siteChoices[0]?.id) ?? "");
  const [date, setDate] = useState(expense?.date ?? today);
  const [category, setCategory] = useState<Category>(expense?.category ?? "materials");
  const [description, setDescription] = useState(expense?.description ?? "");
  const [worker, setWorker] = useState(expense?.worker ?? "");
  const [supplier, setSupplier] = useState(expense?.supplier ?? "");
  const [paymentMode, setPaymentMode] = useState<PaymentMode>(expense?.paymentMode ?? "cash");
  const [lines, setLines] = useState<Line[]>(() =>
    expense?.items.length
      ? expense.items.map((i) => ({
          description: i.description,
          quantity: i.quantity.replace(/\.?0+$/, ""),
          unit: i.unit,
          unitPrice: i.unitPrice,
        }))
      : [blankLine()],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const guard = useSubmitGuard();
  useSlowNotice(pending);
  /** A receipt picked while adding an expense; uploaded once the expense exists. */
  const [receipt, setReceipt] = useState<{ file: File; source: "camera" | "file" } | null>(null);

  // An assistant engineer's entry is a draft or goes for approval; nobody else's waits.
  const role = sites.find((s) => s.id === siteId)?.role;
  const needsApproval = can(role, "expense:create") && !can(role, "expense:direct");

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const total = lines.reduce((t, l) => t + lineTotal(l), 0);

  function submit(e: FormEvent) {
    e.preventDefault();
    // "Save draft" and "Send for approval" are both submit buttons; Enter sends nothing for approval.
    const intent = ((e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value;
    const payload = {
      ...(expense ? { id: expense.id } : {}),
      siteId,
      expenseDate: date,
      categoryCode: category,
      description: description.trim(),
      paymentMethod: paymentMode,
      workerName: category === "labour" ? worker.trim() || undefined : undefined,
      supplierName: category !== "labour" ? supplier.trim() || undefined : undefined,
      items: lines.map((l) => ({
        description: l.description.trim() || description.trim(),
        quantity: l.quantity || "1",
        unit: l.unit.trim() || "nos",
        unitPrice: l.unitPrice,
      })),
      submit: needsApproval && intent === "send",
    };
    // Ignores a second tap while saving, so a slow network can't add the expense twice.
    void guard(
      () =>
        new Promise<void>((done) =>
          start(async () => {
            try {
              await persist(payload);
            } catch {
              toast.error("Couldn't reach the server, so we can't confirm this was saved. Check the list before trying again.");
            } finally {
              done();
            }
          }),
        ),
    );
  }

  async function persist(payload: Parameters<typeof createExpenseAction>[0]) {
    const res = expense ? await updateExpenseAction(payload) : await createExpenseAction(payload);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      toast.error(res.error);
      return;
    }
    if (receipt && !expense) {
      const form = new FormData();
      form.set("file", receipt.file);
      form.set("siteId", res.data.siteId);
      form.set("expenseId", res.data.id);
      form.set("captureSource", receipt.source);
      const up = await uploadReceiptAction(form).catch(() => null);
      if (!up?.ok) {
        // The expense is saved either way; say so, and how to retry the file.
        toast.warning("Expense added, but the receipt wasn't attached", { description: up ? up.error : "Connection lost. Attach it from the expense's Receipts menu." });
        onDone();
        return;
      }
      if (up.data.duplicate) toast.warning("Receipt attached, but it may be a duplicate", { description: up.data.duplicate.reason });
    }
    const saved =
      res.data.status === "pending_approval"
        ? "Sent for approval"
        : res.data.status === "draft"
          ? "Draft saved. Send it for approval when it's ready."
          : res.data.status === "rejected"
            ? "Correction saved. Resubmit it when it's ready."
            : expense
              ? "Expense updated"
              : "Expense added";
    toast.success(saved, { description: res.data.description });
    onDone();
  }

  const siteOptions = siteChoices.map((s) => ({ value: s.id, label: s.name }));
  const lineError = (i: number, f: keyof Line) => errors[`items.${i}.${f}`];

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="font-display text-xl font-bold">
          {expense ? "Edit expense" : "Add expense"}
        </DialogTitle>
        <DialogDescription>
          {needsApproval
            ? "It counts in the site's totals once a site owner approves it."
            : expense
              ? "Changes are saved to this site's history."
              : "Log a payment made at site."}
        </DialogDescription>
      </DialogHeader>

      {siteOptions.length === 0 ? (
        <p role="alert" className="rounded-lg bg-secondary/70 p-3 text-sm">
          You don&rsquo;t have permission to add expenses on any active site. Ask the site owner to invite you as an engineer.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Site" htmlFor="exp-site" error={errors.siteId}>
            <SelectField id="exp-site" value={siteId} onChange={setSiteId} options={siteOptions} placeholder="Choose site" />
          </Field>
          <Field label="Date" htmlFor="exp-date" error={errors.expenseDate}>
            <Input id="exp-date" type="date" max={today} className="h-11" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
      )}

      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">Category</legend>
        <CategoryPicker name="exp-category" value={category} onChange={setCategory} />
      </fieldset>

      <Field label="What was it for?" htmlFor="exp-desc" error={errors.description}>
        <Input id="exp-desc" className="h-11" placeholder="e.g. UltraTech cement" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>

      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">Quantity and rate</legend>
        {lines.map((l, i) => (
          <div key={i} className="grid gap-2 rounded-lg border border-[var(--line)] p-3">
            {lines.length > 1 && (
              <div className="flex items-center gap-2">
                <Input
                  aria-label={`Line ${i + 1} description`}
                  className="h-10"
                  placeholder={`Line ${i + 1}, e.g. 12 mm TMT`}
                  value={l.description}
                  onChange={(e) => setLine(i, { description: e.target.value })}
                />
                <Button type="button" variant="ghost" size="icon" className="size-10 shrink-0" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                  <Trash2 aria-hidden />
                </Button>
              </div>
            )}
            <div className="grid grid-cols-[1fr_1fr_1.3fr] gap-2">
              <Field label="Quantity" htmlFor={`exp-qty-${i}`} error={lineError(i, "quantity")}>
                <Input id={`exp-qty-${i}`} inputMode="decimal" className="num h-11" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value.replace(/[^\d.]/g, "") })} />
              </Field>
              <Field label="Unit" htmlFor={`exp-unit-${i}`} error={lineError(i, "unit")}>
                <Input id={`exp-unit-${i}`} list="units" className="h-11" value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })} />
              </Field>
              <Field label="Rate (₹ per unit)" htmlFor={`exp-rate-${i}`} error={lineError(i, "unitPrice")}>
                <Input id={`exp-rate-${i}`} inputMode="decimal" className="num h-11 font-semibold" placeholder="0" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value.replace(/[^\d.]/g, "") })} />
              </Field>
            </div>
          </div>
        ))}
        <div className="flex items-center justify-between">
          <Button type="button" variant="ghost" className="h-10" onClick={() => setLines((ls) => [...ls, blankLine()])}>
            <Plus aria-hidden /> Add line item
          </Button>
          <p className="text-sm">
            Total <span className="num font-display text-lg font-bold">{fmt.money(total)}</span>
          </p>
        </div>
        {errors.items && <p className="text-xs text-over" role="alert">{errors.items}</p>}
      </fieldset>
      <datalist id="units">{UNITS.map((u) => <option key={u} value={u} />)}</datalist>

      <div className="grid gap-4 sm:grid-cols-2">
        {category === "labour" ? (
          <Field label="Worker or gang" htmlFor="exp-worker" optional error={errors.workerName}>
            <Input id="exp-worker" list="workers" className="h-11" value={worker} onChange={(e) => setWorker(e.target.value)} />
          </Field>
        ) : (
          <Field label="Supplier" htmlFor="exp-supplier" optional error={errors.supplierName}>
            <Input id="exp-supplier" list="suppliers" className="h-11" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
          </Field>
        )}
        <Field label="Paid by" htmlFor="exp-mode">
          <SelectField id="exp-mode" value={paymentMode} onChange={setPaymentMode} options={PAYMENT_OPTIONS} />
        </Field>
      </div>
      {!expense && (
        <div className="grid gap-1.5">
          <p className="text-sm font-medium">
            Receipt <span className="font-normal text-muted-foreground">(optional)</span>
          </p>
          {receipt ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border p-2.5 text-sm">
              <span className="min-w-0 truncate">{receipt.file.name}</span>
              <Button type="button" variant="ghost" size="sm" className="h-9" onClick={() => setReceipt(null)}>Remove</Button>
            </div>
          ) : (
            <FilePickers onPick={(file, source) => setReceipt({ file, source })} disabled={pending} label="Choose file" />
          )}
        </div>
      )}
      <datalist id="workers">{workers.map((w) => <option key={w} value={w} />)}</datalist>
      <datalist id="suppliers">{suppliers.map((s) => <option key={s} value={s} />)}</datalist>

      <DialogFooter>
        <Button type="button" variant="outline" className="h-11" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        {needsApproval ? (
          <>
            <Button type="submit" name="intent" value="draft" variant="outline" className="h-11 px-5" disabled={pending || siteOptions.length === 0}>
              {pending ? "Saving…" : expense ? "Save changes" : "Save draft"}
            </Button>
            <Button type="submit" name="intent" value="send" className="h-11 px-5" disabled={pending || siteOptions.length === 0}>
              {pending ? "Sending…" : expense?.status === "rejected" ? "Save and resubmit" : "Send for approval"}
            </Button>
          </>
        ) : (
          <Button type="submit" className="h-11 px-5" disabled={pending || siteOptions.length === 0}>
            {pending ? "Saving…" : expense ? "Save changes" : "Add expense"}
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}

export function Field({
  label,
  htmlFor,
  error,
  optional,
  children,
}: {
  label: ReactNode;
  htmlFor: string;
  error?: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
        {optional && <span className="font-normal text-muted-foreground"> (optional)</span>}
      </Label>
      {children}
      {error && (
        <p className="text-xs text-over" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
