"use client";

import { useState, useTransition, type FormEvent } from "react";
import { AlertTriangle, CircleCheck, OctagonAlert, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, useSubmit } from "@/components/form-bits";
import { Panel } from "@/components/panel";
import { SelectField } from "@/components/select-field";
import { CATEGORY_META } from "@/lib/categories";
import { useFormat } from "@/lib/session";
import { CATEGORIES, type Category } from "@/lib/types";
import { removeBudgetAction, upsertBudgetAction } from "@/server/actions/sites";
import type { BudgetLineUsage } from "@/server/data/analytics";
import { cn } from "@/lib/utils";

const n = (v: string | number | null | undefined) => Number(v ?? 0);
const LEVEL = {
  ok: { icon: CircleCheck, text: "text-muted-foreground", label: "Within budget" },
  warning: { icon: AlertTriangle, text: "text-warn", label: "Past alert threshold" },
  over: { icon: OctagonAlert, text: "text-over", label: "Over budget" },
} as const;

/** Total and category budgets for one site, with alert thresholds. Editing is for owners and accountants. */
export function BudgetPanel({ siteId, lines, canManage }: { siteId: string; lines: BudgetLineUsage[]; canManage: boolean }) {
  const fmt = useFormat();
  const [editing, setEditing] = useState<{ category: Category | null; line?: BudgetLineUsage } | null>(null);
  const unbudgeted = CATEGORIES.filter((c) => !lines.some((l) => l.category === c));
  const categoryTotal = lines.filter((l) => l.category).reduce((t, l) => t + n(l.budget), 0);
  const total = lines.find((l) => !l.category);

  return (
    <Panel
      title="Budgets"
      description="Spent and committed against each line; alerts fire at the threshold you set"
      action={
        canManage && unbudgeted.length > 0 && (
          <Button variant="outline" className="h-10" onClick={() => setEditing({ category: unbudgeted[0] })}>
            <Plus aria-hidden /> Category budget
          </Button>
        )
      }
    >
      {!total && canManage && (
        <Button variant="outline" className="mb-3 h-10" onClick={() => setEditing({ category: null })}>
          <Plus aria-hidden /> Set total budget
        </Button>
      )}
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">No budget set for this site yet.</p>
      ) : (
        <ul className="divide-y">
          {lines.map((l) => {
            const meta = LEVEL[l.level];
            const Icon = meta.icon;
            const used = Math.round(l.utilisation * 100);
            return (
              <li key={l.category ?? "total"} className="grid gap-2 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="min-w-0">
                  <p className="font-medium">{l.category ? CATEGORY_META[l.category].label : "Total budget"}</p>
                  <p className="text-xs text-muted-foreground">
                    {fmt.money(n(l.spent))} spent of {fmt.money(n(l.budget))}
                    {n(l.committed) > 0 && ` · ${fmt.money(n(l.committed))} committed`} · {n(l.remaining) >= 0 ? `${fmt.money(n(l.remaining))} left` : `${fmt.money(-n(l.remaining))} over`}
                  </p>
                  <div className="mt-1.5 h-2 rounded-full bg-muted" role="meter" aria-label={`${l.category ? CATEGORY_META[l.category].label : "Total"} budget used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(used, 100)} aria-valuetext={`${used}% used, ${meta.label.toLowerCase()}, alert at ${l.alertPercent}%`}>
                    <div
                      className={cn("relative h-full rounded-full", l.level === "over" ? "bg-over" : l.level === "warning" ? "bg-warn" : "brand-fill")}
                      style={{ width: `${Math.min(used, 100)}%` }}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2 sm:justify-end">
                  <span className={cn("inline-flex items-center gap-1 text-xs font-medium", meta.text)}>
                    <Icon className="size-3.5" aria-hidden /> {used}% · alert {l.alertPercent}%
                  </span>
                  {canManage && (
                    <Button variant="ghost" size="icon" className="size-10" aria-label={`Edit ${l.category ?? "total"} budget`} onClick={() => setEditing({ category: l.category, line: l })}>
                      <Pencil aria-hidden />
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {total && categoryTotal > n(total.budget) && (
        <p className="mt-2 text-xs text-warn">Category budgets add up to {fmt.money(categoryTotal)}, more than the total budget of {fmt.money(n(total.budget))}.</p>
      )}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          {editing && <BudgetForm siteId={siteId} initial={editing} available={unbudgeted} onDone={() => setEditing(null)} />}
        </DialogContent>
      </Dialog>
    </Panel>
  );
}

function BudgetForm({
  siteId,
  initial,
  available,
  onDone,
}: {
  siteId: string;
  initial: { category: Category | null; line?: BudgetLineUsage };
  available: Category[];
  onDone: () => void;
}) {
  const submit = useSubmit();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [category, setCategory] = useState(initial.category);
  const [amount, setAmount] = useState(initial.line ? String(n(initial.line.budget)) : "");
  const [alertPercent, setAlert] = useState(String(initial.line?.alertPercent ?? 80));
  const isNew = !initial.line;

  function save(e: FormEvent) {
    e.preventDefault();
    start(async () => {
      if (await submit(() => upsertBudgetAction({ siteId, categoryCode: category, amount, alertPercent }), setErrors)) {
        toast.success("Budget saved");
        onDone();
      }
    });
  }

  function remove() {
    if (!category) return;
    start(async () => {
      if (await submit(() => removeBudgetAction({ siteId, categoryCode: category }), setErrors)) {
        toast.success("Category budget removed");
        onDone();
      }
    });
  }

  return (
    <form onSubmit={save} className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="text-lg font-semibold">{category ? `${CATEGORY_META[category].label} budget` : "Total budget"}</DialogTitle>
        <DialogDescription>An alert shows on the dashboard once spending reaches the threshold, and again when it goes over.</DialogDescription>
      </DialogHeader>
      {isNew && category && (
        <Field id="b-cat" label="Category">
          <SelectField id="b-cat" value={category} onChange={setCategory} options={available.map((c) => ({ value: c, label: CATEGORY_META[c].label }))} />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field id="b-amount" label="Budget (₹)" error={errors.amount}>
          <Input id="b-amount" inputMode="decimal" className="num h-11" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
        </Field>
        <Field id="b-alert" label="Alert at (%)" error={errors.alertPercent}>
          <Input id="b-alert" type="number" min={1} max={100} inputMode="numeric" className="num h-11" value={alertPercent} onChange={(e) => setAlert(e.target.value)} />
        </Field>
      </div>
      <DialogFooter className="sm:justify-between">
        {!isNew && category ? (
          <Button type="button" variant="ghost" className="h-11 text-over" onClick={remove} disabled={pending}>
            <Trash2 aria-hidden /> Remove
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" className="h-11 px-5" disabled={pending || !amount}>{pending ? "Saving…" : "Save budget"}</Button>
      </DialogFooter>
    </form>
  );
}
