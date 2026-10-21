"use client";

import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, useTransition, type DragEvent, type FormEvent } from "react";
import {
  CircleCheck,
  CircleDashed,
  Clock,
  FileImage,
  FileText,
  OctagonAlert,
  Paperclip,
  ReceiptText,
  Search,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { EmptyState } from "@/components/states";
import { SelectField } from "@/components/select-field";
import { Field, PAYMENT_OPTIONS } from "@/components/expense-form-dialog";
import { CATEGORY_META } from "@/lib/categories";
import { daysBetween, shiftDate } from "@/lib/dates";
import { formatFileSize } from "@/lib/format";
import { can } from "@/lib/permissions";
import { useFormat, useSession } from "@/lib/session";
import { CATEGORIES, type Bill, type BillStatus, type Category, type Page, type PaymentMode } from "@/lib/types";
import { cn } from "@/lib/utils";
import { createBillAction, loadBillsAction, recordPaymentAction } from "@/server/actions/bills";
import { scanUploadAction } from "@/server/actions/receipts";
import { FilePickers, ReceiptsPanel, prepareFile } from "@/components/receipts-panel";
import { useSlowNotice, useSubmitGuard } from "@/lib/network";
import type { billTotals } from "@/server/data/bills";

const STATUS = {
  pending: { label: "Pending", icon: Clock, className: "bg-muted text-foreground" },
  partial: { label: "Partly paid", icon: CircleDashed, className: "bg-warn/12 text-warn" },
  overdue: { label: "Overdue", icon: OctagonAlert, className: "bg-over/12 text-over" },
  paid: { label: "Paid", icon: CircleCheck, className: "bg-good/12 text-good" },
} as const;

export function BillStatusBadge({ status }: { status: BillStatus }) {
  const s = STATUS[status];
  const Icon = s.icon;
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium", s.className)}>
      <Icon className="size-3.5" aria-hidden />
      {s.label}
    </span>
  );
}

type Filter = "all" | BillStatus;
type Totals = Awaited<ReturnType<typeof billTotals>>;

/** Sites where the signed-in user may add bills and record payments. */
function useManagedSites() {
  const { sites } = useSession();
  return useMemo(() => sites.filter((s) => can(s.role, "finance:manage") && s.status !== "completed"), [sites]);
}

export function BillsView({ page, totals, filter, query }: { page: Page<Bill>; totals: Totals; filter: Filter; query: string }) {
  const [uploading, setUploading] = useState(false);
  const canUpload = useManagedSites().length > 0;
  return (
    <>
      <PageHeader
        title="Bills"
        description="Supplier bills, what's still owed and the receipts behind them."
        actions={
          canUpload && (
            <Button className="h-11 px-4" onClick={() => setUploading(true)}>
              <Upload aria-hidden /> Upload bill
            </Button>
          )
        }
      />
      <BillsBody
        page={page}
        totals={totals}
        filter={filter}
        query={query}
        onUpload={canUpload ? () => setUploading(true) : undefined}
      />
      <UploadDialog open={uploading} onOpenChange={setUploading} />
    </>
  );
}

