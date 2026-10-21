"use client";

import { useMemo, useState, useTransition, type FormEvent } from "react";
import { Ban, Boxes, FileText, PackageMinus, PackagePlus, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { PAYMENT_OPTIONS } from "@/components/expense-form-dialog";
import { Field, Stat, useSubmit } from "@/components/form-bits";
import { PageHeader } from "@/components/page-header";
import { prepareFile } from "@/components/receipts-panel";
import { SelectField } from "@/components/select-field";
import { SitePicker } from "@/components/site-picker";
import { EmptyState } from "@/components/states";
import { can } from "@/lib/permissions";
import { useFormat, useSession } from "@/lib/session";
import type { PaymentMode } from "@/lib/types";
import { createMaterialAction, deleteUsageAction, recordPurchaseAction, recordUsageAction, updateMaterialAction, voidPurchaseAction } from "@/server/actions/materials";
import type { Material, Purchase, StockRow, Usage } from "@/server/data/materials";
import { cn } from "@/lib/utils";

const PAY_LABEL = Object.fromEntries(PAYMENT_OPTIONS.map((o) => [o.value, o.label])) as Record<PaymentMode, string>;

export function MaterialsView({
  siteId,
  catalog,
  stock,
  purchases,
  usage,
}: {
  siteId: string;
  catalog: Material[];
  stock: StockRow[];
  purchases: Purchase[];
  usage: Usage[];
}) {
  const { sites } = useSession();
  const fmt = useFormat();
  const site = sites.find((s) => s.id === siteId);
  const open = site?.status !== "completed";
  const canWrite = open && can(site?.role, "expense:create");
  const canFinance = can(site?.role, "finance:manage");
  const [dialog, setDialog] = useState<null | "purchase" | "usage" | "material">(null);
  const [editing, setEditing] = useState<Material | null>(null);
  const [voiding, setVoiding] = useState<Purchase | null>(null);
  const live = purchases.filter((p) => !p.voided);
  const spent = live.reduce((t, p) => t + Number(p.total), 0);
  const owed = live.reduce((t, p) => t + (p.bill ? Number(p.bill.amount) - Number(p.bill.paid) : 0), 0);

  return (
    <>
      <PageHeader
        title="Materials"
        description="What was bought for the site, what was used, and what's left. Using stock never counts as spending again."
        actions={
          canWrite && (
            <>
              <Button variant="outline" className="h-11" onClick={() => setDialog("usage")} disabled={!stock.some((s) => Number(s.onHand) > 0)}>
                <PackageMinus aria-hidden /> Record usage
              </Button>
              <Button className="h-11" onClick={() => setDialog("purchase")}>
                <PackagePlus aria-hidden /> Record purchase
              </Button>
            </>
          )
        }
      />
      <SitePicker siteId={siteId} className="mb-5" />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Bought (this site)" value={fmt.money(spent)} hint={`${live.length} purchases`} />
        <Stat label="Still owed to suppliers" value={fmt.money(owed)} tone={owed > 0 ? "warn" : undefined} hint="Credit purchases not yet paid" />
        <Stat label="Materials in stock" value={stock.filter((s) => Number(s.onHand) > 0).length} />
        <Stat label="Usage entries" value={usage.length} />
      </div>

      <Tabs defaultValue="stock">
        <TabsList className="-mx-1 h-11! max-w-full overflow-x-auto">
          <TabsTrigger value="stock" className="px-3">Stock</TabsTrigger>
          <TabsTrigger value="purchases" className="px-3">Purchases</TabsTrigger>
          <TabsTrigger value="usage" className="px-3">Usage</TabsTrigger>
          <TabsTrigger value="catalog" className="px-3">Catalog</TabsTrigger>
        </TabsList>

        <TabsContent value="stock" className="mt-3">
          {stock.length === 0 ? (
            <EmptyState icon={Boxes} title="Nothing bought for this site yet" description="Record a purchase to start tracking stock." />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {stock.map((s) => (
                <li key={s.materialId} className="surface rounded-xl p-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="font-semibold">{s.material}</p>
                    <p className={cn("num font-display text-2xl font-bold", Number(s.onHand) <= 0 && "text-muted-foreground")}>
                      {s.onHand} <span className="text-sm font-medium text-muted-foreground">{s.unit}</span>
                    </p>
                  </div>
                  <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                    <div><dt className="text-muted-foreground">Bought</dt><dd className="num font-medium">{s.purchased}</dd></div>
                    <div><dt className="text-muted-foreground">Used</dt><dd className="num font-medium">{s.used}</dd></div>
                    <div><dt className="text-muted-foreground">Avg cost</dt><dd className="num font-medium">{s.averageUnitCost ? `${fmt.money(Number(s.averageUnitCost))}/${s.unit}` : "–"}</dd></div>
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="purchases" className="mt-3">
          {purchases.length === 0 ? (
            <EmptyState icon={PackagePlus} title="No purchases yet" />
          ) : (
            <ul className="space-y-3">
              {purchases.map((p) => (
                <li key={p.id} className={cn("surface rounded-xl p-4", p.voided && "opacity-60")}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold">
                        {p.supplier ?? "No supplier"} <span className="font-normal text-muted-foreground">· {fmt.date(p.date)}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {[p.invoiceNumber && `Invoice ${p.invoiceNumber}`, p.deliveryRef && `Delivery ${p.deliveryRef}`, `Entered by ${p.enteredBy}`].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="num font-display text-lg font-bold">{fmt.money(Number(p.total))}</p>
                      {p.voided ? (
                        <Badge variant="outline">Voided</Badge>
                      ) : p.bill ? (
                        <Badge variant="outline" className={Number(p.bill.paid) >= Number(p.bill.amount) ? "text-good" : "text-warn"}>
                          {Number(p.bill.paid) >= Number(p.bill.amount) ? "Bill paid" : `Owed ${fmt.money(Number(p.bill.amount) - Number(p.bill.paid))} · due ${fmt.date(p.bill.dueDate)}`}
                        </Badge>
                      ) : (
                        <Badge variant="outline">Paid · {PAY_LABEL[p.paymentMethod]}</Badge>
                      )}
                    </div>
                  </div>
                  <ul className="mt-3 divide-y rounded-lg border text-sm">
                    {p.items.map((i) => (
                      <li key={i.materialId} className="flex justify-between gap-3 px-3 py-2">
                        <span>
                          {i.material} <span className="text-muted-foreground">{i.quantity} {i.unit} × {fmt.money(Number(i.unitPrice))}</span>
                        </span>
                        <span className="num">{fmt.money(Number(i.amount))}</span>
                      </li>
                    ))}
                  </ul>
                  {p.voided && <p className="mt-2 text-xs text-muted-foreground">Voided: {p.voided.reason}</p>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {p.attachment && (
                      <a href={p.attachment.url} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm">
                        <FileText className="size-4" aria-hidden /> Receipt
                      </a>
                    )}
                    {canFinance && !p.voided && (
                      <Button variant="ghost" size="sm" className="h-9 text-over" onClick={() => setVoiding(p)}>
                        <Ban aria-hidden /> Void
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="usage" className="mt-3">
          {usage.length === 0 ? (
            <EmptyState icon={PackageMinus} title="No usage recorded" description="Record what's taken out of stock for work, like 12 bags of cement for the first-floor slab." />
          ) : (
            <ul className="surface divide-y rounded-xl">
              {usage.map((u) => (
                <UsageRow key={u.id} usage={u} />
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="catalog" className="mt-3">
          <div className="mb-3 flex justify-end">
            {canWrite && (
              <Button variant="outline" className="h-10" onClick={() => { setEditing(null); setDialog("material"); }}>
                <Plus aria-hidden /> Add material
              </Button>
            )}
          </div>
          {catalog.length === 0 ? (
            <EmptyState icon={Boxes} title="No materials yet" description="Add the materials you buy, each with the unit you count it in." />
          ) : (
            <ul className="surface divide-y rounded-xl">
              {catalog.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <p className={cn("font-medium", !m.active && "text-muted-foreground line-through")}>{m.name}</p>
                    <p className="text-xs text-muted-foreground">
                      per {m.unit}
                      {m.defaultUnitPrice && ` · usually ${fmt.money(Number(m.defaultUnitPrice))}`}
                    </p>
                  </div>
                  {canWrite && (
                    <Button variant="ghost" size="icon" className="size-10" aria-label={`Edit ${m.name}`} onClick={() => { setEditing(m); setDialog("material"); }}>
                      <Pencil aria-hidden />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={dialog === "purchase"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
          {dialog === "purchase" && <PurchaseForm siteId={siteId} catalog={catalog.filter((m) => m.active)} canCredit={canFinance} onDone={() => setDialog(null)} onAddMaterial={() => { setEditing(null); setDialog("material"); }} />}
        </DialogContent>
      </Dialog>
      <Dialog open={dialog === "usage"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-md">{dialog === "usage" && <UsageForm siteId={siteId} stock={stock} onDone={() => setDialog(null)} />}</DialogContent>
      </Dialog>
      <Dialog open={dialog === "material"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-md">{dialog === "material" && <MaterialForm material={editing} onDone={() => setDialog(null)} />}</DialogContent>
      </Dialog>
      <Dialog open={!!voiding} onOpenChange={(o) => !o && setVoiding(null)}>
        <DialogContent className="sm:max-w-md">{voiding && <VoidForm purchase={voiding} onDone={() => setVoiding(null)} />}</DialogContent>
      </Dialog>
    </>
  );
}

function UsageRow({ usage: u }: { usage: Usage }) {
  const submit = useSubmit();
  const fmt = useFormat();
  const [pending, start] = useTransition();
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="font-medium">
          {u.material} <span className="num">{u.quantity} {u.unit}</span>
        </p>
        <p className="text-xs text-muted-foreground">{[fmt.date(u.date), u.purpose, u.enteredBy].filter(Boolean).join(" · ")}</p>
      </div>
      {u.canDelete && (
        <Button
          variant="ghost"
          size="icon"
          className="size-10 text-muted-foreground"
          aria-label={`Remove usage of ${u.material}`}
          disabled={pending}
          onClick={() => start(async () => void (await submit(() => deleteUsageAction(u.id), () => {})) )}
        >
          <Trash2 aria-hidden />
        </Button>
      )}
    </li>
  );
}

type Line = { materialId: string; quantity: string; unitPrice: string };

function PurchaseForm({ siteId, catalog, canCredit, onDone, onAddMaterial }: { siteId: string; catalog: Material[]; canCredit: boolean; onDone: () => void; onAddMaterial: () => void }) {
  const submit = useSubmit();
  const { today, suppliers } = useSession();
  const fmt = useFormat();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [supplierName, setSupplier] = useState("");
  const [purchaseDate, setDate] = useState(today);
  const [paymentMethod, setMethod] = useState<PaymentMode>("cash");
  const [invoiceNumber, setInvoice] = useState("");
  const [deliveryRef, setDelivery] = useState("");
  const [dueDate, setDue] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [lines, setLines] = useState<Line[]>([{ materialId: "", quantity: "", unitPrice: "" }]);
  const byId = useMemo(() => new Map(catalog.map((m) => [m.id, m])), [catalog]);
  // Preview only; the server totals the same numbers in Postgres.
  const total = lines.reduce((t, l) => t + Math.round(Number(l.quantity || 0) * Number(l.unitPrice || 0) * 100) / 100, 0);
  const methods = PAYMENT_OPTIONS.filter((o) => canCredit || o.value !== "credit");
  const credit = paymentMethod === "credit";

  if (!catalog.length) {
    return (
      <>
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">Add a material first</DialogTitle>
          <DialogDescription>Purchases are recorded against materials in your catalog, like Cement (bags) or Sand (loads).</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button className="h-11" onClick={onAddMaterial}>Add material</Button>
        </DialogFooter>
      </>
    );
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const form = new FormData();
    form.set(
      "data",
      JSON.stringify({
        siteId,
        supplierName: supplierName || undefined,
        purchaseDate,
        invoiceNumber: invoiceNumber || undefined,
        deliveryRef: deliveryRef || undefined,
        paymentMethod,
        dueDate: credit && dueDate ? dueDate : undefined,
        notes: notes || undefined,
        items: lines.filter((l) => l.materialId),
      }),
    );
    if (file) form.set("file", file);
    start(async () => {
      const saved = await submit(() => recordPurchaseAction(form), setErrors);
      if (saved) {
        toast.success(`Purchase of ${fmt.money(Number(saved.total))} recorded`);
        onDone();
      }
    });
  }

  return (
    <form onSubmit={save} className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="text-lg font-semibold">Record a purchase</DialogTitle>
        <DialogDescription>Paid now saves an expense. On credit adds a bill to pay later.</DialogDescription>
      </DialogHeader>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="p-supplier" label={credit ? "Supplier" : "Supplier (optional)"} error={errors.supplierName}>
          <Input id="p-supplier" className="h-11" list="p-suppliers" value={supplierName} maxLength={120} onChange={(e) => setSupplier(e.target.value)} />
          <datalist id="p-suppliers">{suppliers.map((s) => <option key={s} value={s} />)}</datalist>
        </Field>
        <Field id="p-date" label="Date" error={errors.purchaseDate}>
          <Input id="p-date" type="date" className="h-11" max={today} value={purchaseDate} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field id="p-method" label="Paid by" error={errors.paymentMethod}>
          <SelectField id="p-method" value={paymentMethod} onChange={setMethod} options={methods} />
        </Field>
        {credit && (
          <Field id="p-due" label="Due date" error={errors.dueDate}>
            <Input id="p-due" type="date" className="h-11" min={purchaseDate} value={dueDate} onChange={(e) => setDue(e.target.value)} />
          </Field>
        )}
        <Field id="p-invoice" label={credit ? "Invoice number" : "Invoice number (optional)"} error={errors.invoiceNumber}>
          <Input id="p-invoice" className="h-11" maxLength={60} value={invoiceNumber} onChange={(e) => setInvoice(e.target.value)} />
        </Field>
        <Field id="p-delivery" label="Delivery note / challan (optional)" error={errors.deliveryRef}>
          <Input id="p-delivery" className="h-11" maxLength={60} value={deliveryRef} onChange={(e) => setDelivery(e.target.value)} />
        </Field>
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Materials</legend>
        {lines.map((l, i) => {
          const m = byId.get(l.materialId);
          return (
            <div key={i} className="grid grid-cols-[1fr_auto] gap-2 rounded-lg border p-2.5 sm:grid-cols-[1.4fr_0.8fr_0.9fr_auto]">
              <SelectField
                aria-label={`Material ${i + 1}`}
                value={l.materialId || null}
                placeholder="Choose material"
                options={catalog.filter((c) => c.id === l.materialId || !lines.some((x) => x.materialId === c.id)).map((c) => ({ value: c.id, label: `${c.name} (${c.unit})` }))}
                onChange={(id) =>
                  setLines((ls) => ls.map((x, j) => (j === i ? { ...x, materialId: id, unitPrice: x.unitPrice || byId.get(id)?.defaultUnitPrice || "" } : x)))
                }
                className="col-span-2 sm:col-span-1"
              />
              <Input aria-label={`Quantity ${i + 1}`} inputMode="decimal" placeholder={m ? `Qty (${m.unit})` : "Qty"} className="h-11" value={l.quantity} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, quantity: e.target.value.replace(/[^\d.]/g, "") } : x)))} />
              <Input aria-label={`Unit price ${i + 1}`} inputMode="decimal" placeholder="₹ per unit" className="h-11" value={l.unitPrice} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value.replace(/[^\d.]/g, "") } : x)))} />
              <Button type="button" variant="ghost" size="icon" className="size-11" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                <Trash2 aria-hidden />
              </Button>
            </div>
          );
        })}
        {errors.items && <p className="text-xs font-medium text-over">{errors.items}</p>}
        {Object.entries(errors).filter(([k]) => k.startsWith("items.")).slice(0, 1).map(([k, v]) => <p key={k} className="text-xs font-medium text-over">{v}</p>)}
        <Button type="button" variant="outline" className="h-10 w-fit" disabled={lines.length >= catalog.length} onClick={() => setLines((ls) => [...ls, { materialId: "", quantity: "", unitPrice: "" }])}>
          <Plus aria-hidden /> Add material
        </Button>
      </fieldset>

      <Field id="p-file" label="Receipt or delivery photo (optional)" hint="PDF, JPG, PNG, WebP or HEIC, under 4 MB">
        <Input
          id="p-file"
          type="file"
          accept="application/pdf,image/*"
          capture="environment"
          className="h-11"
          onChange={(e) => {
            const input = e.currentTarget;
            const picked = input.files?.[0];
            if (!picked) return setFile(null);
            void prepareFile(picked).then((r) => {
              if (typeof r === "string") {
                toast.error(r);
                input.value = "";
                setFile(null);
              } else setFile(r);
            });
          }}
        />
      </Field>
      <Field id="p-notes" label="Notes (optional)">
        <Textarea id="p-notes" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>

      <DialogFooter className="items-center sm:justify-between">
        <p className="num text-lg font-bold">{fmt.money(total)}</p>
        <Button type="submit" className="h-11 px-5" disabled={pending}>{pending ? "Saving…" : credit ? "Save and add bill" : "Save purchase"}</Button>
      </DialogFooter>
    </form>
  );
}

function UsageForm({ siteId, stock, onDone }: { siteId: string; stock: StockRow[]; onDone: () => void }) {
  const submit = useSubmit();
  const { today } = useSession();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const inStock = stock.filter((s) => Number(s.onHand) > 0);
  const [materialId, setMaterial] = useState(inStock[0]?.materialId ?? "");
  const [quantity, setQuantity] = useState("");
  const [usedOn, setDate] = useState(today);
  const [purpose, setPurpose] = useState("");
  const row = stock.find((s) => s.materialId === materialId);

  function save(e: FormEvent) {
    e.preventDefault();
    start(async () => {
      const saved = await submit(() => recordUsageAction({ siteId, materialId, quantity, usedOn, purpose: purpose || undefined }), setErrors);
      if (saved) {
        toast.success(`Used ${saved.quantity} ${saved.unit} of ${saved.material}`);
        onDone();
      }
    });
  }

  return (
    <form onSubmit={save} className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="text-lg font-semibold">Record usage</DialogTitle>
        <DialogDescription>Takes material out of this site&apos;s stock. It doesn&apos;t add any spending.</DialogDescription>
      </DialogHeader>
      <Field id="u-material" label="Material" error={errors.materialId}>
        <SelectField id="u-material" value={materialId} onChange={setMaterial} options={inStock.map((s) => ({ value: s.materialId, label: `${s.material} (${s.onHand} ${s.unit} left)` }))} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id="u-qty" label={`Quantity${row ? ` (${row.unit})` : ""}`} error={errors.quantity}>
          <Input id="u-qty" inputMode="decimal" className="h-11" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/[^\d.]/g, ""))} />
        </Field>
        <Field id="u-date" label="Date" error={errors.usedOn}>
          <Input id="u-date" type="date" className="h-11" max={today} value={usedOn} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <Field id="u-purpose" label="Used for (optional)" error={errors.purpose}>
        <Input id="u-purpose" className="h-11" maxLength={200} placeholder="e.g. First floor slab" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
      </Field>
      <DialogFooter>
        <Button type="submit" className="h-11 px-5" disabled={pending || !materialId}>{pending ? "Saving…" : "Save usage"}</Button>
      </DialogFooter>
    </form>
  );
}

function MaterialForm({ material, onDone }: { material: Material | null; onDone: () => void }) {
  const submit = useSubmit();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [name, setName] = useState(material?.name ?? "");
  const [unit, setUnit] = useState(material?.unit ?? "");
  const [price, setPrice] = useState(material?.defaultUnitPrice ?? "");
  const [active, setActive] = useState(material?.active ?? true);

  function save(e: FormEvent) {
    e.preventDefault();
    const body = { name, unit, defaultUnitPrice: price || undefined };
    start(async () => {
      const saved = await submit(() => (material ? updateMaterialAction({ ...body, id: material.id, active }) : createMaterialAction(body)), setErrors);
      if (saved) {
        toast.success(material ? "Material updated" : `${saved.name} added`);
        onDone();
      }
    });
  }

  return (
    <form onSubmit={save} className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="text-lg font-semibold">{material ? "Edit material" : "Add material"}</DialogTitle>
        <DialogDescription>Shared by every site in your organization.</DialogDescription>
      </DialogHeader>
      <Field id="m-name" label="Name" error={errors.name}>
        <Input id="m-name" className="h-11" maxLength={120} placeholder="e.g. Cement OPC 53" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id="m-unit" label="Unit" error={errors.unit} hint={material ? "Fixed once it's been bought or used" : undefined}>
          <Input id="m-unit" className="h-11" maxLength={20} list="m-units" placeholder="bags" value={unit} onChange={(e) => setUnit(e.target.value)} />
          <datalist id="m-units">{["bags", "loads", "tons", "kg", "nos", "cft", "sq ft", "litres", "ft"].map((u) => <option key={u} value={u} />)}</datalist>
        </Field>
        <Field id="m-price" label="Usual price (₹, optional)" error={errors.defaultUnitPrice}>
          <Input id="m-price" inputMode="decimal" className="h-11" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))} />
        </Field>
      </div>
      {material && (
        <label className="flex items-center justify-between gap-3 text-sm">
          Available for new purchases
          <Switch checked={active} onCheckedChange={setActive} />
        </label>
      )}
      <DialogFooter>
        <Button type="submit" className="h-11 px-5" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
      </DialogFooter>
    </form>
  );
}

function VoidForm({ purchase, onDone }: { purchase: Purchase; onDone: () => void }) {
  const submit = useSubmit();
  const fmt = useFormat();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          if (await submit(() => voidPurchaseAction({ id: purchase.id, reason }), setErrors)) {
            toast.success("Purchase voided");
            onDone();
          }
        });
      }}
      className="grid gap-4"
    >
      <DialogHeader>
        <DialogTitle className="text-lg font-semibold">Void this purchase?</DialogTitle>
        <DialogDescription>
          {fmt.money(Number(purchase.total))} from {purchase.supplier ?? "no supplier"} on {fmt.date(purchase.date)}. Its {purchase.bill ? "bill is removed" : "expense is removed"} and the stock it added is taken back. The record stays, marked void.
        </DialogDescription>
      </DialogHeader>
      <Field id="v-reason" label="Reason" error={errors.reason}>
        <Input id="v-reason" className="h-11" maxLength={300} placeholder="e.g. Entered twice" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <DialogFooter>
        <Button type="submit" className="h-11 bg-over px-5 text-white hover:bg-over/90" disabled={pending || !reason.trim()}>{pending ? "Voiding…" : "Void purchase"}</Button>
      </DialogFooter>
    </form>
  );
}

/** Shown by the server page when the user has no sites; the icon stays on the client. */
export function MaterialsNoSites() {
  return <EmptyState icon={Boxes} title="No sites yet" description="Materials are tracked per site. Add a site or ask to be invited to one." />;
}
