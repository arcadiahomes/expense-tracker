"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, useTransition, type FormEvent } from "react";
import { Ban, CircleCheck, Clock, Download, FileText, HandCoins, HardHat, OctagonAlert, Plus, ReceiptIndianRupee, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { methodLabel, PaymentForm, receiptPdfHref, StageBadge } from "@/components/client-payment-form";
import { Field, Stat, qty, useSubmit } from "@/components/form-bits";
import { PageHeader } from "@/components/page-header";
import { SelectField } from "@/components/select-field";
import { EmptyState } from "@/components/states";
import { shiftDate } from "@/lib/dates";
import { formatINRExact } from "@/lib/format";
import { useFormat, useSession } from "@/lib/session";
import type { ClientInvoice, ClientReceipt, InvoiceStatus, LabourInvoice, Page } from "@/lib/types";
import { cn } from "@/lib/utils";
import { loadInvoicePaymentsAction } from "@/server/actions/client-payments";
import { cancelInvoiceAction, createClientInvoiceAction, loadInvoicesAction } from "@/server/actions/invoices";
import type { invoiceTotals } from "@/server/data/invoices";

type SiteOption = { id: string; name: string; client: string };
type Filter = "all" | InvoiceStatus;
type Totals = Awaited<ReturnType<typeof invoiceTotals>>;
type ClientProps = { page: Page<ClientInvoice>; totals: Totals; filter: Filter; query: string };
type LabourProps = {
  siteId: string;
  workerId: string | null;
  from: string;
  to: string;
  invoice: LabourInvoice | null;
  error: string | null;
  workers: { id: string; name: string; trade: string }[];
};

const STATUS = {
  unpaid: { label: "Unpaid", icon: Clock, className: "bg-muted text-foreground" },
  overdue: { label: "Overdue", icon: OctagonAlert, className: "bg-over/12 text-over" },
  paid: { label: "Paid", icon: CircleCheck, className: "bg-good/12 text-good" },
  cancelled: { label: "Cancelled", icon: Ban, className: "bg-muted text-muted-foreground line-through" },
} as const;

const GST_OPTIONS = [
  { value: "0", label: "No GST" },
  { value: "5", label: "GST 5%" },
  { value: "12", label: "GST 12%" },
  { value: "18", label: "GST 18%" },
  { value: "28", label: "GST 28%" },
];

/** The invoice's PDF; the route checks access again. */
const pdfHref = (id: string) => `/api/invoices/client/${id}`;

function StatusBadge({ status }: { status: InvoiceStatus }) {
  const s = STATUS[status];
  const Icon = s.icon;
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium", s.className)}>
      <Icon className="size-3.5" aria-hidden />
      {s.label}
    </span>
  );
}

export function InvoicesNoAccess() {
  return (
    <>
      <PageHeader title="Invoices" />
      <EmptyState
        icon={ReceiptIndianRupee}
        title="No sites to invoice for"
        description="Invoices are for site owners and accountants. Ask the admin for one of those roles on a site."
      />
    </>
  );
}