function BillsBody({
  page,
  totals,
  filter,
  query: initialQuery,
  onUpload,
}: {
  page: Page<Bill>;
  totals: Totals;
  filter: Filter;
  query: string;
  onUpload?: () => void;
}) {
  const { sites, today } = useSession();
  const fmt = useFormat();
  const router = useRouter();
  const pathname = usePathname();
  const [query, setQuery] = useState(initialQuery);
  const [openId, setOpenId] = useState<string | null>(null);
  const [navigating, startNav] = useTransition();
  const [loadingMore, startMore] = useTransition();

  // Pages fetched with "Show more"; reset whenever the server sends a fresh first page.
  const [paged, setPaged] = useState({ base: page, extra: [] as Bill[], cursor: page.nextCursor });
  if (paged.base !== page) setPaged({ base: page, extra: [], cursor: page.nextCursor });
  const bills = paged.base === page ? [...page.items, ...paged.extra] : page.items;
  const cursor = paged.base === page ? paged.cursor : page.nextCursor;

  const siteName = useMemo(() => Object.fromEntries(sites.map((s) => [s.id, s.name])), [sites]);
  const receipts = bills.filter((b) => b.attachment);
  const openBill = bills.find((b) => b.id === openId);

  // Status and search run on the server through the URL.
  function navigate(next: { status?: Filter; q?: string }) {
    const params = new URLSearchParams();
    const status = next.status ?? filter;
    const q = (next.q ?? query).trim();
    if (status !== "all") params.set("status", status);
    if (q) params.set("q", q);
    startNav(() => router.replace(params.size ? `${pathname}?${params}` : pathname, { scroll: false }));
  }

  function loadMore() {
    if (!cursor) return;
    startMore(async () => {
      const res = await loadBillsAction({ status: filter, q: query.trim() || undefined, cursor });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setPaged((p) => ({ ...p, extra: [...p.extra, ...res.data.items], cursor: res.data.nextCursor }));
    });
  }

  if (totals.counts.all === 0) {
    return (
      <EmptyState
        icon={ReceiptText}
        title="No bills yet"
        description="Upload a supplier bill or a photo of a receipt to track what's owed."
        action={onUpload && <Button className="h-11 px-5" onClick={onUpload}><Upload aria-hidden /> Upload bill</Button>}
      />
    );
  }

  return (
    <div className="grid gap-4 lg:gap-5">
      <section aria-label="Bill totals" className="grid overflow-hidden surface rounded-xl sm:grid-cols-3">
        <div className="border-b p-4 sm:border-r sm:border-b-0 sm:p-5">
          <p className="text-sm text-muted-foreground">Still to pay</p>
          <p className="num font-display mt-1 text-[1.75rem] font-bold">{fmt.money(totals.outstanding)}</p>
        </div>
        <div className="border-b bg-over/6 p-4 sm:border-r sm:border-b-0 sm:p-5">
          <p className="flex items-center gap-1.5 text-sm text-over"><OctagonAlert className="size-4" aria-hidden /> Overdue</p>
          <p className="num font-display mt-1 text-xl font-bold sm:text-2xl">{fmt.money(totals.overdueAmount)}</p>
          <p className="text-xs text-muted-foreground">{totals.overdueCount} {totals.overdueCount === 1 ? "bill" : "bills"}</p>
        </div>
        <div className="p-4 sm:p-5">
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><Clock className="size-4" aria-hidden /> Due in 7 days</p>
          <p className="num font-display mt-1 text-xl font-bold sm:text-2xl">{fmt.money(totals.dueSoonAmount)}</p>
          <p className="text-xs text-muted-foreground">{totals.dueSoonCount} {totals.dueSoonCount === 1 ? "bill" : "bills"}</p>
        </div>
      </section>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={filter} onValueChange={(v) => navigate({ status: v as Filter })} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList className="h-11!">
            {(["all", "overdue", "pending", "partial", "paid"] as Filter[]).map((f) => (
              <TabsTrigger key={f} value={f} className="px-3">
                {f === "all" ? "All" : STATUS[f].label}
                <span className="num ml-1 text-muted-foreground">{totals.counts[f]}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <form
          role="search"
          className="relative sm:w-72"
          onSubmit={(e) => {
            e.preventDefault();
            navigate({ q: query });
          }}
        >
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            aria-label="Search bills"
            placeholder="Supplier, bill number or site"
            className="h-11 pl-9"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (e.target.value === "") navigate({ q: "" });
            }}
          />
        </form>
      </div>

      <section aria-label="Bills" aria-busy={navigating} className={cn("surface rounded-xl transition-opacity", navigating && "opacity-60")}>
        {bills.length === 0 ? (
          <EmptyState className="m-4 border-0" icon={Search} title="No bills match" description="Try another supplier name or switch to All." />
        ) : (
          <ul className="divide-y">
            {bills.map((bill) => {
              const balance = bill.amount - bill.paid;
              const due = daysBetween(today, bill.dueDate);
              return (
                <li key={bill.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(bill.id)}
                    className="grid w-full grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3.5 text-left hover:bg-muted/50 focus-visible:-outline-offset-2 sm:px-5 md:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_auto_auto]"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 font-medium">
                        <span className="truncate">{bill.supplier}</span>
                        {bill.attachment && <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-label="Has attachment" />}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {bill.billNo}, {siteName[bill.siteId] ?? "Unknown site"}
                      </span>
                    </span>
                    <span className="num row-start-2 text-xs text-muted-foreground md:row-start-auto md:text-sm">
                      {bill.status === "paid" ? `Billed ${fmt.date(bill.date)}` : due < 0 ? `${-due} ${due === -1 ? "day" : "days"} past due` : due === 0 ? "Due today" : `Due in ${due} ${due === 1 ? "day" : "days"}`}
                    </span>
                    <span className="col-start-2 row-start-2 justify-self-end md:col-start-auto md:row-start-auto">
                      <BillStatusBadge status={bill.status} />
                    </span>
                    <span className="num col-start-2 row-start-1 text-right md:col-start-auto md:row-start-auto md:w-32">
                      <span className="block font-semibold">{fmt.money(bill.amount)}</span>
                      {bill.status !== "paid" && bill.paid > 0 && <span className="block text-xs text-muted-foreground">{fmt.money(balance)} left</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {cursor && (
          <div className="flex justify-center border-t p-4">
            <Button variant="outline" className="h-11 px-5" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Show more"}
            </Button>
          </div>
        )}
      </section>

      <Panel title="Receipts" description={`${receipts.length} files attached to the bills above`}>
        {receipts.length === 0 ? (
          <p className="text-sm text-muted-foreground">Receipts you attach to bills appear here.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {receipts.map((b) => {
              const Icon = b.attachment!.kind === "pdf" ? FileText : FileImage;
              return (
                <li key={b.id}>
                  <button type="button" onClick={() => setOpenId(b.id)} className="lift surface block w-full overflow-hidden rounded-xl text-left">
                    <span className="grid aspect-[4/3] place-items-center rounded-t-md bg-muted text-muted-foreground">
                      <Icon className="size-8" aria-hidden />
                    </span>
                    <span className="block p-2.5">
                      <span className="block truncate text-sm font-medium">{b.attachment!.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{b.supplier}, {formatFileSize(b.attachment!.size)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <BillSheet bill={openBill} siteName={openBill ? siteName[openBill.siteId] : undefined} onClose={() => setOpenId(null)} />
    </div>
  );
}

function BillSheet({ bill, siteName, onClose }: { bill?: Bill; siteName?: string; onClose: () => void }) {
  const { today, sites } = useSession();
  const fmt = useFormat();
  const [payment, setPayment] = useState("");
  const [method, setMethod] = useState<PaymentMode>("bank");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const guard = useSubmitGuard();
  useSlowNotice(pending);

  const balance = bill ? bill.amount - bill.paid : 0;

  function record(amount: string) {
    if (!bill) return;
    setError(null);
    // A second tap while the first payment is in flight is ignored: it would record a second payment.
    void guard(
      () =>
        new Promise<void>((done) =>
          start(async () => {
            try {
              const res = await recordPaymentAction({ billId: bill.id, amount, paidOn: today, method });
              if (!res.ok) {
                setError(res.fieldErrors?.amount ?? res.error);
                return;
              }
              setPayment("");
              toast.success(res.data.status === "paid" ? "Bill marked as paid" : "Payment recorded", {
                description: `${fmt.money(Number(amount))} to ${bill.supplier}`,
              });
            } catch {
              setError("Couldn't reach the server, so we can't confirm the payment was recorded. Close and reopen the bill to check its balance before trying again.");
            } finally {
              done();
            }
          }),
        ),
    );
  }

  return (
    <Sheet open={!!bill} onOpenChange={(o) => { if (!o) { onClose(); setPayment(""); setError(null); } }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md!">
        {bill && (
          <>
            <SheetHeader className="border-b">
              <BillStatusBadge status={bill.status} />
              <SheetTitle className="font-display text-xl font-bold">{bill.supplier}</SheetTitle>
              <SheetDescription>{bill.billNo}, {siteName ?? "Unknown site"}</SheetDescription>
            </SheetHeader>
            <div className="space-y-5 px-4 pb-6">
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div><dt className="text-xs text-muted-foreground">Bill amount</dt><dd className="num font-semibold">{fmt.money(bill.amount)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Balance</dt><dd className={cn("num font-semibold", balance > 0 && bill.status === "overdue" && "text-over")}>{fmt.money(balance)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Bill date</dt><dd>{fmt.date(bill.date)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Due date</dt><dd>{fmt.date(bill.dueDate)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Category</dt><dd>{CATEGORY_META[bill.category].label}</dd></div>
                <div className="col-span-2"><dt className="text-xs text-muted-foreground">Items</dt><dd>{bill.description || "Not described"}</dd></div>
              </dl>

              <ReceiptsPanel key={bill.id} siteId={bill.siteId} supplierBillId={bill.id} canUpload={can(sites.find((x) => x.id === bill.siteId)?.role, "expense:create")} />

              {balance > 0 && bill.canManage && (
                <form
                  className="space-y-3 rounded-xl bg-secondary/70 p-4"
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    if (Number(payment) > 0) record(payment);
                  }}
                >
                  <p className="text-sm font-medium">Record a payment</p>
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <Input
                      aria-label="Payment amount in rupees"
                      aria-invalid={!!error}
                      inputMode="decimal"
                      placeholder={`Up to ${fmt.money(balance)}`}
                      className="num h-11"
                      value={payment}
                      onChange={(e) => setPayment(e.target.value.replace(/[^\d.]/g, ""))}
                    />
                    <Button type="submit" className="h-11" disabled={pending || !(Number(payment) > 0)}>
                      {pending ? "Saving…" : "Record"}
                    </Button>
                  </div>
                  <SelectField aria-label="Paid by" value={method} onChange={setMethod} options={PAYMENT_OPTIONS} />
                  {error && <p role="alert" className="text-xs text-over">{error}</p>}
                  <Button type="button" variant="outline" className="h-11 w-full" disabled={pending} onClick={() => record(balance.toFixed(2))}>
                    <CircleCheck aria-hidden /> Mark fully paid
                  </Button>
                  <p className="text-xs text-muted-foreground">Each payment is also added to the site&rsquo;s expenses, dated today.</p>
                </form>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}


function UploadDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        {open && <UploadForm onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function UploadForm({ onDone }: { onDone: () => void }) {
  const { today, suppliers, features } = useSession();
  const managed = useManagedSites();
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<"camera" | "file">("file");
  const [scanning, startScan] = useTransition();
  const guard = useSubmitGuard();
  /** Fields filled from the file, shown with a "check this" label until edited. */
  const [suggested, setSuggested] = useState<Set<string>>(new Set());
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pending, start] = useTransition();
  useSlowNotice(pending);
  const [form, setForm] = useState({
    supplierName: "",
    billNumber: "",
    siteId: managed[0]?.id ?? "",
    billDate: today,
    dueDate: shiftDate(today, 15),
    amount: "",
    categoryCode: "materials" as Category,
    description: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Quick client-side check for a friendly message; the server checks the bytes again.
  async function accept(picked: File | undefined, from: "camera" | "file" = "file") {
    if (!picked) return;
    const f = await prepareFile(picked);
    setFileError(typeof f === "string" ? f : null);
    if (typeof f === "string") return;
    setFile(f);
    setSource(from);
    setScanNote(null);
  }

  /** Reads the bill to pre-fill empty fields. Nothing is saved; the person checks and saves. */
  function scan() {
    if (!file) return;
    const data = new FormData();
    data.set("file", file);
    data.set("siteId", form.siteId);
    startScan(async () => {
      try {
        const res = await scanUploadAction(data);
        if (!res.ok) return void toast.error(res.error);
        const s = res.data.suggestion;
        const fills: Partial<typeof form> = {};
        if (s.supplier && !form.supplierName) fills.supplierName = s.supplier;
        if (s.billNumber && !form.billNumber) fills.billNumber = s.billNumber;
        if (s.date && form.billDate === today) fills.billDate = s.date;
        if (s.amount && !form.amount) fills.amount = s.amount;
        setForm((f) => ({ ...f, ...fills }));
        setSuggested(new Set(Object.keys(fills)));
        setScanNote(
          [
            Object.keys(fills).length ? "Filled from the bill. Check each marked field before saving." : "Nothing new could be read with confidence.",
            !s.legible && "The file looked unclear.",
            s.notes,
            res.data.duplicate && `Possible duplicate: ${res.data.duplicate.reason}`,
          ]
            .filter(Boolean)
            .join(" "),
        );
      } catch {
        toast.error("Couldn't reach the server to read the bill. Fill in the details yourself.");
      }
    });
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    void accept(e.dataTransfer.files[0]);
  }

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setSuggested((s) => (s.has(k) ? new Set([...s].filter((x) => x !== k)) : s));
  };
  const check = (k: string) => (suggested.has(k) ? <span className="ml-1 text-xs font-normal text-warn">from the bill, check</span> : null);

  function save() {
    const data = new FormData();
    for (const [k, v] of Object.entries(form)) if (v) data.set(k, v);
    if (file) {
      data.set("file", file);
      data.set("captureSource", source);
    }
    void guard(
      () =>
        new Promise<void>((done) =>
          start(async () => {
            try {
              const res = await createBillAction(data);
              if (!res.ok) {
                setErrors(res.fieldErrors ?? {});
                toast.error(res.error);
                return;
              }
              toast.success("Bill uploaded", { description: res.data.supplier });
              onDone();
            } catch {
              toast.error("Couldn't reach the server, so we can't confirm this was saved. Check the list before trying again.");
            } finally {
              done();
            }
          }),
        ),
    );
  }

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="font-display text-xl font-bold">Upload bill</DialogTitle>
        <DialogDescription>Attach the bill or a clear photo of it, then fill in the details.</DialogDescription>
      </DialogHeader>

      {file ? (
        <div className="flex items-center gap-3 rounded-xl border border-[var(--line)] bg-card p-3">
          <span className="grid size-11 place-items-center rounded bg-muted text-muted-foreground">
            {file.type === "application/pdf" ? <FileText aria-hidden /> : <FileImage aria-hidden />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{file.name}</p>
            <p className="text-xs text-muted-foreground">
              {pending ? "Uploading…" : `${formatFileSize(file.size)}, uploads when you save`}
            </p>
          </div>
          <Button variant="ghost" size="icon" className="size-10" aria-label="Remove file" disabled={pending} onClick={() => setFile(null)}>
            <X aria-hidden />
          </Button>
        </div>
      ) : (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn("flex flex-col items-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors", dragging ? "border-primary bg-accent/70" : "border-primary/30 bg-secondary/40")}
        >
          <Upload className="size-7 text-muted-foreground" aria-hidden />
          <p className="mt-2 text-sm font-medium">Drop the bill here</p>
          <p className="text-xs text-muted-foreground">PDF, JPG, PNG, WebP or HEIC, up to 4 MB</p>
          <div className="mt-3">
            <FilePickers onPick={(f, from) => void accept(f, from)} label="Choose file" />
          </div>
        </div>
      )}
      {fileError && <p role="alert" className="text-sm text-over">{fileError}</p>}
      {file && features.receiptOcr && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" className="h-10" onClick={scan} disabled={scanning || pending}>
            {scanning ? "Reading the bill…" : "Read the bill"}
          </Button>
          <span className="text-xs text-muted-foreground">Optional. Fills empty fields for you to check; nothing is saved until you do.</span>
        </div>
      )}
      {scanNote && <p role="status" className="rounded-lg bg-secondary/70 p-2.5 text-xs">{scanNote}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={<>Supplier{check("supplierName")}</>} htmlFor="bill-supplier" error={errors.supplierName}>
          <Input id="bill-supplier" list="bill-suppliers" className="h-11" value={form.supplierName} onChange={(e) => set("supplierName", e.target.value)} />
          <datalist id="bill-suppliers">{suppliers.map((s) => <option key={s} value={s} />)}</datalist>
        </Field>
        <Field label={<>Bill number{check("billNumber")}</>} htmlFor="bill-no" optional error={errors.billNumber}>
          <Input id="bill-no" className="h-11" value={form.billNumber} onChange={(e) => set("billNumber", e.target.value)} />
        </Field>
        <Field label="Site" htmlFor="bill-site" error={errors.siteId}>
          <SelectField id="bill-site" value={form.siteId} onChange={(v) => set("siteId", v)} options={managed.map((s) => ({ value: s.id, label: s.name }))} />
        </Field>
        <Field label={<>Amount (₹){check("amount")}</>} htmlFor="bill-amount" error={errors.amount}>
          <Input id="bill-amount" inputMode="decimal" className="num h-11" value={form.amount} onChange={(e) => set("amount", e.target.value.replace(/[^\d.]/g, ""))} />
        </Field>
        <Field label={<>Bill date{check("billDate")}</>} htmlFor="bill-date" error={errors.billDate}>
          <Input id="bill-date" type="date" className="h-11" value={form.billDate} onChange={(e) => set("billDate", e.target.value)} />
        </Field>
        <Field label="Due date" htmlFor="bill-due" error={errors.dueDate}>
          <Input id="bill-due" type="date" className="h-11" value={form.dueDate} onChange={(e) => set("dueDate", e.target.value)} />
        </Field>
        <Field label="Category" htmlFor="bill-cat">
          <SelectField
            id="bill-cat"
            value={form.categoryCode}
            onChange={(v) => set("categoryCode", v)}
            options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_META[c].label }))}
          />
        </Field>
        <Field label="Items" htmlFor="bill-desc" optional error={errors.description}>
          <Input id="bill-desc" className="h-11" placeholder="e.g. PPC cement, 150 bags" value={form.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
      </div>

      <DialogFooter>
        <Button variant="outline" className="h-11" onClick={onDone} disabled={pending}>Cancel</Button>
        <Button className="h-11 px-5" onClick={save} disabled={pending || managed.length === 0}>
          {pending ? "Saving…" : "Save bill"}
        </Button>
      </DialogFooter>
    </div>
  );
}
