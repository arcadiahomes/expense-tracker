"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition, type FormEvent } from "react";
import { HandCoins, HardHat, NotebookText, Pencil, Plus, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PAYMENT_OPTIONS } from "@/components/expense-form-dialog";
import { Field, Stat, useSubmit } from "@/components/form-bits";
import { PageHeader } from "@/components/page-header";
import { SelectField } from "@/components/select-field";
import { SitePicker } from "@/components/site-picker";
import { EmptyState } from "@/components/states";
import { can } from "@/lib/permissions";
import { useFormat, useSession } from "@/lib/session";
import type { PaymentMode } from "@/lib/types";
import { createWorkerAction, loadWorkerLedgerAction, recordAttendanceAction, recordLabourPaymentAction, updateWorkerAction } from "@/server/actions/labour";
import type { LedgerLine, WorkerBalance } from "@/server/data/labour";
import { cn } from "@/lib/utils";

type Status = "present" | "half_day" | "absent";
type DayRow = { workerId: string; status: Status; workType: string | null; dayRate: string | null; wageAmount: string };
type Worker = { id: string; name: string; trade: string | null; phone: string | null; dailyWage: string | null; active: boolean };

const STATUS_OPTIONS: { value: Status; label: string; short: string }[] = [
  { value: "present", label: "Present", short: "P" },
  { value: "half_day", label: "Half day", short: "½" },
  { value: "absent", label: "Absent", short: "A" },
];

