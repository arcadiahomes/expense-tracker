"use client";

import Link from "next/link";
import { useState, useTransition, type FormEvent } from "react";
import { ArrowLeft, ChevronRight, Pencil, Plus, Store } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { PAYMENT_OPTIONS } from "@/components/expense-form-dialog";
import { Field, Stat, useSubmit } from "@/components/form-bits";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/states";
import { useFormat, useWritableSites } from "@/lib/session";
import type { BillStatus, PaymentMode } from "@/lib/types";
import { createSupplierAction, updateSupplierAction } from "@/server/actions/suppliers";
import type { SupplierBillRow, SupplierPaymentRow, SupplierSummary } from "@/server/data/suppliers";
import { cn } from "@/lib/utils";

const PAY_LABEL = Object.fromEntries(PAYMENT_OPTIONS.map((o) => [o.value, o.label])) as Record<PaymentMode, string>;
const STATUS_TONE: Record<BillStatus, string> = { paid: "text-good", partial: "text-warn", pending: "", overdue: "text-over" };
const STATUS_LABEL: Record<BillStatus, string> = { paid: "Paid", partial: "Part paid", pending: "Pending", overdue: "Overdue" };

export function SuppliersView({ suppliers }: { suppliers: SupplierSummary[] }) {
  const fmt = useFormat();
  const canWrite = useWritableSites().length > 0;
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const shown = suppliers.filter((s) => s.name.toLowerCase().includes(q.trim().toLowerCase()));
  const outstanding = suppliers.reduce((t, s) => t + Number(s.outstanding), 0);
  const overdue = suppliers.reduce((t, s) => t + Number(s.overdue), 0);

  return (
    <>
      <PageHeader
        title="Suppliers"
        description="Who you buy from, what they've billed, what's been paid and what's still owed, on the sites you can see."
        actions={canWrite && <Button className="h-11" onClick={() => setAdding(true)}><Plus aria-hidden /> Add supplier</Button>}
      />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Outstanding" value={fmt.money(outstanding)} tone={outstanding > 0 ? "warn" : undefined} />
        <Stat label="Overdue" value={fmt.money(overdue)} tone={overdue > 0 ? "over" : undefined} />
        <Stat label="Suppliers" value={suppliers.length} />
      </div>
      <Input aria-label="Search suppliers" placeholder="Search suppliers" className="mb-3 h-11 sm:max-w-sm" value={q} onChange={(e) => setQ(e.target.value)} />
      {shown.length === 0 ? (
        <EmptyState icon={Store} title={suppliers.length ? "No supplier matches" : "No suppliers yet"} description="Suppliers are added here, or when you record a bill or purchase." />
      ) : (
        <ul className="surface divide-y rounded-xl">
          {shown.map((s) => (
            <li key={s.id}>
              <Link href={`/suppliers/${s.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-secondary/50">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{s.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {[`${s.billCount} ${s.billCount === 1 ? "bill" : "bills"}`, `paid ${fmt.money(Number(s.paid))}`, Number(s.paidDirect) > 0 && `${fmt.money(Number(s.paidDirect))} bought for cash`, s.lastActivity && `last ${fmt.date(s.lastActivity)}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <div className="text-right">
                  <p className={cn("num font-semibold", Number(s.outstanding) > 0 ? "text-warn" : "text-muted-foreground")}>{fmt.money(Number(s.outstanding))}</p>
                  {Number(s.overdue) > 0 && <p className="num text-xs text-over">{fmt.money(Number(s.overdue))} overdue</p>}
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-md">{adding && <SupplierForm onDone={() => setAdding(false)} />}</DialogContent>
      </Dialog>
    </>
  );
}

type Detail = {
  supplier: { id: string; name: string; gstin: string | null; phone: string | null; address: string | null };
  summary: SupplierSummary;
  bills: SupplierBillRow[];
  payments: SupplierPaymentRow[];
  purchases: { id: string; site: string; date: string; invoiceNumber: string | null; deliveryRef: string | null; total: string; paymentMethod: PaymentMode; voided: boolean }[];
};

export function SupplierDetailView({ data }: { data: Detail }) {
  const fmt = useFormat();
  const canWrite = useWritableSites().length > 0;
  const [editing, setEditing] = useState(false);
  const { supplier: s, summary } = data;
  return (
    <>
      <PageHeader
        back={
          <Link href="/suppliers" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" aria-hidden /> Suppliers
          </Link>
        }
        title={s.name}
        description={[s.gstin && `GSTIN ${s.gstin}`, s.phone, s.address].filter(Boolean).join(" · ") || undefined}
        actions={canWrite && <Button variant="outline" className="h-11" onClick={() => setEditing(true)}><Pencil aria-hidden /> Edit</Button>}
      />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Billed" value={fmt.money(Number(summary.billed))} hint={`${summary.billCount} bills`} />
        <Stat label="Paid against bills" value={fmt.money(Number(summary.paid))} />
        <Stat label="Outstanding" value={fmt.money(Number(summary.outstanding))} tone={Number(summary.outstanding) > 0 ? "warn" : undefined} hint={Number(summary.overdue) > 0 ? `${fmt.money(Number(summary.overdue))} overdue` : undefined} />
        <Stat label="Bought for cash" value={fmt.money(Number(summary.paidDirect))} hint="Never owed, not in the balance" />
      </div>

      <Tabs defaultValue="bills">
        <TabsList className="h-11!">
          <TabsTrigger value="bills" className="px-3">Invoices</TabsTrigger>
          <TabsTrigger value="payments" className="px-3">Payments</TabsTrigger>
          <TabsTrigger value="purchases" className="px-3">Purchases</TabsTrigger>
        </TabsList>
        <TabsContent value="bills" className="mt-3">
          {data.bills.length === 0 ? (
            <EmptyState icon={Store} title="No bills" />
          ) : (
            <ul className="surface divide-y rounded-xl">
              {data.bills.map((b) => (
                <li key={b.id} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="font-medium">Invoice {b.invoiceNumber}</p>
                    <p className="text-xs text-muted-foreground">{[b.site, fmt.date(b.date), `due ${fmt.date(b.dueDate)}`].join(" · ")}</p>
                  </div>
                  <div className="text-right">
                    <p className="num font-semibold">{fmt.money(Number(b.amount))}</p>
                    <p className="text-xs">
                      <span className={cn("font-medium", STATUS_TONE[b.status])}>{STATUS_LABEL[b.status]}</span>
                      {Number(b.outstanding) > 0 && <span className="num text-muted-foreground"> · owed {fmt.money(Number(b.outstanding))}</span>}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Record payments against these on the <Link href={`/bills?q=${encodeURIComponent(s.name)}`} className="underline underline-offset-2">Bills</Link> page.
          </p>
        </TabsContent>
        <TabsContent value="payments" className="mt-3">
          {data.payments.length === 0 ? (
            <EmptyState icon={Store} title="No payments yet" />
          ) : (
            <ul className="surface divide-y rounded-xl">
              {data.payments.map((p) => (
                <li key={p.id} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="font-medium">{fmt.date(p.paidOn)} · {PAY_LABEL[p.method]}</p>
                    <p className="text-xs text-muted-foreground">{[`Invoice ${p.invoiceNumber}`, p.site, p.reference && `Ref ${p.reference}`, `by ${p.enteredBy}`].filter(Boolean).join(" · ")}</p>
                  </div>
                  <p className="num font-semibold text-good">{fmt.money(Number(p.amount))}</p>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
        <TabsContent value="purchases" className="mt-3">
          {data.purchases.length === 0 ? (
            <EmptyState icon={Store} title="No material purchases" />
          ) : (
            <ul className="surface divide-y rounded-xl">
              {data.purchases.map((p) => (
                <li key={p.id} className={cn("flex items-start justify-between gap-3 px-4 py-3", p.voided && "opacity-60")}>
                  <div className="min-w-0">
                    <p className="font-medium">{fmt.date(p.date)} · {p.site}</p>
                    <p className="text-xs text-muted-foreground">{[p.invoiceNumber && `Invoice ${p.invoiceNumber}`, p.deliveryRef && `Delivery ${p.deliveryRef}`, PAY_LABEL[p.paymentMethod]].filter(Boolean).join(" · ")}</p>
                  </div>
                  <div className="text-right">
                    <p className="num font-semibold">{fmt.money(Number(p.total))}</p>
                    {p.voided && <Badge variant="outline">Voided</Badge>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="sm:max-w-md">{editing && <SupplierForm supplier={s} onDone={() => setEditing(false)} />}</DialogContent>
      </Dialog>
    </>
  );
}

function SupplierForm({ supplier, onDone }: { supplier?: Detail["supplier"]; onDone: () => void }) {
  const submit = useSubmit();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [name, setName] = useState(supplier?.name ?? "");
  const [gstin, setGstin] = useState(supplier?.gstin ?? "");
  const [phone, setPhone] = useState(supplier?.phone ?? "");
  const [address, setAddress] = useState(supplier?.address ?? "");

  function save(e: FormEvent) {
    e.preventDefault();
    const body = { name, gstin: gstin || undefined, phone: phone || undefined, address: address || undefined };
    start(async () => {
      const res = await submit(() => (supplier ? updateSupplierAction(supplier.id, body) : createSupplierAction(body)), setErrors);
      if (res) {
        toast.success(supplier ? "Supplier updated" : `${res.name} added`);
        onDone();
      }
    });
  }

  return (
    <form onSubmit={save} className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="text-lg font-semibold">{supplier ? "Edit supplier" : "Add supplier"}</DialogTitle>
        <DialogDescription>Shared by every site in your organization.</DialogDescription>
      </DialogHeader>
      <Field id="s-name" label="Name" error={errors.name}>
        <Input id="s-name" className="h-11" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id="s-gstin" label="GSTIN (optional)" error={errors.gstin}>
          <Input id="s-gstin" className="h-11 uppercase" maxLength={15} value={gstin} onChange={(e) => setGstin(e.target.value)} />
        </Field>
        <Field id="s-phone" label="Phone (optional)" error={errors.phone}>
          <Input id="s-phone" type="tel" className="h-11" maxLength={30} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
      </div>
      <Field id="s-address" label="Address (optional)" error={errors.address}>
        <Textarea id="s-address" maxLength={300} value={address} onChange={(e) => setAddress(e.target.value)} />
      </Field>
      <DialogFooter>
        <Button type="submit" className="h-11 px-5" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
      </DialogFooter>
    </form>
  );
}

export function SupplierNotFound() {
  return <EmptyState icon={Store} title="Supplier not found" description="It may have been removed, or it belongs to another organization." />;
}
