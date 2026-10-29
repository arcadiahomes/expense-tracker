"use client";

import { useEffect, useState, useTransition, type FormEvent } from "react";
import { HardHat, NotebookText, Pencil, Plus, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Field, Stat, useSubmit } from "@/components/form-bits";
import { PageHeader } from "@/components/page-header";
import { SitePicker } from "@/components/site-picker";
import { EmptyState } from "@/components/states";
import { can } from "@/lib/permissions";
import { useFormat, useSession } from "@/lib/session";
import { deleteExpenseAction, restoreExpenseAction } from "@/server/actions/expenses";
import { createWorkerAction, loadWorkerPaymentsAction, loadWorkerSiteTotalsAction, updateWorkerAction } from "@/server/actions/labour";
import type { WorkerPayment, WorkerSiteTotal, WorkerTotal } from "@/server/data/labour";
import { cn } from "@/lib/utils";

type Worker = { id: string; name: string; trade: string | null; phone: string | null; dailyWage: string | null; active: boolean };
type Totals = {
  workers: WorkerTotal[];
  totals: { total: string; thisMonth: string; workers: number };
  unassigned: { payments: number; total: string; thisMonth: string };
};

export function LabourView({ siteId, totals, workers }: { siteId: string; totals: Totals; workers: Worker[] }) {
  const { sites } = useSession();
  const fmt = useFormat();
  const site = sites.find((s) => s.id === siteId);
  const canWrite = site?.status !== "completed" && can(site?.role, "expense:create");
  const [statement, setStatement] = useState<WorkerTotal | null>(null);
  const [editing, setEditing] = useState<Worker | "new" | null>(null);
  // Sorted by total, so the first worker sets the scale of the bars.
  const top = Number(totals.workers[0]?.total ?? 0);
  const totalOf = new Map(totals.workers.map((t) => [t.workerId, t]));
  // Inactive workers with no payments here aren't in the totals; their statement is empty.
  const totalFor = (w: Worker): WorkerTotal =>
    totalOf.get(w.id) ?? { workerId: w.id, name: w.name, trade: w.trade, active: w.active, payments: 0, total: "0", thisMonth: "0", lastPaid: null };

  return (
    <>
      <PageHeader
        title="Labour"
        description="What each worker has been paid on this site. Payments are labour expenses: add them on the Expenses page and name the worker."
        actions={
          canWrite && (
            <Button variant="outline" className="h-11" onClick={() => setEditing("new")}>
              <UserPlus aria-hidden /> Add worker
            </Button>
          )
        }
      />
      <SitePicker siteId={siteId} className="mb-5" />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Total paid to labour" value={fmt.money(Number(totals.totals.total))} hint="Every approved labour expense on this site" />
        <Stat label="This month" value={fmt.money(Number(totals.totals.thisMonth))} />
        <Stat label="Workers paid" value={totals.totals.workers} />
      </div>

      <Tabs defaultValue="totals">
        <TabsList className="h-11!">
          <TabsTrigger value="totals" className="px-3">Worker totals</TabsTrigger>
          <TabsTrigger value="workers" className="px-3">Workers</TabsTrigger>
        </TabsList>

        <TabsContent value="totals" className="mt-3">
          {totals.workers.length === 0 && totals.unassigned.payments === 0 ? (
            <EmptyState icon={HardHat} title="No workers yet" description="Add workers, then record what you pay them as labour expenses." />
          ) : (
            <ul className="surface divide-y rounded-xl">
              {totals.workers.map((w) => (
                <li key={w.workerId} className="grid gap-2 px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4">
                  <button type="button" className="min-w-0 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-label={`${w.name}: ${fmt.money(Number(w.total))} paid. Show payments`} onClick={() => setStatement(w)}>
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
                  </button>
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" className="h-10" onClick={() => setStatement(w)}>
                      <NotebookText aria-hidden /> Payments
                    </Button>
                  </div>
                </li>
              ))}
              {totals.unassigned.payments > 0 && (
                <li className="px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate font-semibold text-muted-foreground">No worker named</p>
                    <p className="num font-display text-lg font-bold">{fmt.money(Number(totals.unassigned.total))}</p>
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {[
                      `${totals.unassigned.payments} labour ${totals.unassigned.payments === 1 ? "expense" : "expenses"} without a worker`,
                      Number(totals.unassigned.thisMonth) > 0 && `${fmt.money(Number(totals.unassigned.thisMonth))} this month`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </li>
              )}
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
                  <button type="button" className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" onClick={() => setStatement(totalFor(w))}>
                    <div className="min-w-0">
                      <p className={cn("font-medium", !w.active && "text-muted-foreground")}>{w.name}{!w.active && " (inactive)"}</p>
                      <p className="text-xs text-muted-foreground">{[w.trade, w.phone].filter(Boolean).join(" · ") || "No details"}</p>
                    </div>
                    <p className="num shrink-0 font-semibold">{fmt.money(Number(totalFor(w).total))}</p>
                  </button>
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

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-md">{editing && <WorkerForm worker={editing === "new" ? null : editing} onDone={() => setEditing(null)} />}</DialogContent>
      </Dialog>
      <Sheet open={!!statement} onOpenChange={(o) => !o && setStatement(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">{statement && <Payments siteId={siteId} worker={statement} canWrite={canWrite} />}</SheetContent>
      </Sheet>
    </>
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
  const { today } = useSession();
  const month = today.slice(0, 7);
  const thisMonth = lines ? lines.filter((l) => l.date.startsWith(month)).reduce((t, l) => t + Number(l.amount), 0) : Number(worker.thisMonth);
  const [bySite, setBySite] = useState<WorkerSiteTotal[] | null>(null);
  const allSites = bySite?.reduce((t, s) => t + Number(s.total), 0) ?? null;

  async function remove(line: WorkerPayment) {
    setBusy(line.id);
    const res = await deleteExpenseAction(line.id).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      toast.error(res ? res.error : "Couldn't reach the server, so the payment may not be deleted. Reopen this to check.");
      return;
    }
    setLines((ls) => ls && ls.filter((l) => l.id !== line.id));
    setSitesVersion((v) => v + 1);
    toast("Payment deleted", {
      description: `${worker.name}, ${fmt.money(Number(line.amount))} on ${fmt.date(line.date)}`,
      action: {
        label: "Undo",
        onClick: async () => {
          const undo = await restoreExpenseAction(line.id).catch(() => null);
          if (!undo?.ok) toast.error(undo ? undo.error : "Couldn't restore the payment. Check your connection.");
          else {
            setLines((ls) => ls && sorted([...ls, line]));
            setSitesVersion((v) => v + 1);
          }
        },
      },
    });
  }
  // Reloaded after a delete or undo here so the all-sites figures follow.
  const [sitesVersion, setSitesVersion] = useState(0);
  useEffect(() => {
    let live = true;
    loadWorkerSiteTotalsAction(worker.workerId)
      .then((res) => live && res.ok && setBySite(res.data))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [worker.workerId, sitesVersion]);
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
        <div className="mb-4 grid grid-cols-2 gap-3">
          <Stat label="Paid on this site" value={fmt.money(paid)} />
          <Stat label="This month" value={fmt.money(thisMonth)} />
          <div className="col-span-2">
            <Stat label="Paid on all sites" value={allSites == null ? "…" : fmt.money(allSites)} />
          </div>
        </div>
        {bySite && bySite.length > 0 && (
          <div className="mb-5">
            <h3 className="mb-2 text-sm font-semibold">By site</h3>
            <ul className="divide-y rounded-lg border text-sm">
              {bySite.map((s) => (
                <li key={s.siteId} className={cn("flex items-center justify-between gap-3 px-3 py-2", s.siteId === siteId && "bg-secondary/60")}>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{s.siteName}</p>
                    <p className="text-xs text-muted-foreground">
                      {s.payments} {s.payments === 1 ? "payment" : "payments"}
                      {s.lastPaid && ` · last paid ${fmt.date(s.lastPaid)}`}
                    </p>
                  </div>
                  <p className="num shrink-0 font-semibold">{fmt.money(Number(s.total))}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
        <h3 className="mb-2 text-sm font-semibold">Payments on this site</h3>
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