export function LabourView({
  siteId,
  date,
  balances,
  day,
  workers,
}: {
  siteId: string;
  date: string;
  balances: { workers: WorkerBalance[]; totals: { earned: string; paid: string; unpaid: string; advances: string } };
  day: DayRow[];
  workers: Worker[];
}) {
  const { sites } = useSession();
  const fmt = useFormat();
  const site = sites.find((s) => s.id === siteId);
  const canWrite = site?.status !== "completed" && can(site?.role, "expense:create");
  const [paying, setPaying] = useState<{ worker: WorkerBalance; kind: "wage" | "advance" } | null>(null);
  const [ledger, setLedger] = useState<WorkerBalance | null>(null);
  const [editing, setEditing] = useState<Worker | "new" | null>(null);

  return (
    <>
      <PageHeader
        title="Labour"
        description="Attendance builds up wages earned; payments and advances settle them. Unpaid wages aren't spending until they're paid."
        actions={
          canWrite && (
            <Button variant="outline" className="h-11" onClick={() => setEditing("new")}>
              <UserPlus aria-hidden /> Add worker
            </Button>
          )
        }
      />
      <SitePicker siteId={siteId} className="mb-5" />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Wages earned" value={fmt.money(Number(balances.totals.earned))} hint="From attendance" />
        <Stat label="Paid to workers" value={fmt.money(Number(balances.totals.paid))} hint="Wages and advances" />
        <Stat label="Unpaid wages" value={fmt.money(Number(balances.totals.unpaid))} tone={Number(balances.totals.unpaid) > 0 ? "warn" : undefined} />
        <Stat label="Advances outstanding" value={fmt.money(Number(balances.totals.advances))} hint="Not yet worked off" />
      </div>

      <Tabs defaultValue="attendance">
        <TabsList className="h-11!">
          <TabsTrigger value="attendance" className="px-3">Attendance</TabsTrigger>
          <TabsTrigger value="balances" className="px-3">Balances</TabsTrigger>
          <TabsTrigger value="workers" className="px-3">Workers</TabsTrigger>
        </TabsList>

        <TabsContent value="attendance" className="mt-3">
          <RollCall key={`${siteId}-${date}`} siteId={siteId} date={date} day={day} workers={workers.filter((w) => w.active || day.some((d) => d.workerId === w.id))} canWrite={canWrite} />
        </TabsContent>

        <TabsContent value="balances" className="mt-3">
          {balances.workers.length === 0 ? (
            <EmptyState icon={HardHat} title="No workers yet" description="Add workers, then mark attendance to build up their wages." />
          ) : (
            <ul className="grid gap-3 md:grid-cols-2">
              {balances.workers.map((w) => (
                <li key={w.workerId} className="surface rounded-xl p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold">{w.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {[w.trade, w.dailyWage && `${fmt.money(Number(w.dailyWage))}/day`, `${w.days} days here`].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <div className="text-right">
                      {Number(w.unpaid) > 0 ? (
                        <p className="num font-display text-lg font-bold text-warn">{fmt.money(Number(w.unpaid))} <span className="text-xs font-medium">owed</span></p>
                      ) : Number(w.advanceOutstanding) > 0 ? (
                        <p className="num font-display text-lg font-bold">{fmt.money(Number(w.advanceOutstanding))} <span className="text-xs font-medium text-muted-foreground">advance</span></p>
                      ) : (
                        <p className="text-sm text-good">Settled</p>
                      )}
                    </div>
                  </div>
                  <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <div><dt className="text-muted-foreground">Earned</dt><dd className="num font-medium">{fmt.money(Number(w.earned))}</dd></div>
                    <div><dt className="text-muted-foreground">Wages paid</dt><dd className="num font-medium">{fmt.money(Number(w.wagesPaid))}</dd></div>
                    <div><dt className="text-muted-foreground">Advances</dt><dd className="num font-medium">{fmt.money(Number(w.advances))}</dd></div>
                  </dl>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {canWrite && (
                      <>
                        <Button size="sm" className="h-10" disabled={Number(w.unpaid) <= 0} onClick={() => setPaying({ worker: w, kind: "wage" })}>
                          <HandCoins aria-hidden /> Pay wages
                        </Button>
                        <Button size="sm" variant="outline" className="h-10" onClick={() => setPaying({ worker: w, kind: "advance" })}>
                          Advance
                        </Button>
                      </>
                    )}
                    <Button size="sm" variant="ghost" className="h-10" onClick={() => setLedger(w)}>
                      <NotebookText aria-hidden /> Statement
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
                    <p className="text-xs text-muted-foreground">{[w.trade, w.dailyWage && `${fmt.money(Number(w.dailyWage))}/day`, w.phone].filter(Boolean).join(" · ") || "No details"}</p>
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
        <DialogContent className="sm:max-w-md">{paying && <PayForm siteId={siteId} worker={paying.worker} kind={paying.kind} onDone={() => setPaying(null)} />}</DialogContent>
      </Dialog>
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-md">{editing && <WorkerForm worker={editing === "new" ? null : editing} onDone={() => setEditing(null)} />}</DialogContent>
      </Dialog>
      <Sheet open={!!ledger} onOpenChange={(o) => !o && setLedger(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">{ledger && <Statement siteId={siteId} worker={ledger} />}</SheetContent>
      </Sheet>
    </>
  );
}

/** The day's roll call: tap P / ½ / A per worker, adjust the rate if needed, save all at once. */
function RollCall({ siteId, date, day, workers, canWrite }: { siteId: string; date: string; day: DayRow[]; workers: Worker[]; canWrite: boolean }) {
  const submit = useSubmit();
  const { today } = useSession();
  const fmt = useFormat();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const saved = new Map(day.map((d) => [d.workerId, d]));
  const [rows, setRows] = useState(() =>
    workers.map((w) => {
      const d = saved.get(w.id);
      return { workerId: w.id, status: (d?.status ?? null) as Status | null, dayRate: d?.dayRate ?? w.dailyWage ?? "", workType: d?.workType ?? w.trade ?? "" };
    }),
  );
  const marked = rows.filter((r) => r.status);
  const preview = marked.reduce((t, r) => t + (r.status === "absent" ? 0 : Number(r.dayRate || 0) * (r.status === "half_day" ? 0.5 : 1)), 0);

  const setDate = (d: string) => {
    const next = new URLSearchParams(params);
    next.set("date", d);
    next.set("site", siteId);
    router.push(`${pathname}?${next}`);
  };

  function save(e: FormEvent) {
    e.preventDefault();
    start(async () => {
      const res = await submit(
        () =>
          recordAttendanceAction({
            siteId,
            workDate: date,
            entries: marked.map((r) => ({ workerId: r.workerId, status: r.status, dayRate: r.dayRate || undefined, workType: r.workType || undefined })),
          }),
        setErrors,
      );
      if (res) toast.success(`Attendance saved for ${res.length} ${res.length === 1 ? "worker" : "workers"}`);
    });
  }

  if (!workers.length) return <EmptyState icon={HardHat} title="No active workers" description="Add workers on the Workers tab to mark attendance." />;

  return (
    <form onSubmit={save} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field id="att-date" label="Day">
          <Input id="att-date" type="date" className="h-11 w-44" max={today} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </Field>
        {canWrite && (
          <Button type="button" variant="outline" className="h-11" onClick={() => setRows((rs) => rs.map((r) => ({ ...r, status: r.status ?? "present" })))}>
            Mark the rest present
          </Button>
        )}
      </div>
      <ul className="surface divide-y rounded-xl">
        {rows.map((r, i) => {
          const w = workers.find((x) => x.id === r.workerId)!;
          const err = errors[`entries.${marked.indexOf(r)}.dayRate`];
          return (
            <li key={r.workerId} className="grid gap-2 px-4 py-3 sm:grid-cols-[1fr_auto_auto] sm:items-center">
              <div className="min-w-0">
                <p className="font-medium">{w.name}</p>
                {saved.has(w.id) && <p className="text-xs text-muted-foreground">Saved: {STATUS_OPTIONS.find((o) => o.value === saved.get(w.id)!.status)!.label}, {fmt.money(Number(saved.get(w.id)!.wageAmount))}</p>}
                {err && <p className="text-xs font-medium text-over">{err}</p>}
              </div>
              <div role="radiogroup" aria-label={`${w.name} attendance`} className="flex gap-1.5">
                {STATUS_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={r.status === o.value}
                    aria-label={o.label}
                    disabled={!canWrite}
                    onClick={() => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, status: x.status === o.value ? null : o.value } : x)))}
                    className={cn(
                      "h-11 min-w-11 rounded-lg border px-3 text-sm font-semibold transition-colors disabled:opacity-60",
                      r.status === o.value ? (o.value === "absent" ? "border-over bg-over/10 text-over" : "brand-fill border-transparent") : "border-[var(--line)] bg-card",
                    )}
                  >
                    {o.short}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-1.5 sm:w-56">
                <Input aria-label={`${w.name} work type`} placeholder="Work type" className="h-11" maxLength={60} disabled={!canWrite} value={r.workType} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, workType: e.target.value } : x)))} />
                <Input aria-label={`${w.name} day rate`} placeholder="₹/day" inputMode="decimal" className="num h-11" disabled={!canWrite} value={r.dayRate} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, dayRate: e.target.value.replace(/[^\d.]/g, "") } : x)))} />
              </div>
            </li>
          );
        })}
      </ul>
      {canWrite && (
        <div className="surface sticky bottom-24 flex items-center justify-between gap-3 rounded-xl p-3 md:bottom-4">
          <p className="text-sm">
            {marked.length} marked · <span className="num font-semibold">{fmt.money(preview)}</span> <span className="text-muted-foreground">earned</span>
          </p>
          <Button type="submit" className="h-11 px-5" disabled={pending || !marked.length}>{pending ? "Saving…" : "Save attendance"}</Button>
        </div>
      )}
    </form>
  );
}

