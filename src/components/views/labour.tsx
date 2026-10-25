"use client";

import { useEffect, useState, useTransition, type FormEvent } from "react";
import { HandCoins, HardHat, NotebookText, Pencil, Plus, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PAYMENT_OPTIONS } from "@/components/expense-form-dialog";
import { Field, Stat, useSubmit } from "@/components/form-bits";
import { PageHeader } from "@/components/page-header";
import { SelectField } from "@/components/select-field";
import { SitePicker } from "@/components/site-picker";
import { EmptyState } from "@/components/states";
import { can } from "@/lib/permissions";
import { useFormat, useSession } from "@/lib/session";
import type { PaymentMode } from "@/lib/types";
import { deleteExpenseAction, restoreExpenseAction } from "@/server/actions/expenses";
import { createWorkerAction, loadWorkerPaymentsAction, recordLabourPaymentAction, updateWorkerAction } from "@/server/actions/labour";
import type { WorkerPayment, WorkerTotal } from "@/server/data/labour";
import { cn } from "@/lib/utils";

type Worker = { id: string; name: string; trade: string | null; phone: string | null; dailyWage: string | null; active: boolean };
type Totals = { workers: WorkerTotal[]; totals: { total: string; thisMonth: string; workers: number } };

export function LabourView({ siteId, totals, workers }: { siteId: string; totals: Totals; workers: Worker[] }) {
  const { sites } = useSession();
  const fmt = useFormat();
  const site = sites.find((s) => s.id === siteId);
  const canWrite = site?.status !== "completed" && can(site?.role, "expense:create");
  const [paying, setPaying] = useState<{ workerId: string | null } | null>(null);
  const [statement, setStatement] = useState<WorkerTotal | null>(null);
  const [editing, setEditing] = useState<Worker | "new" | null>(null);
  const payable = workers.filter((w) => w.active);
  // Sorted by total, so the first worker sets the scale of the bars.
  const top = Number(totals.workers[0]?.total ?? 0);

  return (
    <>
      <PageHeader
        title="Labour"
        description="Record what you pay each worker. Every payment is saved as a labour expense, and each worker's total adds up here."
        actions={
          canWrite && (
            <>
              <Button variant="outline" className="h-11" onClick={() => setEditing("new")}>
                <UserPlus aria-hidden /> Add worker
              </Button>
              <Button className="h-11" disabled={!payable.length} onClick={() => setPaying({ workerId: null })}>
                <HandCoins aria-hidden /> Add payment
              </Button>
            </>
          )
        }
      />
      <SitePicker siteId={siteId} className="mb-5" />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Total paid to labour" value={fmt.money(Number(totals.totals.total))} hint="Labour expenses naming a worker" />
        <Stat label="This month" value={fmt.money(Number(totals.totals.thisMonth))} />
        <Stat label="Workers paid" value={totals.totals.workers} />
      </div>

      <Tabs defaultValue="totals">
        <TabsList className="h-11!">
          <TabsTrigger value="totals" className="px-3">Worker totals</TabsTrigger>
          <TabsTrigger value="workers" className="px-3">Workers</TabsTrigger>
        </TabsList>

        <TabsContent value="totals" className="mt-3">
          {totals.workers.length === 0 ? (
            <EmptyState icon={HardHat} title="No workers yet" description="Add workers, then record what you pay them." />
          ) : (
            <ul className="surface divide-y rounded-xl">
              {totals.workers.map((w) => (
                <li key={w.workerId} className="grid gap-2 px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4">
                  <div className="min-w-0">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="truncate font-semibold">{w.name}</p>
                      <p className="num font-display text-lg font-bold">{fmt.money(Number(w.total))}</p>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden>
                      <div className="brand-fill h-full rounded-full" style={{ width: `${top > 0 ? (Number(w.total) / top) * 100 : 0}%` }} />
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {[
                        w.trade,
                        `${w.payments} ${w.payments === 1 ? "payment" : "payments"}`,
                        Number(w.thisMonth) > 0 && `${fmt.money(Number(w.thisMonth))} this month`,
                        w.lastPaid && `last paid ${fmt.date(w.lastPaid)}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {canWrite && w.active && (
                      <Button size="sm" className="h-10" onClick={() => setPaying({ workerId: w.workerId })}>
                        <HandCoins aria-hidden /> Pay
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" className="h-10" disabled={!w.payments} onClick={() => setStatement(w)}>
                      <NotebookText aria-hidden /> Payments
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="workers" className="mt-3">
          {workers.length === 0 ? (
            <EmptyState icon={UserPlus} title="No workers yet" action={canWrite && <Button className="h-11" onClick={() => setEditing("new")}><Plus aria-hidden /> Add worker</Button>} />
          ) : (
            <ul className="surface divide-y rounded-xl">
              {workers.map((w) => (
                <li key={w.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className={cn("font-medium", !w.active && "text-muted-foreground")}>{w.name}{!w.active && " (inactive)"}</p>
                    <p className="text-xs text-muted-foreground">{[w.trade, w.phone].filter(Boolean).join(" · ") || "No details"}</p>
                  </div>
                  {canWrite && (
                    <Button variant="ghost" size="icon" className="size-10" aria-label={`Edit ${w.name}`} onClick={() => setEditing(w)}>
                      <Pencil aria-hidden />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={!!paying} onOpenChange={(o) => !o && setPaying(null)}>
        <DialogContent className="sm:max-w-md">{paying && <PayForm siteId={siteId} workers={payable} workerId={paying.workerId} onDone={() => setPaying(null)} />}</DialogContent>
      </Dialog>
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-md">{editing && <WorkerForm worker={editing === "new" ? null : editing} onDone={() => setEditing(null)} />}</DialogContent>
      </Dialog>
      <Sheet open={!!statement} onOpenChange={(o) => !o && setStatement(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">{statement && <Payments siteId={siteId} worker={statement} canWrite={canWrite} />}</SheetContent>
      </Sheet>
    </>
  );
}

/** A payment to a worker, saved as a labour expense. Without a preselected worker it asks for one. */
function PayForm({ siteId, workers, workerId: preselected, onDone }: { siteId: string; workers: Worker[]; workerId: string | null; onDone: () => void }) {
  const submit = useSubmit();
  const { today } = useSession();
  const fmt = useFormat();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [workerId, setWorkerId] = useState(preselected);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMode>("cash");
  const [paidOn, setPaidOn] = useState(today);
  const [note, setNote] = useState("");
  const worker = workers.find((w) => w.id === workerId);

  function save(e: FormEvent) {
    e.preventDefault();
    if (!workerId) return;
    start(async () => {
      const res = await submit(() => recordLabourPaymentAction({ siteId, workerId, kind: "wage", amount, method, paidOn, note: note || undefined }), setErrors);
      if (res) {
        toast.success(`${fmt.money(Number(amount))} to ${worker?.name ?? "the worker"} saved`);
        onDone();
      }
    });
  }

  return (
    <form onSubmit={save} className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="text-lg font-semibold">{preselected && worker ? `Pay ${worker.name}` : "Add labour payment"}</DialogTitle>
        <DialogDescription>This is saved as a labour expense on this site.</DialogDescription>
      </DialogHeader>
      {!preselected && (
        <Field id="pay-worker" label="Worker" error={errors.workerId}>
          <SelectField id="pay-worker" value={workerId} onChange={setWorkerId} placeholder="Choose a worker" options={workers.map((w) => ({ value: w.id, label: w.trade ? `${w.name} (${w.trade})` : w.name }))} />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field id="pay-amount" label="Amount (₹)" error={errors.amount}>
          <Input id="pay-amount" inputMode="decimal" className="num h-11 text-base font-semibold" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
        </Field>
        <Field id="pay-date" label="Date" error={errors.paidOn}>
          <Input id="pay-date" type="date" className="h-11" max={today} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
      </div>
      <Field id="pay-method" label="Paid by" error={errors.method}>
        <SelectField id="pay-method" value={method} onChange={setMethod} options={PAYMENT_OPTIONS.filter((o) => o.value !== "credit")} />
      </Field>
      <Field id="pay-note" label="Note (optional)">
        <Input id="pay-note" className="h-11" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <DialogFooter>
        <Button type="submit" className="h-11 px-5" disabled={pending || !amount || !workerId}>{pending ? "Saving…" : "Save payment"}</Button>
      </DialogFooter>
    </form>
  );
}

function WorkerForm({ worker, onDone }: { worker: Worker | null; onDone: () => void }) {
  const submit = useSubmit();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [name, setName] = useState(worker?.name ?? "");
  const [trade, setTrade] = useState(worker?.trade ?? "");
  const [phone, setPhone] = useState(worker?.phone ?? "");
  const [active, setActive] = useState(worker?.active ?? true);

  function save(e: FormEvent) {
    e.preventDefault();
    const body = { name, trade: trade || undefined, phone: phone || undefined, dailyWage: worker?.dailyWage ?? undefined };
    start(async () => {
      const res = await submit(() => (worker ? updateWorkerAction({ ...body, id: worker.id, active }) : createWorkerAction(body)), setErrors);
      if (res) {
        toast.success(worker ? "Worker updated" : `${name} added`);
        onDone();
      }
    });
  }

  return (
    <form onSubmit={save} className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="text-lg font-semibold">{worker ? "Edit worker" : "Add worker"}</DialogTitle>
        <DialogDescription>Workers are shared by every site in your organization.</DialogDescription>
      </DialogHeader>
      <Field id="w-name" label="Name" error={errors.name}>
        <Input id="w-name" className="h-11" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field id="w-trade" label="Work type" error={errors.trade}>
        <Input id="w-trade" className="h-11" maxLength={60} list="w-trades" placeholder="Mason" value={trade} onChange={(e) => setTrade(e.target.value)} />
        <datalist id="w-trades">{["Mason", "Helper", "Carpenter", "Bar bender", "Electrician", "Plumber", "Painter"].map((t) => <option key={t} value={t} />)}</datalist>
      </Field>
      <Field id="w-phone" label="Phone (optional)" error={errors.phone}>
        <Input id="w-phone" type="tel" className="h-11" maxLength={30} value={phone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
      {worker && (
        <label className="flex items-center justify-between gap-3 text-sm">
          Active (shown when adding payments)
          <Switch checked={active} onCheckedChange={setActive} />
        </label>
      )}
      <DialogFooter>
        <Button type="submit" className="h-11 px-5" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
      </DialogFooter>
    </form>
  );
}

/** A worker's payments on the site; deleting one deletes its labour expense (with undo). */
function Payments({ siteId, worker, canWrite }: { siteId: string; worker: WorkerTotal; canWrite: boolean }) {
  const fmt = useFormat();
  const [lines, setLines] = useState<WorkerPayment[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [deleting, setDeleting] = useState<WorkerPayment | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const sorted = (ls: WorkerPayment[]) => [...ls].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  const paid = lines ? lines.reduce((t, l) => t + Number(l.amount), 0) : Number(worker.total);
  const count = lines ? lines.length : worker.payments;

  async function remove(line: WorkerPayment) {
    setBusy(line.id);
    const res = await deleteExpenseAction(line.id).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      toast.error(res ? res.error : "Couldn't reach the server, so the payment may not be deleted. Reopen this to check.");
      return;
    }
    setLines((ls) => ls && ls.filter((l) => l.id !== line.id));
    toast("Payment deleted", {
      description: `${worker.name}, ${fmt.money(Number(line.amount))} on ${fmt.date(line.date)}`,
      action: {
        label: "Undo",
        onClick: async () => {
          const undo = await restoreExpenseAction(line.id).catch(() => null);
          if (!undo?.ok) toast.error(undo ? undo.error : "Couldn't restore the payment. Check your connection.");
          else setLines((ls) => ls && sorted([...ls, line]));
        },
      },
    });
  }
  useEffect(() => {
    let live = true;
    loadWorkerPaymentsAction(siteId, worker.workerId)
      .then((res) => {
        if (!live) return;
        if (res.ok) setLines(res.data);
        else setFailed(true);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [siteId, worker.workerId]);
  return (
    <>
      <SheetHeader>
        <SheetTitle>{worker.name}</SheetTitle>
        <SheetDescription>
          Paid {fmt.money(paid)} on this site in {count} {count === 1 ? "payment" : "payments"}
        </SheetDescription>
      </SheetHeader>
      <div className="px-4 pb-6">
        {failed ? (
          <p className="text-sm text-muted-foreground">Couldn&apos;t load the payments. Check your connection and reopen this.</p>
        ) : !lines ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">No payments on this site yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {lines.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-3 py-1 pr-1 pl-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {fmt.date(l.date)}
                    {l.kind === "advance" && <span className="text-xs font-normal text-muted-foreground"> · advance</span>}
                  </p>
                  {l.note && <p className="truncate text-xs text-muted-foreground">{l.note}</p>}
                </div>
                <div className="flex items-center gap-1">
                  <p className="num font-semibold">{fmt.money(Number(l.amount))}</p>
                  {canWrite && (
                    <Button variant="ghost" size="icon" className="size-10 text-muted-foreground hover:text-over" aria-label={`Delete payment of ${fmt.money(Number(l.amount))} on ${fmt.date(l.date)}`} disabled={busy === l.id} onClick={() => setDeleting(l)}>
                      <Trash2 aria-hidden />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this payment?"
        description={deleting ? `${fmt.money(Number(deleting.amount))} to ${worker.name} on ${fmt.date(deleting.date)}. Its labour expense is deleted too, and the totals go down.` : ""}
        confirmLabel="Delete payment"
        onConfirm={() => deleting && remove(deleting)}
      />
    </>
  );
}

/** Shown by the server page when the user has no sites; the icon stays on the client. */
export function LabourNoSites() {
  return <EmptyState icon={HardHat} title="No sites yet" description="Labour payments are tracked per site. Add a site or ask to be invited to one." />;
}
