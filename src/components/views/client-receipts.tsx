"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type FormEvent } from "react";
import { Building2, ChevronDown, Download, FileText, History, Plus, Printer, ReceiptIndianRupee, ReceiptText, Search, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { methodLabel, PaymentForm, receiptPdfHref, RefundForm, STAGE, StageBadge, StandaloneReceiptForm, type PayableInvoice } from "@/components/client-payment-form";
import { Field } from "@/components/form-bits";
import { PageHeader } from "@/components/page-header";
import { SelectField } from "@/components/select-field";
import { EmptyState } from "@/components/states";
import { formatINRExact as exact } from "@/lib/format";
import { can } from "@/lib/permissions";
import { useFormat, useSession } from "@/lib/session";
import type { ClientInvoice, ClientReceipt, Page, ProjectCollection, ReceiptStage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { loadInvoicePaymentsAction, loadReceiptsAction } from "@/server/actions/client-payments";
import { loadInvoicesAction } from "@/server/actions/invoices";

type SiteOption = { id: string; name: string };
type Filters = { siteId: string; stage: "all" | ReceiptStage; from: string; to: string; q: string };
type Collections = { projects: ProjectCollection[]; total: Omit<ProjectCollection, "siteId" | "siteName" | "client"> };

const STAGE_OPTIONS = [
  { value: "all", label: "All types" },
  ...(Object.entries(STAGE) as [ReceiptStage, (typeof STAGE)[ReceiptStage]][]).map(([value, s]) => ({ value, label: s.label })),
] as { value: Filters["stage"]; label: string }[];

const invoicePdfHref = (id: string) => `/api/invoices/client/${id}`;

/** Opens the receipt PDF in a new tab, where the browser's viewer prints it. */
function printReceipt(id: string) {
  const tab = window.open(receiptPdfHref(id, true), "_blank");
  if (tab) tab.opener = null;
  else window.location.assign(receiptPdfHref(id, true));
}

/** Whether the signed-in person may refund or reverse payments on the site. */
function useCanRefund() {
  const { sites } = useSession();
  return (siteId: string) => can(sites.find((s) => s.id === siteId)?.role, "payment:refund");
}

export function ReceiptsNoAccess() {
  return (
    <>
      <PageHeader title="Receipts" />
      <EmptyState
        icon={ReceiptIndianRupee}
        title="No sites to take payments for"
        description="Receipts are for site owners and accountants. Ask the admin for one of those roles on a site."
      />
    </>
  );
}

export function ReceiptsView({
  tab,
  sites,
  page,
  filters,
  collections,
  payable,
}: {
  tab: "receipts" | "projects";
  sites: SiteOption[];
  page: Page<ClientReceipt>;
  filters: Filters;
  collections: Collections;
  payable: PayableInvoice[];
}) {
  const fmt = useFormat();
  const router = useRouter();
  const pathname = usePathname();
  const [switching, startSwitch] = useTransition();
  // null: closed; "": pick an invoice; an id: that invoice.
  const [recording, setRecording] = useState<string | null>(null);
  const [general, setGeneral] = useState(false);
  const [receipt, setReceipt] = useState<ClientReceipt | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  // Bumped after every write so an open history sheet reloads.
  const [version, setVersion] = useState(0);
  const { total } = collections;

  const record = (invoiceId = "") => setRecording(invoiceId);
  const recordedFor = recording ? payable.find((i) => i.id === recording) : undefined;

  return (
    <>
      <PageHeader
        title="Receipts"
        description="Record what clients pay against their invoices, or anything received without one, hand them a receipt for every payment, and follow each project's balance."
        actions={
          <>
            <Button variant="outline" className="h-11 px-4" onClick={() => setGeneral(true)}>
              <ReceiptText aria-hidden /> New receipt
            </Button>
            <Button className="h-11 px-4" onClick={() => record()} disabled={!payable.length}>
              <Plus aria-hidden /> Record payment
            </Button>
          </>
        }
      />

      <section aria-label="Collection totals" className="surface mb-5 grid grid-cols-2 overflow-hidden rounded-xl lg:grid-cols-4">
        <TotalCell label="Total project value" value={fmt.money(total.value)} hint={`${total.invoices} ${total.invoices === 1 ? "invoice" : "invoices"}`} />
        <TotalCell label="Collected" value={fmt.money(total.collected)} hint={`${total.receipts} ${total.receipts === 1 ? "receipt" : "receipts"}`} tone="good" />
        <TotalCell label="Refunds and reversals" value={fmt.money(total.refunded)} hint={total.refunded > 0 ? `Net ${fmt.money(total.collected - total.refunded)}` : "None"} />
        <TotalCell label="Outstanding" value={fmt.money(total.outstanding)} hint="Still to receive" tone={total.outstanding > 0 ? "warn" : undefined} strong />
      </section>

      <Tabs
        value={tab}
        onValueChange={(v) => startSwitch(() => router.replace(v === "projects" ? `${pathname}?tab=projects` : pathname, { scroll: false }))}
        className="mb-5"
      >
        <TabsList className="h-11!">
          <TabsTrigger value="receipts" className="px-3">
            <ReceiptIndianRupee aria-hidden /> All receipts
          </TabsTrigger>
          <TabsTrigger value="projects" className="px-3">
            <Building2 aria-hidden /> By project
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div aria-busy={switching} className={cn("transition-opacity", switching && "opacity-60")}>
        {tab === "receipts" ? (
          <ReceiptList page={page} filters={filters} sites={sites} onOpen={setReceipt} onRecord={payable.length ? () => record() : undefined} onGeneral={() => setGeneral(true)} />
        ) : (
          <ProjectList projects={collections.projects} version={version} onHistory={setHistoryId} />
        )}
      </div>

      <Dialog open={recording !== null} onOpenChange={(o) => !o && setRecording(null)}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="font-display text-xl font-bold">Record a payment</DialogTitle>
            <DialogDescription>
              {recordedFor ? `${recordedFor.invoiceNo} · ${recordedFor.client} · ${recordedFor.siteName}` : "Money received from a client against one of their invoices."}
            </DialogDescription>
          </DialogHeader>
          {recording !== null && (
            <PaymentForm
              invoices={payable}
              invoiceId={recording || undefined}
              onCancel={() => setRecording(null)}
              onDone={(r) => {
                setRecording(null);
                setVersion((v) => v + 1);
                setReceipt(r);
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={general} onOpenChange={setGeneral}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="font-display text-xl font-bold">New receipt</DialogTitle>
            <DialogDescription>Money received without an invoice, such as a token advance or a deposit. It gets the next receipt number.</DialogDescription>
          </DialogHeader>
          {general && (
            <StandaloneReceiptForm
              sites={sites}
              onCancel={() => setGeneral(false)}
              onDone={(r) => {
                setGeneral(false);
                setVersion((v) => v + 1);
                setReceipt(r);
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <ReceiptSheet
        receipt={receipt}
        onClose={() => setReceipt(null)}
        onHistory={(id) => {
          setReceipt(null);
          setHistoryId(id);
        }}
        onChanged={(r) => {
          setVersion((v) => v + 1);
          setReceipt(r);
        }}
      />
      <InvoiceHistorySheet
        invoiceId={historyId}
        version={version}
        canRecord={(id) => payable.some((i) => i.id === id)}
        onClose={() => setHistoryId(null)}
        onRecord={(id) => record(id)}
        onOpen={(r) => {
          setHistoryId(null);
          setReceipt(r);
        }}
      />
    </>
  );
}

function TotalCell({ label, value, hint, tone, strong }: { label: string; value: string; hint: string; tone?: "good" | "warn"; strong?: boolean }) {
  return (
    <div className={cn("border-b p-4 odd:border-r sm:p-5 lg:border-r lg:border-b-0 lg:last:border-r-0", strong && "bg-primary/5")}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={cn("num font-display mt-1 text-xl font-bold sm:text-2xl", tone === "good" && "text-good", tone === "warn" && "text-warn")}>{value}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

// ---- All receipts ----------------------------------------------------------------

function ReceiptList({
  page,
  filters,
  sites,
  onOpen,
  onRecord,
  onGeneral,
}: {
  page: Page<ClientReceipt>;
  filters: Filters;
  sites: SiteOption[];
  onOpen: (r: ClientReceipt) => void;
  onRecord?: () => void;
  onGeneral: () => void;
}) {
  const fmt = useFormat();
  const { today } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [draft, setDraft] = useState(filters);
  const [navigating, startNav] = useTransition();
  const [loadingMore, startMore] = useTransition();

  // Pages fetched with "Show more"; reset whenever the server sends a fresh first page.
  const [paged, setPaged] = useState({ base: page, extra: [] as ClientReceipt[], cursor: page.nextCursor });
  if (paged.base !== page) setPaged({ base: page, extra: [], cursor: page.nextCursor });
  const receipts = paged.base === page ? [...page.items, ...paged.extra] : page.items;
  const cursor = paged.base === page ? paged.cursor : page.nextCursor;

  const filtered = !!(filters.siteId || filters.stage !== "all" || filters.from || filters.to || filters.q);
  const badRange = !!draft.from && !!draft.to && draft.from > draft.to;

  function apply(next: Filters) {
    setDraft(next);
    const params = new URLSearchParams();
    if (next.siteId) params.set("site", next.siteId);
    if (next.stage !== "all") params.set("stage", next.stage);
    if (next.from) params.set("from", next.from);
    if (next.to) params.set("to", next.to);
    if (next.q.trim()) params.set("q", next.q.trim());
    startNav(() => router.replace(params.size ? `${pathname}?${params}` : pathname, { scroll: false }));
  }

  function loadMore() {
    if (!cursor) return;
    startMore(async () => {
      const res = await loadReceiptsAction({
        siteId: filters.siteId || undefined,
        stage: filters.stage,
        from: filters.from || undefined,
        to: filters.to || undefined,
        q: filters.q || undefined,
        cursor,
      });
      if (!res.ok) return void toast.error(res.error);
      setPaged((p) => ({ ...p, extra: [...p.extra, ...res.data.items], cursor: res.data.nextCursor }));
    });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!badRange) apply(draft);
  }

  if (!receipts.length && !filtered) {
    return (
      <EmptyState
        icon={ReceiptIndianRupee}
        title="No receipts yet"
        description={`${onRecord ? "Record the first payment against an invoice" : "Raise a client invoice on the Invoices page to record payments against it"}, or create a receipt for money received without one. Each gets its own numbered receipt to download, print or share.`}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="outline" className="h-11 px-5" onClick={onGeneral}><ReceiptText aria-hidden /> New receipt</Button>
            {onRecord && <Button className="h-11 px-5" onClick={onRecord}><Plus aria-hidden /> Record payment</Button>}
          </div>
        }
      />
    );
  }

  return (
    <div className="grid gap-4">
      <form role="search" aria-label="Filter receipts" onSubmit={submit} className="surface grid gap-3 rounded-xl p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_9.5rem_9.5rem_auto] lg:items-end">
        <Field id="rc-q" label="Search">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input id="rc-q" type="search" className="h-11 pl-9" placeholder="Client, receipt or invoice no." value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} />
          </div>
        </Field>
        <Field id="rc-site" label="Project">
          <SelectField id="rc-site" value={draft.siteId || "all"} onChange={(v) => apply({ ...draft, siteId: v === "all" ? "" : v })} options={[{ value: "all", label: "All projects" }, ...sites.map((s) => ({ value: s.id, label: s.name }))]} />
        </Field>
        <Field id="rc-stage" label="Payment status">
          <SelectField id="rc-stage" value={draft.stage} onChange={(v) => apply({ ...draft, stage: v })} options={STAGE_OPTIONS} />
        </Field>
        <Field id="rc-from" label="From">
          <Input id="rc-from" type="date" max={today} className="h-11" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </Field>
        <Field id="rc-to" label="To">
          <Input id="rc-to" type="date" max={today} className="h-11" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </Field>
        <div className="flex gap-2 sm:col-span-2 lg:col-span-1">
          <Button type="submit" variant="outline" className="h-11 flex-1 lg:flex-none" disabled={badRange || navigating}>
            {navigating ? "Loading…" : "Apply"}
          </Button>
          {filtered && (
            <Button type="button" variant="ghost" className="h-11" onClick={() => apply({ siteId: "", stage: "all", from: "", to: "", q: "" })}>
              <X aria-hidden /> Clear
            </Button>
          )}
        </div>
        {badRange && <p role="alert" className="text-sm text-over sm:col-span-2 lg:col-span-6">The start date is after the end date.</p>}
      </form>

      <section aria-label="Receipts" aria-busy={navigating} className={cn("surface overflow-hidden rounded-xl transition-opacity", navigating && "opacity-60")}>
        {receipts.length === 0 ? (
          <EmptyState className="m-4 border-0" icon={Search} title="No receipts match" description="Try another client, project or date range, or clear the filters." />
        ) : (
          <>
            {/* Phones and tablets: one card per receipt. */}
            <ul className="divide-y lg:hidden">
              {receipts.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => onOpen(r)} className="grid w-full grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 px-4 py-3.5 text-left hover:bg-muted/50 focus-visible:-outline-offset-2">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{r.client}</span>
                      <span className="num block truncate text-xs text-muted-foreground">{r.receiptNo} · {fmt.date(r.date)}</span>
                    </span>
                    <span className={cn("num text-right font-semibold", r.kind !== "payment" && "text-over")}>{r.kind === "payment" ? "" : "− "}{exact(r.amount)}</span>
                    <span className="min-w-0 truncate text-xs text-muted-foreground">{r.siteName} · {r.invoiceNo ?? "No invoice"}</span>
                    <span className="justify-self-end"><StageBadge stage={r.stage} /></span>
                  </button>
                </li>
              ))}
            </ul>
            {/* Desktop: a table. */}
            <div className="hidden lg:block">
              <table className="w-full text-sm">
                <thead className="border-b bg-secondary/60 text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-5 py-2.5 font-medium">Receipt</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Date</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Client and project</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Invoice</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Method</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Amount</th>
                    <th scope="col" className="px-5 py-2.5 text-right font-medium">Balance after</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {receipts.map((r) => (
                    <tr key={r.id} className="cursor-pointer hover:bg-muted/50" onClick={() => onOpen(r)}>
                      <td className="px-5 py-3">
                        <button type="button" className="num font-medium text-primary hover:underline" onClick={(e) => { e.stopPropagation(); onOpen(r); }}>
                          {r.receiptNo}
                        </button>
                        {r.reversed && <span className="ml-1.5 text-xs text-over">reversed</span>}
                      </td>
                      <td className="num px-3 py-3 whitespace-nowrap">{fmt.date(r.date)}</td>
                      <td className="max-w-56 px-3 py-3">
                        <span className="block truncate font-medium">{r.client}</span>
                        <span className="block truncate text-xs text-muted-foreground">{r.siteName}</span>
                      </td>
                      <td className="num px-3 py-3 whitespace-nowrap text-muted-foreground">{r.invoiceNo ?? "No invoice"}</td>
                      <td className="px-3 py-3"><StageBadge stage={r.stage} /></td>
                      <td className="px-3 py-3 whitespace-nowrap text-muted-foreground">{methodLabel(r.method)}</td>
                      <td className={cn("num px-3 py-3 text-right font-semibold whitespace-nowrap", r.kind !== "payment" && "text-over")}>{r.kind === "payment" ? "" : "− "}{exact(r.amount)}</td>
                      <td className="num px-5 py-3 text-right whitespace-nowrap text-muted-foreground">{r.balanceAfter === null ? "–" : exact(Math.max(r.balanceAfter, 0))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {cursor && (
          <div className="flex justify-center border-t p-4">
            <Button variant="outline" className="h-11 px-5" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Show more"}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

// ---- One receipt -----------------------------------------------------------------

function ReceiptSheet({ receipt, onClose, onHistory, onChanged }: { receipt: ClientReceipt | null; onClose: () => void; onHistory: (invoiceId: string) => void; onChanged: (r: ClientReceipt) => void }) {
  const fmt = useFormat();
  const canRefund = useCanRefund();
  const [refunding, setRefunding] = useState(false);
  const r = receipt;
  const payment = r?.kind === "payment";
  const givesBack = !!r && payment && !r.reversed && r.refunded < r.amount && canRefund(r.siteId);

  return (
    <Sheet open={!!r} onOpenChange={(o) => { if (!o) { onClose(); setRefunding(false); } }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg!">
        {r && (
          <>
            <SheetHeader className="border-b">
              <StageBadge stage={r.stage} />
              <SheetTitle className="font-display text-xl font-bold">{r.receiptNo}</SheetTitle>
              <SheetDescription>{r.client} · {r.siteName}</SheetDescription>
            </SheetHeader>
            <div className="space-y-5 px-4 pb-6">
              {/* A preview of what the PDF says. */}
              <div className="overflow-hidden rounded-xl border">
                <div className="border-b bg-primary/6 px-4 py-3">
                  <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{payment ? "Amount received" : r.kind === "refund" ? "Amount refunded" : "Amount reversed"}</p>
                  <p className={cn("num font-display text-3xl font-bold", payment ? "text-primary" : "text-over")}>{exact(r.amount)}</p>
                  <p className="text-xs text-muted-foreground">{fmt.date(r.date)} · {methodLabel(r.method)}{r.reference && ` · ${r.reference}`}</p>
                </div>
                {r.invoiceTotal !== null && r.balanceAfter !== null ? (
                  <dl className="num grid gap-1.5 px-4 py-3 text-sm">
                    <div className="flex justify-between"><dt className="text-muted-foreground">Invoice {r.invoiceNo}</dt><dd className="font-medium">{exact(r.invoiceTotal)}</dd></div>
                    <div className="flex justify-between"><dt className="text-muted-foreground">Previously paid</dt><dd>{exact(r.paidBefore)}</dd></div>
                    <div className="flex justify-between"><dt className="text-muted-foreground">{payment ? "This payment" : r.kind === "refund" ? "Less this refund" : "Less this reversal"}</dt><dd className={payment ? "text-good" : "text-over"}>{payment ? "" : "− "}{exact(r.amount)}</dd></div>
                    <div className="flex justify-between border-t pt-1.5 font-medium"><dt>Total paid to date</dt><dd>{exact(r.paidToDate)}</dd></div>
                    <div className="flex justify-between text-base font-semibold"><dt>Remaining balance</dt><dd>{exact(Math.max(r.balanceAfter, 0))}</dd></div>
                  </dl>
                ) : (
                  <dl className="num grid gap-1.5 px-4 py-3 text-sm">
                    <div className="flex justify-between"><dt className="text-muted-foreground">Invoice</dt><dd>None (general receipt)</dd></div>
                    {!payment && <div className="flex justify-between"><dt className="text-muted-foreground">Received before</dt><dd>{exact(r.paidBefore)}</dd></div>}
                    <div className="flex justify-between text-base font-semibold"><dt>Net received</dt><dd>{exact(r.paidToDate)}</dd></div>
                  </dl>
                )}
              </div>

              {(r.notes || r.related || r.refunded > 0) && (
                <div className="space-y-2 text-sm">
                  {r.related && <p className="text-muted-foreground">Against receipt <span className="num font-medium text-foreground">{r.related.receiptNo}</span>.</p>}
                  {r.notes && <p className="whitespace-pre-line">{r.notes}</p>}
                  {payment && r.refunded > 0 && (
                    <p className="rounded-lg bg-over/8 p-3 text-over">{r.reversed ? "This payment was reversed." : `${exact(r.refunded)} of this payment was refunded.`} The figures above are as recorded on {fmt.date(r.date)}.</p>
                  )}
                </div>
              )}
              <p className="text-xs text-muted-foreground">Recorded by {r.createdBy}.</p>

              <div className="grid grid-cols-2 gap-2">
                <a href={receiptPdfHref(r.id)} className={cn(buttonVariants(), "h-11")}>
                  <Download aria-hidden /> Download PDF
                </a>
                <Button variant="outline" className="h-11" onClick={() => printReceipt(r.id)}>
                  <Printer aria-hidden /> Print
                </Button>
                {r.invoiceId && (
                  <Button variant="outline" className="col-span-2 h-11" onClick={() => onHistory(r.invoiceId!)}>
                    <History aria-hidden /> Payment history for {r.invoiceNo}
                  </Button>
                )}
              </div>

              {givesBack && !refunding && (
                <Button variant="outline" className="h-11 w-full text-over" onClick={() => setRefunding(true)}>
                  <Undo2 aria-hidden /> Refund or reverse
                </Button>
              )}
              {givesBack && refunding && (
                <RefundForm
                  payment={r}
                  onCancel={() => setRefunding(false)}
                  onDone={(res) => {
                    setRefunding(false);
                    onChanged(res);
                  }}
                />
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ---- Payment history of one invoice ----------------------------------------------

function InvoiceHistorySheet({
  invoiceId,
  version,
  canRecord,
  onClose,
  onRecord,
  onOpen,
}: {
  invoiceId: string | null;
  version: number;
  canRecord: (invoiceId: string) => boolean;
  onClose: () => void;
  onRecord: (invoiceId: string) => void;
  onOpen: (r: ClientReceipt) => void;
}) {
  const fmt = useFormat();
  const [data, setData] = useState<{ id: string; version: number; invoice: ClientInvoice; entries: ClientReceipt[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = data && data.id === invoiceId ? data : null;

  useEffect(() => {
    if (!invoiceId) return;
    let live = true;
    loadInvoicePaymentsAction(invoiceId).then(
      (res) => {
        if (!live) return;
        if (res.ok) {
          setError(null);
          setData({ id: invoiceId, version, ...res.data });
        } else setError(res.error);
      },
      () => live && setError("Couldn't load the payment history. Check your connection and try again."),
    );
    return () => {
      live = false;
    };
  }, [invoiceId, version]);

  const inv = current?.invoice;
  const pct = inv && inv.total > 0 ? Math.min(100, Math.max(0, (inv.paid / inv.total) * 100)) : 0;

  return (
    <Sheet open={!!invoiceId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg!">
        <SheetHeader className="border-b">
          <SheetTitle className="font-display text-xl font-bold">Payment history</SheetTitle>
          <SheetDescription>{inv ? `${inv.invoiceNo} · ${inv.client} · ${inv.siteName}` : "Loading…"}</SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-4 pb-6">
          {error && !current && <p role="alert" className="rounded-lg bg-over/8 p-3 text-sm text-over">{error}</p>}
          {!current && !error && (
            <div className="space-y-3" aria-hidden>
              <div className="h-24 animate-pulse rounded-xl bg-muted" />
              <div className="h-40 animate-pulse rounded-xl bg-muted" />
            </div>
          )}
          {inv && current && (
            <>
              <div className="rounded-xl border p-4">
                <dl className="num grid grid-cols-3 gap-2 text-sm">
                  <div><dt className="text-xs text-muted-foreground">Invoice total</dt><dd className="font-semibold">{exact(inv.total)}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Paid</dt><dd className="font-semibold text-good">{exact(inv.paid)}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Balance</dt><dd className="font-semibold">{exact(Math.max(inv.balance, 0))}</dd></div>
                </dl>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Share of the invoice paid" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full rounded-full bg-good transition-[width]" style={{ width: `${pct}%` }} />
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {inv.status === "paid" ? "Fully paid." : inv.status === "cancelled" ? "Cancelled." : `${Math.round(pct)}% received${inv.status === "overdue" ? ", overdue" : ""}. Due ${fmt.date(inv.dueDate)}.`}
                </p>
              </div>

              {current.entries.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing received against this invoice yet.</p>
              ) : (
                <ol className="relative space-y-1 border-l pl-4" aria-label="Payments, oldest first">
                  {current.entries.map((e) => (
                    <li key={e.id} className="relative">
                      <span aria-hidden className={cn("absolute top-4 -left-[1.3rem] size-2.5 rounded-full ring-4 ring-background", e.kind === "payment" ? "bg-good" : "bg-over")} />
                      <button type="button" onClick={() => onOpen(e)} className="grid w-full grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-lg px-2 py-2.5 text-left hover:bg-muted/60">
                        <span className="num truncate text-sm font-medium">{e.receiptNo}</span>
                        <span className={cn("num text-right text-sm font-semibold", e.kind !== "payment" && "text-over")}>{e.kind === "payment" ? "" : "− "}{exact(e.amount)}</span>
                        <span className="truncate text-xs text-muted-foreground">{fmt.date(e.date)} · {methodLabel(e.method)}{e.reversed ? " · reversed" : ""}</span>
                        <span className="num text-right text-xs text-muted-foreground">Balance {exact(Math.max(e.balanceAfter ?? 0, 0))}</span>
                        <span className="col-span-2"><StageBadge stage={e.stage} /></span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}

              <div className="grid gap-2 sm:grid-cols-2">
                {canRecord(inv.id) && (
                  <Button className="h-11" onClick={() => onRecord(inv.id)}>
                    <Plus aria-hidden /> Record payment
                  </Button>
                )}
                <a href={invoicePdfHref(inv.id)} className={cn(buttonVariants({ variant: "outline" }), "h-11")}>
                  <FileText aria-hidden /> Invoice PDF
                </a>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---- By project ------------------------------------------------------------------

function ProjectList({ projects, version, onHistory }: { projects: ProjectCollection[]; version: number; onHistory: (invoiceId: string) => void }) {
  if (!projects.length) {
    return <EmptyState icon={Building2} title="No invoiced projects yet" description="Projects appear here once they have a client invoice. Raise one on the Invoices page." />;
  }
  return (
    <ul className="grid gap-3 lg:grid-cols-2" aria-label="Projects">
      {projects.map((p) => (
        <ProjectCard key={p.siteId} project={p} version={version} onHistory={onHistory} />
      ))}
    </ul>
  );
}

function ProjectCard({ project: p, version, onHistory }: { project: ProjectCollection; version: number; onHistory: (invoiceId: string) => void }) {
  const fmt = useFormat();
  const [open, setOpen] = useState(false);
  const [invoices, setInvoices] = useState<{ version: number; items: ClientInvoice[] } | null>(null);
  const [loading, start] = useTransition();
  const net = p.collected - p.refunded;
  const pct = p.value > 0 ? Math.min(100, Math.max(0, (net / p.value) * 100)) : 0;

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && invoices?.version !== version) {
      start(async () => {
        const res = await loadInvoicesAction({ siteId: p.siteId, limit: 100 });
        if (!res.ok) {
          setOpen(false);
          return void toast.error(res.error);
        }
        setInvoices({ version, items: res.data.items });
      });
    }
  }

  return (
    <li className="surface rounded-xl">
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate font-semibold">{p.siteName}</h3>
            <p className="truncate text-xs text-muted-foreground">{p.client || "No client recorded"} · {p.invoices} {p.invoices === 1 ? "invoice" : "invoices"} · {p.receipts} {p.receipts === 1 ? "receipt" : "receipts"}</p>
          </div>
          <span className={cn("num shrink-0 text-sm font-semibold", p.outstanding > 0 ? "text-warn" : "text-good")}>{p.outstanding > 0 ? `${fmt.money(p.outstanding)} due` : "Fully paid"}</span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${p.siteName}: share collected`} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-good" style={{ width: `${pct}%` }} />
        </div>
        <dl className="num mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-muted-foreground">Project value</dt><dd className="font-medium">{fmt.money(p.value)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Collected</dt><dd className="font-medium text-good">{fmt.money(p.collected)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Refunds</dt><dd className={cn("font-medium", p.refunded > 0 && "text-over")}>{fmt.money(p.refunded)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Outstanding</dt><dd className="font-semibold">{fmt.money(p.outstanding)}</dd></div>
        </dl>
      </div>
      <button type="button" onClick={toggle} aria-expanded={open} className="flex h-11 w-full items-center justify-between border-t px-4 text-sm font-medium hover:bg-muted/50 sm:px-5">
        Invoices and payment history
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div className="border-t" aria-busy={loading}>
          {!invoices || loading ? (
            <p className="px-4 py-3 text-sm text-muted-foreground sm:px-5">Loading…</p>
          ) : (
            <ul className="divide-y">
              {invoices.items.map((inv) => (
                <li key={inv.id}>
                  <button type="button" onClick={() => onHistory(inv.id)} className="grid w-full grid-cols-[1fr_auto] gap-x-3 px-4 py-3 text-left text-sm hover:bg-muted/50 sm:px-5">
                    <span className="min-w-0">
                      <span className="num block truncate font-medium">{inv.invoiceNo}</span>
                      <span className="block truncate text-xs text-muted-foreground">{fmt.date(inv.date)} · {inv.status === "cancelled" ? "Cancelled" : inv.status === "paid" ? "Paid" : `${exact(inv.paid)} of ${exact(inv.total)} received`}</span>
                    </span>
                    <span className={cn("num self-center text-right font-semibold", inv.status === "overdue" && "text-over", inv.status === "cancelled" && "text-muted-foreground line-through")}>
                      {inv.status === "paid" || inv.status === "cancelled" ? exact(inv.total) : exact(inv.balance)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