export function InvoicesView({ sites, client, labour }: { sites: SiteOption[]; client?: ClientProps; labour?: LabourProps }) {
  const router = useRouter();
  const pathname = usePathname();
  const [creating, setCreating] = useState(false);
  const [switching, startSwitch] = useTransition();
  const tab = labour ? "labour" : "client";
  return (
    <>
      <PageHeader
        title="Invoices"
        description="Bill clients for work on their sites, and give workers an invoice of their wages for a period."
        actions={
          tab === "client" && (
            <Button className="h-11 px-4" onClick={() => setCreating(true)}>
              <Plus aria-hidden /> New invoice
            </Button>
          )
        }
      />
      <Tabs
        value={tab}
        onValueChange={(v) => startSwitch(() => router.replace(v === "labour" ? `${pathname}?tab=labour` : pathname, { scroll: false }))}
        className="mb-5"
      >
        <TabsList className="h-11!">
          <TabsTrigger value="client" className="px-3">
            <ReceiptIndianRupee aria-hidden /> Client invoices
          </TabsTrigger>
          <TabsTrigger value="labour" className="px-3">
            <HardHat aria-hidden /> Labour invoices
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <div aria-busy={switching} className={cn("transition-opacity", switching && "opacity-60")}>
        {client && <ClientInvoices {...client} sites={sites} onCreate={() => setCreating(true)} />}
        {labour && <LabourInvoices {...labour} sites={sites} />}
      </div>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
          {creating && <NewInvoiceForm sites={sites} onDone={() => setCreating(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---- Client invoices ---------------------------------------------------------------

function ClientInvoices({ page, totals, filter, query: initialQuery, sites, onCreate }: ClientProps & { sites: SiteOption[]; onCreate: () => void }) {
  const fmt = useFormat();
  const router = useRouter();
  const pathname = usePathname();
  const [query, setQuery] = useState(initialQuery);
  const [openId, setOpenId] = useState<string | null>(null);
  const [navigating, startNav] = useTransition();
  const [loadingMore, startMore] = useTransition();

  // Pages fetched with "Show more"; reset whenever the server sends a fresh first page.
  const [paged, setPaged] = useState({ base: page, extra: [] as ClientInvoice[], cursor: page.nextCursor });
  if (paged.base !== page) setPaged({ base: page, extra: [], cursor: page.nextCursor });
  const invoices = paged.base === page ? [...page.items, ...paged.extra] : page.items;
  const cursor = paged.base === page ? paged.cursor : page.nextCursor;
  const open = invoices.find((i) => i.id === openId);

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
      const res = await loadInvoicesAction({ status: filter, q: query.trim() || undefined, cursor });
      if (!res.ok) return void toast.error(res.error);
      setPaged((p) => ({ ...p, extra: [...p.extra, ...res.data.items], cursor: res.data.nextCursor }));
    });
  }

  if (totals.counts.all === 0) {
    return (
      <EmptyState
        icon={ReceiptIndianRupee}
        title="No client invoices yet"
        description={`Raise an invoice for work done on ${sites.length === 1 ? sites[0].name : "one of your sites"}. It's numbered for you and downloads as a PDF.`}
        action={<Button className="h-11 px-5" onClick={onCreate}><Plus aria-hidden /> New invoice</Button>}
      />
    );
  }

  return (
    <div className="grid gap-4 lg:gap-5">
      <section aria-label="Invoice totals" className="grid overflow-hidden surface rounded-xl sm:grid-cols-3">
        <div className="border-b p-4 sm:border-r sm:border-b-0 sm:p-5">
          <p className="text-sm text-muted-foreground">To receive</p>
          <p className="num font-display mt-1 text-[1.75rem] font-bold">{fmt.money(totals.outstanding)}</p>
        </div>
        <div className="border-b bg-over/6 p-4 sm:border-r sm:border-b-0 sm:p-5">
          <p className="flex items-center gap-1.5 text-sm text-over"><OctagonAlert className="size-4" aria-hidden /> Overdue</p>
          <p className="num font-display mt-1 text-xl font-bold sm:text-2xl">{fmt.money(totals.overdueAmount)}</p>
          <p className="text-xs text-muted-foreground">{totals.overdueCount} {totals.overdueCount === 1 ? "invoice" : "invoices"}</p>
        </div>
        <div className="p-4 sm:p-5">
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><CircleCheck className="size-4" aria-hidden /> Received</p>
          <p className="num font-display mt-1 text-xl font-bold sm:text-2xl">{fmt.money(totals.received)}</p>
          <p className="text-xs text-muted-foreground">{totals.counts.paid} paid in full · <Link href="/receipts" className="underline underline-offset-2 hover:text-foreground">receipts</Link></p>
        </div>
      </section>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={filter} onValueChange={(v) => navigate({ status: v as Filter })} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList className="h-11!">
            {(["all", "unpaid", "overdue", "paid", "cancelled"] as Filter[]).map((f) => (
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
            aria-label="Search invoices"
            placeholder="Client, invoice number or site"
            className="h-11 pl-9"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (e.target.value === "") navigate({ q: "" });
            }}
          />
        </form>
      </div>

      <section aria-label="Invoices" aria-busy={navigating} className={cn("surface rounded-xl transition-opacity", navigating && "opacity-60")}>
        {invoices.length === 0 ? (
          <EmptyState className="m-4 border-0" icon={Search} title="No invoices match" description="Try another client name or switch to All." />
        ) : (
          <ul className="divide-y">
            {invoices.map((inv) => (
              <li key={inv.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(inv.id)}
                  className="grid w-full grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3.5 text-left hover:bg-muted/50 focus-visible:-outline-offset-2 sm:px-5 md:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_auto_auto]"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{inv.client}</span>
                    <span className="block truncate text-xs text-muted-foreground">{inv.invoiceNo}, {inv.siteName}</span>
                  </span>
                  <span className="num row-start-2 text-xs text-muted-foreground md:row-start-auto md:text-sm">
                    {inv.status === "paid" && inv.paidOn
                      ? `Received ${fmt.date(inv.paidOn)}`
                      : `Due ${fmt.date(inv.dueDate)}${inv.paid > 0 && inv.status !== "cancelled" ? `, ${fmt.money(inv.balance)} left` : ""}`}
                  </span>
                  <span className="col-start-2 row-start-2 justify-self-end md:col-start-auto md:row-start-auto">
                    <StatusBadge status={inv.status} />
                  </span>
                  <span className="num col-start-2 row-start-1 text-right font-semibold md:col-start-auto md:row-start-auto md:w-32">{fmt.money(inv.total)}</span>
                </button>
              </li>
            ))}
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

      <InvoiceSheet invoice={open} onClose={() => setOpenId(null)} />
    </div>
  );
}

function InvoiceSheet({ invoice, onClose }: { invoice?: ClientInvoice; onClose: () => void }) {
  const fmt = useFormat();
  const send = useSubmit();
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<"pay" | "cancel" | null>(null);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const payments = useInvoicePayments(invoice?.id, invoice?.paid);

  function reset() {
    setMode(null);
    setReason("");
    setErrors({});
  }

  function cancel(e: FormEvent) {
    e.preventDefault();
    if (!invoice) return;
    start(async () => {
      const res = await send(() => cancelInvoiceAction({ id: invoice.id, reason }), setErrors);
      if (res) {
        toast.success("Invoice cancelled", { description: res.invoiceNo });
        reset();
      }
    });
  }

  const open = invoice?.status === "unpaid" || invoice?.status === "overdue";

  return (
    <Sheet open={!!invoice} onOpenChange={(o) => { if (!o) { onClose(); reset(); } }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg!">
        {invoice && (
          <>
            <SheetHeader className="border-b">
              <StatusBadge status={invoice.status} />
              <SheetTitle className="font-display text-xl font-bold">{invoice.client}</SheetTitle>
              <SheetDescription>{invoice.invoiceNo}, {invoice.siteName}</SheetDescription>
            </SheetHeader>
            <div className="space-y-5 px-4 pb-6">
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div><dt className="text-xs text-muted-foreground">Invoice date</dt><dd>{fmt.date(invoice.date)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Due date</dt><dd className={cn(invoice.status === "overdue" && "text-over")}>{fmt.date(invoice.dueDate)}</dd></div>
                {invoice.clientAddress && <div className="col-span-2"><dt className="text-xs text-muted-foreground">Address</dt><dd className="whitespace-pre-line">{invoice.clientAddress}</dd></div>}
                {invoice.clientPhone && <div><dt className="text-xs text-muted-foreground">Phone</dt><dd className="num">{invoice.clientPhone}</dd></div>}
                {invoice.clientEmail && <div className="min-w-0"><dt className="text-xs text-muted-foreground">Email</dt><dd className="truncate">{invoice.clientEmail}</dd></div>}
                {invoice.clientGstin && <div><dt className="text-xs text-muted-foreground">Client GSTIN</dt><dd className="num">{invoice.clientGstin}</dd></div>}
                <div><dt className="text-xs text-muted-foreground">Raised by</dt><dd>{invoice.createdBy}</dd></div>
              </dl>

              <div className="rounded-xl border">
                <ul className="divide-y text-sm">
                  {invoice.items.map((it, i) => (
                    <li key={i} className="flex items-start justify-between gap-3 px-3 py-2.5">
                      <span className="min-w-0">
                        <span className="block">{it.description}</span>
                        <span className="num block text-xs text-muted-foreground">{qty(it.quantity)} {it.unit} × {fmt.money(Number(it.unitPrice))}</span>
                      </span>
                      <span className="num shrink-0 font-medium">{fmt.money(Number(it.amount))}</span>
                    </li>
                  ))}
                </ul>
                <dl className="num space-y-1 border-t bg-secondary/50 px-3 py-2.5 text-sm">
                  <div className="flex justify-between"><dt className="text-muted-foreground">Subtotal</dt><dd>{fmt.money(invoice.subtotal)}</dd></div>
                  {invoice.gstPercent > 0 && <div className="flex justify-between"><dt className="text-muted-foreground">GST @ {invoice.gstPercent}%</dt><dd>{fmt.money(invoice.gst)}</dd></div>}
                  <div className="flex justify-between text-base font-semibold"><dt>Total</dt><dd>{fmt.money(invoice.total)}</dd></div>
                  {invoice.status !== "cancelled" && (
                    <>
                      <div className="flex justify-between border-t pt-1"><dt className="text-muted-foreground">Amount paid</dt><dd className="text-good">{formatINRExact(invoice.paid)}</dd></div>
                      <div className="flex justify-between font-semibold"><dt>Balance due</dt><dd>{formatINRExact(Math.max(invoice.balance, 0))}</dd></div>
                    </>
                  )}
                </dl>
              </div>

              {invoice.notes && <p className="text-sm whitespace-pre-line text-muted-foreground">{invoice.notes}</p>}
              {invoice.status === "paid" && invoice.paidOn && (
                <p className="rounded-lg bg-good/10 p-3 text-sm">
                  Paid in full. Last payment received on {fmt.date(invoice.paidOn)} by {invoice.paidMethod ? methodLabel(invoice.paidMethod) : "—"}
                  {invoice.paidReference && `, reference ${invoice.paidReference}`}.
                </p>
              )}
              {invoice.status === "cancelled" && <p className="rounded-lg bg-muted p-3 text-sm">Cancelled: {invoice.cancelReason}</p>}

              {payments && payments.length > 0 && (
                <section aria-label="Payments received" className="rounded-xl border">
                  <h3 className="px-3 pt-3 text-sm font-semibold">Payments received</h3>
                  <ul className="mt-1 divide-y text-sm">
                    {payments.map((p) => (
                      <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                        <span className="min-w-0">
                          <a href={receiptPdfHref(p.id)} className="num block truncate font-medium text-primary hover:underline">{p.receiptNo}</a>
                          <span className="block truncate text-xs text-muted-foreground">{fmt.date(p.date)} · {methodLabel(p.method)}</span>
                        </span>
                        <span className="grid shrink-0 justify-items-end gap-1">
                          <span className={cn("num font-medium", p.kind !== "payment" && "text-over")}>{p.kind === "payment" ? "" : "− "}{formatINRExact(p.amount)}</span>
                          <StageBadge stage={p.stage} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <a href={pdfHref(invoice.id)} className={cn(buttonVariants(), "h-11 w-full")}>
                <Download aria-hidden /> Download PDF
              </a>

              {open && mode === null && (
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" className="h-11" onClick={() => setMode("pay")}><HandCoins aria-hidden /> Record payment</Button>
                  <Button variant="outline" className="h-11 text-over" onClick={() => setMode("cancel")}><Ban aria-hidden /> Cancel invoice</Button>
                </div>
              )}

              {open && mode === "pay" && (
                <div className="rounded-xl bg-secondary/40 p-4">
                  <PaymentForm
                    idPrefix="inv-pay"
                    invoiceId={invoice.id}
                    invoices={[{ id: invoice.id, invoiceNo: invoice.invoiceNo, date: invoice.date, client: invoice.client, siteName: invoice.siteName, total: invoice.total, paid: invoice.paid, balance: invoice.balance, overdue: invoice.status === "overdue" }]}
                    onCancel={reset}
                    onDone={reset}
                  />
                </div>
              )}

              {open && mode === "cancel" && (
                <form className="grid gap-3 rounded-xl bg-over/6 p-4" onSubmit={cancel}>
                  <Field id="inv-cancel-reason" label="Why cancel it?" error={errors.reason}>
                    <Textarea id="inv-cancel-reason" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Wrong rate; reissued as a new invoice" />
                  </Field>
                  <p className="text-xs text-muted-foreground">The invoice keeps its number and stays listed as cancelled. Issue a new one to correct it. Money already received must be refunded or reversed first, on the Receipts page.</p>
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="ghost" className="h-11" onClick={reset} disabled={pending}>Back</Button>
                    <Button type="submit" variant="destructive" className="h-11 px-5" disabled={pending || !reason.trim()}>{pending ? "Cancelling…" : "Cancel invoice"}</Button>
                  </div>
                </form>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** The invoice's ledger entries, loaded when the sheet opens and again whenever what's paid changes. */
function useInvoicePayments(invoiceId: string | undefined, paid: number | undefined) {
  const [state, setState] = useState<{ key: string; entries: ClientReceipt[] } | null>(null);
  const key = invoiceId ? `${invoiceId}:${paid}` : "";
  useEffect(() => {
    if (!invoiceId) return;
    let live = true;
    loadInvoicePaymentsAction(invoiceId).then(
      (res) => live && res.ok && setState({ key: `${invoiceId}:${paid}`, entries: res.data.entries }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [invoiceId, paid]);
  return state?.key === key ? state.entries : null;
}

type ItemRow = { key: number; description: string; quantity: string; unit: string; unitPrice: string };

/** Paise, for the preview only: the server works out the real totals in SQL. */
const paise = (v: string) => Math.round(Number(v || 0) * 100);

function NewInvoiceForm({ sites, onDone }: { sites: SiteOption[]; onDone: () => void }) {
  const { today, activeSiteId } = useSession();
  const fmt = useFormat();
  const send = useSubmit();
  const [pending, start] = useTransition();
  const first = sites.find((s) => s.id === activeSiteId) ?? sites[0];
  const [form, setForm] = useState({
    siteId: first.id,
    clientName: first.client,
    clientAddress: "",
    clientPhone: "",
    clientEmail: "",
    clientGstin: "",
    invoiceNumber: "",
    invoiceDate: today,
    dueDate: shiftDate(today, 15),
    gstPercent: "0",
    notes: "",
  });
  const [items, setItems] = useState<ItemRow[]>([{ key: 0, description: "", quantity: "1", unit: "lot", unitPrice: "" }]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setItem = (key: number, patch: Partial<ItemRow>) => setItems((list) => list.map((it) => (it.key === key ? { ...it, ...patch } : it)));

  const subtotal = items.reduce((t, it) => t + Math.round((Number(it.quantity || 0) * paise(it.unitPrice))), 0);
  const gst = Math.round((subtotal * Number(form.gstPercent)) / 100);

  function pickSite(id: string) {
    const site = sites.find((s) => s.id === id);
    const prev = sites.find((s) => s.id === form.siteId);
    // Follow the site's recorded client unless the name was typed in by hand.
    setForm((f) => ({ ...f, siteId: id, clientName: !f.clientName || f.clientName === prev?.client ? (site?.client ?? "") : f.clientName }));
  }

  function save(e: FormEvent) {
    e.preventDefault();
    start(async () => {
      const res = await send(
        () =>
          createClientInvoiceAction({
            ...form,
            items: items.filter((it) => it.description.trim() || it.unitPrice).map(({ description, quantity, unit, unitPrice }) => ({ description, quantity, unit, unitPrice })),
          }),
        setErrors,
      );
      if (res) {
        toast.success(`Invoice ${res.invoiceNo} created`, {
          description: `${fmt.money(res.total)} to ${res.client}`,
          action: { label: "Download", onClick: () => window.location.assign(pdfHref(res.id)) },
        });
        onDone();
      }
    });
  }

  return (
    <form className="grid gap-4" onSubmit={save}>
      <DialogHeader>
        <DialogTitle className="font-display text-xl font-bold">New client invoice</DialogTitle>
        <DialogDescription>Bill the client for work on a site. Leave the number blank to use the next one in this financial year&rsquo;s series.</DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="inv-site" label="Site" error={errors.siteId}>
          <SelectField id="inv-site" value={form.siteId} onChange={pickSite} options={sites.map((s) => ({ value: s.id, label: s.name }))} />
        </Field>
        <Field id="inv-no" label="Invoice number (optional)" error={errors.invoiceNumber}>
          <Input id="inv-no" className="h-11" placeholder="Automatic" maxLength={40} value={form.invoiceNumber} onChange={(e) => set("invoiceNumber", e.target.value)} />
        </Field>
        <Field id="inv-client" label="Client" error={errors.clientName}>
          <Input id="inv-client" className="h-11" maxLength={120} value={form.clientName} onChange={(e) => set("clientName", e.target.value)} />
        </Field>
        <Field id="inv-gstin" label="Client GSTIN (optional)" error={errors.clientGstin}>
          <Input id="inv-gstin" className="num h-11 uppercase" maxLength={15} value={form.clientGstin} onChange={(e) => set("clientGstin", e.target.value)} />
        </Field>
        <Field id="inv-phone" label="Client phone (optional)" error={errors.clientPhone}>
          <Input id="inv-phone" type="tel" autoComplete="off" className="num h-11" maxLength={30} value={form.clientPhone} onChange={(e) => set("clientPhone", e.target.value)} />
        </Field>
        <Field id="inv-email" label="Client email (optional)" error={errors.clientEmail}>
          <Input id="inv-email" type="email" autoComplete="off" className="h-11" maxLength={254} value={form.clientEmail} onChange={(e) => set("clientEmail", e.target.value)} />
        </Field>
        <Field id="inv-address" label="Client address (optional)" error={errors.clientAddress} className="sm:col-span-2">
          <Textarea id="inv-address" rows={2} maxLength={300} value={form.clientAddress} onChange={(e) => set("clientAddress", e.target.value)} />
        </Field>
        <Field id="inv-date" label="Invoice date" error={errors.invoiceDate}>
          <Input id="inv-date" type="date" className="h-11" value={form.invoiceDate} onChange={(e) => set("invoiceDate", e.target.value)} />
        </Field>
        <Field id="inv-due" label="Due date" error={errors.dueDate}>
          <Input id="inv-due" type="date" min={form.invoiceDate} className="h-11" value={form.dueDate} onChange={(e) => set("dueDate", e.target.value)} />
        </Field>
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1.5 text-sm font-medium">Items</legend>
        <div aria-hidden className="hidden grid-cols-[minmax(0,1fr)_5rem_5rem_7rem_2.75rem] gap-2 text-xs text-muted-foreground sm:grid">
          <span>Description</span>
          <span>Qty</span>
          <span>Unit</span>
          <span>Rate (₹)</span>
        </div>
        {items.map((it, i) => (
          <div key={it.key} className="grid grid-cols-[1fr_auto] gap-2 rounded-xl border p-2.5 sm:grid-cols-[minmax(0,1fr)_5rem_5rem_7rem_2.75rem] sm:border-0 sm:p-0">
            <Input aria-label={`Item ${i + 1} description`} aria-invalid={!!errors[`items.${i}.description`]} className="h-11" placeholder="e.g. Second floor slab, running bill 3" maxLength={200} value={it.description} onChange={(e) => setItem(it.key, { description: e.target.value })} />
            <div className="col-span-2 grid grid-cols-3 gap-2 sm:contents">
              <Input aria-label={`Item ${i + 1} quantity`} placeholder="Qty" aria-invalid={!!errors[`items.${i}.quantity`]} inputMode="decimal" className="num h-11" value={it.quantity} onChange={(e) => setItem(it.key, { quantity: e.target.value.replace(/[^\d.]/g, "") })} />
              <Input aria-label={`Item ${i + 1} unit`} placeholder="Unit" className="h-11" maxLength={20} value={it.unit} onChange={(e) => setItem(it.key, { unit: e.target.value })} />
              <Input aria-label={`Item ${i + 1} rate in rupees`} aria-invalid={!!errors[`items.${i}.unitPrice`]} inputMode="decimal" placeholder="Rate ₹" className="num h-11" value={it.unitPrice} onChange={(e) => setItem(it.key, { unitPrice: e.target.value.replace(/[^\d.]/g, "") })} />
            </div>
            <Button type="button" variant="ghost" size="icon" className="col-start-2 row-start-1 size-11 sm:col-start-auto sm:row-start-auto" aria-label={`Remove item ${i + 1}`} disabled={items.length === 1} onClick={() => setItems((list) => list.filter((x) => x.key !== it.key))}>
              <Trash2 aria-hidden />
            </Button>
          </div>
        ))}
        {(errors.items || Object.entries(errors).find(([k]) => k.startsWith("items."))?.[1]) && (
          <p role="alert" className="text-xs font-medium text-over">{errors.items ?? Object.entries(errors).find(([k]) => k.startsWith("items."))?.[1]}</p>
        )}
        <Button
          type="button"
          variant="outline"
          className="h-10 justify-self-start"
          disabled={items.length >= 50}
          onClick={() => setItems((list) => [...list, { key: Math.max(...list.map((x) => x.key)) + 1, description: "", quantity: "1", unit: "lot", unitPrice: "" }])}
        >
          <Plus aria-hidden /> Add item
        </Button>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid content-start gap-4">
          <Field id="inv-gst" label="GST" hint="Applied to the subtotal at the rate you pick." error={errors.gstPercent}>
            <SelectField id="inv-gst" value={form.gstPercent} onChange={(v) => set("gstPercent", v)} options={GST_OPTIONS} />
          </Field>
          <Field id="inv-notes" label="Notes (optional)" hint="Bank details, terms or anything the client should see." error={errors.notes}>
            <Textarea id="inv-notes" rows={3} maxLength={1000} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
          </Field>
        </div>
        <dl className="num grid content-start gap-1.5 rounded-xl bg-secondary/70 p-4 text-sm" aria-live="polite">
          <div className="flex justify-between"><dt className="text-muted-foreground">Subtotal</dt><dd>{fmt.money(subtotal / 100)}</dd></div>
          {form.gstPercent !== "0" && <div className="flex justify-between"><dt className="text-muted-foreground">GST @ {form.gstPercent}%</dt><dd>{fmt.money(gst / 100)}</dd></div>}
          <div className="flex justify-between border-t pt-1.5 text-base font-semibold"><dt>Total</dt><dd>{fmt.money((subtotal + gst) / 100)}</dd></div>
        </dl>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" className="h-11" onClick={onDone} disabled={pending}>Cancel</Button>
        <Button type="submit" className="h-11 px-5" disabled={pending}>{pending ? "Saving…" : "Create invoice"}</Button>
      </DialogFooter>
    </form>
  );
}

// ---- Labour invoices ---------------------------------------------------------------

const DAY_LABEL = { present: "Present", half_day: "Half day" } as const;

function LabourInvoices({ siteId, workerId, from, to, invoice, error, workers, sites }: LabourProps & { sites: SiteOption[] }) {
  const { today } = useSession();
  const fmt = useFormat();
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  // What's typed in the date fields; applied to the URL with "Show".
  const [range, setRange] = useState({ from, to });

  function go(next: Partial<{ site: string; worker: string | null; from: string; to: string }>) {
    const params = new URLSearchParams({ tab: "labour", site: next.site ?? siteId });
    const worker = next.site && next.site !== siteId ? null : next.worker === undefined ? workerId : next.worker;
    if (worker) params.set("worker", worker);
    params.set("from", next.from ?? range.from);
    params.set("to", next.to ?? range.to);
    start(() => router.replace(`${pathname}?${params}`, { scroll: false }));
  }

  const validRange = !!range.from && !!range.to && range.from <= range.to && range.to <= today;
  const pdf = invoice && `/api/invoices/labour?${new URLSearchParams({ site: siteId, worker: invoice.worker.id, from, to })}`;
  const closing = invoice ? Number(invoice.closing) : 0;

  return (
    <div className="grid gap-4 lg:gap-5" aria-busy={pending}>
      <form
        className="surface grid gap-3 rounded-xl p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-[1fr_1fr_10rem_10rem_auto] lg:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (validRange) go({});
        }}
      >
        <Field id="li-site" label="Site">
          <SelectField id="li-site" value={siteId} onChange={(id) => go({ site: id })} options={sites.map((s) => ({ value: s.id, label: s.name }))} />
        </Field>
        <Field id="li-worker" label="Worker">
          <SelectField
            id="li-worker"
            value={workerId}
            placeholder={workers.length ? "Pick a worker" : "No workers on this site"}
            onChange={(id) => go({ worker: id })}
            options={workers.map((w) => ({ value: w.id, label: w.trade ? `${w.name} (${w.trade})` : w.name }))}
          />
        </Field>
        <Field id="li-from" label="From">
          <Input id="li-from" type="date" max={today} className="h-11" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
        </Field>
        <Field id="li-to" label="To">
          <Input id="li-to" type="date" max={today} className="h-11" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </Field>
        <Button type="submit" variant="outline" className="h-11" disabled={!validRange || pending}>
          {pending ? "Loading…" : "Show"}
        </Button>
        {!validRange && <p role="alert" className="text-sm text-over sm:col-span-2 lg:col-span-5">Pick a start on or before the end, ending today or earlier.</p>}
      </form>

      {error && <p role="alert" className="rounded-lg bg-over/8 p-3 text-sm text-over">{error}</p>}

      {!invoice ? (
        !error && (
          <EmptyState
            icon={HardHat}
            title={workers.length ? "Pick a worker" : "No workers on this site yet"}
            description={
              workers.length
                ? "Their attendance and payments for the period become an invoice you can download and hand over."
                : "Add workers and mark attendance on the Labour page, then come back to invoice their wages."
            }
          />
        )
      ) : (
        <div className={cn("grid gap-4 transition-opacity lg:gap-5", pending && "opacity-60")}>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-display text-xl font-bold">{invoice.worker.name}</h2>
              <p className="text-sm text-muted-foreground">
                {invoice.site.name}, {fmt.date(invoice.from)} to {fmt.date(invoice.to)}
              </p>
            </div>
            {pdf && (
              <a href={pdf} className={cn(buttonVariants(), "h-11 px-5")}>
                <Download aria-hidden /> Download PDF
              </a>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Days worked" value={invoice.days} hint={Number(invoice.opening) !== 0 ? `${Number(invoice.opening) < 0 ? "Advance carried in" : "Owed from before"}: ${fmt.money(Math.abs(Number(invoice.opening)))}` : "Nothing carried in"} />
            <Stat label="Wages earned" value={fmt.money(Number(invoice.earned))} />
            <Stat label="Paid in period" value={fmt.money(Number(invoice.wagesPaid) + Number(invoice.advances))} hint={Number(invoice.advances) > 0 ? `${fmt.money(Number(invoice.advances))} as advances` : "Wages"} />
            <Stat label={closing < 0 ? "Advance outstanding" : "Amount payable"} value={fmt.money(Math.abs(closing))} tone={closing > 0 ? "warn" : closing < 0 ? undefined : "good"} />
          </div>

          <section className="surface rounded-xl" aria-label="Attendance">
            <h3 className="px-4 pt-4 text-base font-semibold sm:px-5">Attendance</h3>
            {invoice.attendance.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted-foreground sm:px-5">No attendance in this period.</p>
            ) : (
              <ul className="mt-2 divide-y text-sm">
                {invoice.attendance.map((a) => (
                  <li key={a.date} className="grid grid-cols-[1fr_auto] gap-x-4 px-4 py-2.5 sm:grid-cols-[8rem_6rem_1fr_auto] sm:px-5">
                    <span>{fmt.date(a.date)}</span>
                    <span className="text-muted-foreground max-sm:hidden">{DAY_LABEL[a.status]}</span>
                    <span className="truncate text-muted-foreground max-sm:col-start-1 max-sm:text-xs">
                      <span className="sm:hidden">{DAY_LABEL[a.status]}{a.workType && ", "}</span>{a.workType}
                    </span>
                    <span className="num text-right font-medium max-sm:col-start-2 max-sm:row-start-1">{fmt.money(Number(a.amount))}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="surface rounded-xl" aria-label="Payments">
            <h3 className="px-4 pt-4 text-base font-semibold sm:px-5">Payments in this period</h3>
            {invoice.payments.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted-foreground sm:px-5">No payments in this period.</p>
            ) : (
              <ul className="mt-2 divide-y text-sm">
                {invoice.payments.map((p, i) => (
                  <li key={i} className="flex items-center justify-between gap-4 px-4 py-2.5 sm:px-5">
                    <span className="min-w-0">
                      <span className="block truncate">{p.description}</span>
                      <span className="block text-xs text-muted-foreground">{fmt.date(p.date)}, {p.kind === "advance" ? "advance" : "wages"}</span>
                    </span>
                    <span className="num shrink-0 font-medium">{fmt.money(Number(p.amount))}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <FileText className="size-3.5" aria-hidden /> The PDF is an internal statement of wages, not a tax invoice. Payments are recorded on the Labour page.
          </p>
        </div>
      )}
    </div>
  );
}