function PayForm({ siteId, worker, kind: initialKind, onDone }: { siteId: string; worker: WorkerBalance; kind: "wage" | "advance"; onDone: () => void }) {
  const submit = useSubmit();
  const { today } = useSession();
  const fmt = useFormat();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [kind, setKind] = useState(initialKind);
  const [amount, setAmount] = useState(initialKind === "wage" ? String(Number(worker.unpaid)) : "");
  const [method, setMethod] = useState<PaymentMode>("cash");
  const [paidOn, setPaidOn] = useState(today);
  const [note, setNote] = useState("");

  function save(e: FormEvent) {
    e.preventDefault();
    start(async () => {
      const res = await submit(() => recordLabourPaymentAction({ siteId, workerId: worker.workerId, kind, amount, method, paidOn, note: note || undefined }), setErrors);
      if (res) {
        toast.success(`${kind === "advance" ? "Advance" : "Wages"} of ${fmt.money(Number(amount))} to ${worker.name} saved`);
        onDone();
      }
    });
  }

  return (
    <form onSubmit={save} className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="text-lg font-semibold">Pay {worker.name}</DialogTitle>
        <DialogDescription>
          {Number(worker.unpaid) > 0 ? `Owed ${fmt.money(Number(worker.unpaid))} in wages on this site.` : "No wages owed on this site right now."} This is saved as a labour expense.
        </DialogDescription>
      </DialogHeader>
      <Field id="pay-kind" label="Payment is">
        <SelectField id="pay-kind" value={kind} onChange={setKind} options={[{ value: "wage" as const, label: "Wages for work done" }, { value: "advance" as const, label: "Advance against future work" }]} />
      </Field>
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
        <Button type="submit" className="h-11 px-5" disabled={pending || !amount}>{pending ? "Saving…" : "Save payment"}</Button>
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
  const [dailyWage, setWage] = useState(worker?.dailyWage ?? "");
  const [active, setActive] = useState(worker?.active ?? true);

  function save(e: FormEvent) {
    e.preventDefault();
    const body = { name, trade: trade || undefined, phone: phone || undefined, dailyWage: dailyWage || undefined };
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
      <div className="grid grid-cols-2 gap-3">
        <Field id="w-trade" label="Work type" error={errors.trade}>
          <Input id="w-trade" className="h-11" maxLength={60} list="w-trades" placeholder="Mason" value={trade} onChange={(e) => setTrade(e.target.value)} />
          <datalist id="w-trades">{["Mason", "Helper", "Carpenter", "Bar bender", "Electrician", "Plumber", "Painter"].map((t) => <option key={t} value={t} />)}</datalist>
        </Field>
        <Field id="w-wage" label="Daily wage (₹)" error={errors.dailyWage}>
          <Input id="w-wage" inputMode="decimal" className="h-11" value={dailyWage} onChange={(e) => setWage(e.target.value.replace(/[^\d.]/g, ""))} />
        </Field>
      </div>
      <Field id="w-phone" label="Phone (optional)" error={errors.phone}>
        <Input id="w-phone" type="tel" className="h-11" maxLength={30} value={phone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
      {worker && (
        <label className="flex items-center justify-between gap-3 text-sm">
          Active (shown in the roll call)
          <Switch checked={active} onCheckedChange={setActive} />
        </label>
      )}
      <DialogFooter>
        <Button type="submit" className="h-11 px-5" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
      </DialogFooter>
    </form>
  );
}

function Statement({ siteId, worker }: { siteId: string; worker: WorkerBalance }) {
  const fmt = useFormat();
  const [lines, setLines] = useState<LedgerLine[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    loadWorkerLedgerAction(siteId, worker.workerId)
      .then((res) => {
        if (!live) return;
        if (res.ok) setLines(res.data.lines);
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
          Earned {fmt.money(Number(worker.earned))} · paid {fmt.money(Number(worker.wagesPaid) + Number(worker.advances))} ·{" "}
          {Number(worker.balance) >= 0 ? `owed ${fmt.money(Number(worker.balance))}` : `advance ${fmt.money(-Number(worker.balance))}`}
        </SheetDescription>
      </SheetHeader>
      <div className="px-4 pb-6">
        {failed ? (
          <p className="text-sm text-muted-foreground">Couldn&apos;t load the statement. Check your connection and reopen it.</p>
        ) : !lines ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">No attendance or payments on this site yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {lines.map((l) => (
              <li key={`${l.kind}-${l.id}`} className="flex items-start justify-between gap-3 px-3 py-2">
                <div>
                  <p className="font-medium">{l.kind === "attendance" ? l.description : l.kind === "advance" ? "Advance paid" : "Wages paid"}</p>
                  <p className="text-xs text-muted-foreground">{fmt.date(l.date)}</p>
                </div>
                <div className="text-right">
                  <p className={cn("num font-semibold", Number(l.amount) < 0 && "text-good")}>{Number(l.amount) < 0 ? `−${fmt.money(-Number(l.amount))}` : `+${fmt.money(Number(l.amount))}`}</p>
                  <p className="num text-xs text-muted-foreground">bal {fmt.money(Number(l.balance))}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** Shown by the server page when the user has no sites; the icon stays on the client. */
export function LabourNoSites() {
  return <EmptyState icon={HardHat} title="No sites yet" description="Attendance and wages are tracked per site. Add a site or ask to be invited to one." />;
}
