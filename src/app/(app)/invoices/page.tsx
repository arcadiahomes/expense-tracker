import type { Metadata } from "next";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/states";
import { InvoicesNoAccess, InvoicesView } from "@/components/views/invoices";
import { invoiceSites, invoiceTotals, labourInvoice, listClientInvoices } from "@/server/data/invoices";
import { labourBalances } from "@/server/data/labour";
import { today } from "@/server/data/shared";
import { ValidationError } from "@/server/errors";
import { activeSiteCookie, requireRecordsReader } from "@/server/session";
import { INVOICE_STATUSES, isoDate } from "@/server/validation";

export const metadata: Metadata = { title: "Invoices" };

type Status = (typeof INVOICE_STATUSES)[number];

async function Invoices({ searchParams }: PageProps<"/invoices">) {
  const query = await searchParams;
  const actor = await requireRecordsReader();
  const sites = await invoiceSites(actor);
  if (!sites.length) return <InvoicesNoAccess />;
  const siteOptions = sites.map((s) => ({ id: s.id, name: s.name, client: s.client ?? "" }));

  if (query.tab !== "labour") {
    const status = (INVOICE_STATUSES.includes(query.status as Status) ? query.status : "all") as Status;
    const q = typeof query.q === "string" ? query.q.slice(0, 100) : "";
    const [page, totals] = await Promise.all([listClientInvoices(actor, { status, q: q || undefined }), invoiceTotals(actor)]);
    return <InvoicesView sites={siteOptions} client={{ page, totals, filter: status, query: q }} />;
  }

  // Labour: ?site wins, then the active site, then the first site the user invoices for.
  const cookie = await activeSiteCookie();
  const siteId = sites.find((s) => s.id === query.site)?.id ?? sites.find((s) => s.id === cookie)?.id ?? sites[0].id;
  const t = today();
  const from = isoDate.safeParse(query.from).success ? (query.from as string) : `${t.slice(0, 8)}01`;
  const to = isoDate.safeParse(query.to).success ? (query.to as string) : t;
  const { workers } = await labourBalances(actor, siteId);
  const workerId = workers.find((w) => w.workerId === query.worker)?.workerId ?? null;
  let invoice = null;
  let error: string | null = null;
  if (workerId) {
    try {
      invoice = await labourInvoice(actor, { siteId, workerId, from, to });
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      error = err.message;
    }
  }
  return (
    <InvoicesView
      sites={siteOptions}
      labour={{ siteId, workerId, from, to, invoice, error, workers: workers.map((w) => ({ id: w.workerId, name: w.name, trade: w.trade ?? "" })) }}
    />
  );
}

export default function InvoicesPage(props: PageProps<"/invoices">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Invoices {...props} />
    </Suspense>
  );
}
