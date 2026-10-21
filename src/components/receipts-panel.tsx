"use client";

import { useCallback, useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { Camera, Copy, Download, Eye, FileText, History, Paperclip, RefreshCw, ScanText, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, useSubmit } from "@/components/form-bits";
import { formatFileSize } from "@/lib/format";
import { MAX_RECEIPT_BYTES } from "@/lib/types";
import { useFormat, useSession } from "@/lib/session";
import {
  acknowledgeDuplicateAction,
  confirmReceiptAction,
  extractReceiptAction,
  loadReceiptsAction,
  removeReceiptAction,
  replaceReceiptAction,
  uploadReceiptAction,
} from "@/server/actions/receipts";
import type { ReceiptView } from "@/server/data/receipts";
import { cn } from "@/lib/utils";

export const RECEIPT_ACCEPT = "application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif";

/** A quick client check for a friendly message; the server checks the bytes again. */
export function checkFile(f: File): string | null {
  if (f.size > MAX_RECEIPT_BYTES) return `${f.name} is ${formatFileSize(f.size)}. Files must be under 4 MB: export a smaller PDF or take the photo again.`;
  if (f.size === 0) return `${f.name} is empty.`;
  if (f.type && !RECEIPT_ACCEPT.split(",").includes(f.type)) return `${f.name} isn't a PDF or photo.`;
  return null;
}

/**
 * Shrinks a large JPEG, PNG or WebP photo (phone cameras often exceed the upload limit) by
 * redrawing it at up to 2400 px as a JPEG, which also drops its EXIF. Other files, and photos
 * the browser can't decode (HEIC in most browsers), are returned as they are.
 */
async function shrinkPhoto(f: File): Promise<File> {
  if (f.size <= MAX_RECEIPT_BYTES || !["image/jpeg", "image/png", "image/webp"].includes(f.type)) return f;
  try {
    const bitmap = await createImageBitmap(f);
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob || blob.size >= f.size) return f;
    return new File([blob], f.name.replace(/\.[^.]*$/, "") + ".jpg", { type: "image/jpeg", lastModified: f.lastModified });
  } catch {
    return f;
  }
}

/** The file to upload (large photos shrunk), or a message saying why it can't be. */
export async function prepareFile(f: File): Promise<File | string> {
  const file = await shrinkPhoto(f);
  return checkFile(file) ?? file;
}

/** Two buttons: the rear camera (on phones) and the file picker. */
export function FilePickers({ onPick, disabled, label = "Add receipt" }: { onPick: (f: File, source: "camera" | "file") => void; disabled?: boolean; label?: string }) {
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const take = (source: "camera" | "file") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    void prepareFile(f).then((r) => (typeof r === "string" ? toast.error(r) : onPick(r, source)));
  };
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" className="h-11" disabled={disabled} onClick={() => camera.current?.click()}>
        <Camera aria-hidden /> Take photo
      </Button>
      <Button type="button" variant="outline" className="h-11" disabled={disabled} onClick={() => picker.current?.click()}>
        <Upload aria-hidden /> {label}
      </Button>
      <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden onChange={take("camera")} />
      <input ref={picker} type="file" accept={RECEIPT_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden onChange={take("file")} />
    </div>
  );
}

/**
 * Files on one expense or bill. Viewing needs site access; uploading needs permission to
 * add expenses; replacing and removing need permission to manage this record (checked
 * again on the server for every action).
 */
export function ReceiptsPanel({
  siteId,
  expenseId,
  supplierBillId,
  canUpload,
}: {
  siteId: string;
  expenseId?: string;
  supplierBillId?: string;
  canUpload: boolean;
}) {
  const submit = useSubmit();
  const [list, setList] = useState<ReceiptView[] | null>(null);
  const [history, setHistory] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, start] = useTransition();

  const load = useCallback(
    (withHistory: boolean) =>
      loadReceiptsAction({ expenseId, supplierBillId }, withHistory)
        .then((res) => (res.ok ? (setList(res.data), setFailed(false)) : setFailed(true)))
        .catch(() => setFailed(true)),
    [expenseId, supplierBillId],
  );
  useEffect(() => {
    void load(history);
  }, [load, history]);

  function upload(file: File, source: "camera" | "file") {
    const form = new FormData();
    form.set("file", file);
    form.set("siteId", siteId);
    if (expenseId) form.set("expenseId", expenseId);
    if (supplierBillId) form.set("supplierBillId", supplierBillId);
    form.set("captureSource", source);
    start(async () => {
      const saved = await submit(() => uploadReceiptAction(form), () => {});
      if (saved) {
        toast[saved.duplicate ? "warning" : "success"](saved.duplicate ? "Uploaded, but it may be a duplicate" : "Receipt attached", { description: saved.duplicate?.reason });
        await load(history);
      }
    });
  }

  const live = list?.filter((r) => !r.removed) ?? [];
  const removed = list?.filter((r) => r.removed) ?? [];
  return (
    <section aria-label="Receipts and files" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Paperclip className="size-4" aria-hidden /> Receipts and files
        </h3>
        <button type="button" className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setHistory((h) => !h)}>
          <History className="size-3.5" aria-hidden /> {history ? "Hide history" : "Show history"}
        </button>
      </div>
      {failed ? (
        <p className="text-sm text-muted-foreground">Couldn&apos;t load the files. Check your connection and reopen this.</p>
      ) : !list ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : live.length === 0 ? (
        <p className="rounded-xl border border-dashed border-primary/25 p-3 text-sm text-muted-foreground">No receipt attached.</p>
      ) : (
        <ul className="space-y-3">
          {live.map((r) => (
            <li key={r.id}>
              <ReceiptCard receipt={r} onChanged={() => load(history)} />
            </li>
          ))}
        </ul>
      )}
      {canUpload && <FilePickers onPick={upload} disabled={busy} label={live.length ? "Add another" : "Choose file"} />}
      {busy && <p className="text-xs text-muted-foreground" role="status">Uploading and checking the file…</p>}
      {history && removed.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-secondary/50 p-3 text-xs text-muted-foreground">
          {removed.map((r) => (
            <li key={r.id}>
              {r.fileName}: {r.removed!.reason ?? "Removed"} on {new Date(r.removed!.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}. Uploaded by {r.uploadedBy}.
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReceiptCard({ receipt: r, onChanged }: { receipt: ReceiptView; onChanged: () => void }) {
  const submit = useSubmit();
  const { features, today } = useSession();
  const fmt = useFormat();
  const [busy, start] = useTransition();
  const [removing, setRemoving] = useState(false);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);

  const act = (call: () => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>, done: string) =>
    start(async () => {
      if (await submit(call as never, () => {})) {
        toast.success(done);
        onChanged();
      }
    });

  function replace(file: File, source: "camera" | "file") {
    const form = new FormData();
    form.set("id", r.id);
    form.set("file", file);
    form.set("captureSource", source);
    act(() => replaceReceiptAction(form) as never, "File replaced");
  }

  const suggestion = r.ocr;
  return (
    <article className="rounded-xl border border-[var(--line)] bg-card p-3">
      <div className="flex items-start gap-3">
        <a href={r.previewUrl} target="_blank" rel="noopener noreferrer" className="shrink-0" aria-label={`Preview ${r.fileName}`}>
          {r.kind === "image" ? (
            // A signed, expiring URL behind an access check; never a public path.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={r.previewUrl} alt="" className="size-14 rounded object-cover" loading="lazy" referrerPolicy="no-referrer" />
          ) : (
            <span className="grid size-14 place-items-center rounded bg-muted text-muted-foreground">
              <FileText aria-hidden />
            </span>
          )}
        </a>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{r.fileName}</p>
          <p className="text-xs text-muted-foreground">
            {[formatFileSize(r.size), r.pages && `${r.pages} ${r.pages === 1 ? "page" : "pages"}`, r.captureSource === "camera" && "camera photo", `by ${r.uploadedBy}`, new Date(r.uploadedAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p className="font-mono text-[0.6875rem] text-muted-foreground" title="SHA-256 of the stored file">
            {r.sha256.slice(0, 12)}
          </p>
        </div>
      </div>

      {r.duplicate && !r.duplicate.acknowledged && (
        <div role="alert" className="mt-3 rounded-lg border border-warn/40 bg-warn/10 p-2.5 text-xs">
          <p className="flex items-center gap-1 font-medium text-warn">
            <Copy className="size-3.5" aria-hidden /> Possible duplicate
          </p>
          <p className="mt-0.5">{r.duplicate.reason} Nothing has been removed.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <a href={`/api/receipts/${r.duplicate.ofId}`} target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center rounded-md border px-3">
              Open the other file
            </a>
            {r.canManage && (
              <Button size="sm" variant="outline" className="h-9" disabled={busy} onClick={() => act(() => acknowledgeDuplicateAction(r.id) as never, "Marked as a separate receipt")}>
                It&apos;s a separate receipt
              </Button>
            )}
          </div>
        </div>
      )}

      {suggestion && !r.confirmed && (
        <div className="mt-3 rounded-lg bg-secondary/70 p-2.5 text-xs">
          <p className="font-medium">Read from the file. Check before relying on it.</p>
          <p className="mt-0.5 text-muted-foreground">
            {[suggestion.supplier, suggestion.billNumber && `No. ${suggestion.billNumber}`, suggestion.date && fmt.date(suggestion.date), suggestion.amount && fmt.money(Number(suggestion.amount))].filter(Boolean).join(" · ") || "Nothing could be read with confidence."}
            {!suggestion.legible && " The file looked unclear."}
          </p>
          {suggestion.notes && <p className="mt-0.5 text-muted-foreground">{suggestion.notes}</p>}
        </div>
      )}
      {r.confirmed && (
        <p className="mt-3 text-xs text-muted-foreground">
          Confirmed by {r.confirmedBy}: {[r.confirmed.supplier, r.confirmed.billNumber && `No. ${r.confirmed.billNumber}`, r.confirmed.date && fmt.date(r.confirmed.date), r.confirmed.amount && fmt.money(Number(r.confirmed.amount))].filter(Boolean).join(" · ")}
        </p>
      )}
      {r.ocrStatus === "failed" && <p className="mt-2 text-xs text-muted-foreground">Automatic reading failed. You can enter the details yourself.</p>}
      {r.ocrStatus === "unsupported" && <p className="mt-2 text-xs text-muted-foreground">HEIC photos can&apos;t be read automatically.</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        <a href={r.previewUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center gap-1.5 rounded-md border px-3 text-sm">
          <Eye className="size-4" aria-hidden /> Preview
        </a>
        <a href={r.downloadUrl} className="inline-flex h-10 items-center gap-1.5 rounded-md border px-3 text-sm">
          <Download className="size-4" aria-hidden /> Download
        </a>
        {features.receiptOcr && !r.confirmed && (
          <Button size="sm" variant="outline" className="h-10" disabled={busy} onClick={() => act(() => extractReceiptAction(r.id) as never, "File read. Check the details.")}>
            <ScanText aria-hidden /> {suggestion ? "Read again" : "Read details"}
          </Button>
        )}
        {!r.confirmed && (
          <Button size="sm" variant="outline" className="h-10" onClick={() => setConfirming((c) => !c)}>
            Confirm details
          </Button>
        )}
        {r.canManage && (
          <>
            <ReplaceButton onPick={replace} disabled={busy} />
            <Button size="sm" variant="ghost" className="h-10 text-over" disabled={busy} onClick={() => setRemoving((v) => !v)}>
              <Trash2 aria-hidden /> Remove
            </Button>
          </>
        )}
      </div>

      {removing && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            act(() => removeReceiptAction({ id: r.id, reason }) as never, "File removed");
          }}
        >
          <Field id={`rm-${r.id}`} label="Why remove it?" className="min-w-48 flex-1">
            <Input id={`rm-${r.id}`} className="h-10" maxLength={300} placeholder="e.g. Wrong bill attached" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Button type="submit" className="h-10 bg-over text-white hover:bg-over/90" disabled={busy || !reason.trim()}>Remove file</Button>
        </form>
      )}
      {confirming && <ConfirmForm receipt={r} today={today} onDone={() => { setConfirming(false); onChanged(); }} />}
    </article>
  );
}

function ReplaceButton({ onPick, disabled }: { onPick: (f: File, source: "camera" | "file") => void; disabled: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button size="sm" variant="outline" className="h-10" disabled={disabled} onClick={() => ref.current?.click()}>
        <RefreshCw aria-hidden /> Replace
      </Button>
      <input
        ref={ref}
        type="file"
        accept={RECEIPT_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          void prepareFile(f).then((r) => (typeof r === "string" ? toast.error(r) : onPick(r, "file")));
        }}
      />
    </>
  );
}

/** A person confirms what the file says, starting from any suggestion. Only stored on the receipt. */
function ConfirmForm({ receipt: r, today, onDone }: { receipt: ReceiptView; today: string; onDone: () => void }) {
  const submit = useSubmit();
  const [busy, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const s = r.ocr;
  const [supplier, setSupplier] = useState(s?.supplier ?? "");
  const [billNumber, setBillNumber] = useState(s?.billNumber ?? "");
  const [date, setDate] = useState(s?.date ?? "");
  const [amount, setAmount] = useState(s?.amount ?? "");
  const [diffs, setDiffs] = useState<string[] | null>(null);

  return (
    <form
      className="mt-3 grid gap-3 rounded-lg border p-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        start(async () => {
          const res = await submit(
            () => confirmReceiptAction({ id: r.id, supplier: supplier || undefined, billNumber: billNumber || undefined, date: date || undefined, amount: amount || undefined }),
            setErrors,
          );
          if (!res) return;
          if (res.differences.length) setDiffs(res.differences);
          else {
            toast.success("Details confirmed");
            onDone();
          }
        });
      }}
    >
      <p className="text-xs text-muted-foreground">{s ? "Pre-filled from the file. Correct anything that's wrong." : "Enter what the receipt shows."} Leave out anything you can&apos;t read.</p>
      <div className={cn("grid gap-3 sm:grid-cols-2")}>
        <Field id={`c-sup-${r.id}`} label="Supplier" error={errors.supplier}>
          <Input id={`c-sup-${r.id}`} className="h-10" maxLength={120} value={supplier} onChange={(e) => setSupplier(e.target.value)} />
        </Field>
        <Field id={`c-no-${r.id}`} label="Bill number" error={errors.billNumber}>
          <Input id={`c-no-${r.id}`} className="h-10" maxLength={60} value={billNumber} onChange={(e) => setBillNumber(e.target.value)} />
        </Field>
        <Field id={`c-date-${r.id}`} label="Date" error={errors.date}>
          <Input id={`c-date-${r.id}`} type="date" className="h-10" max={today} value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field id={`c-amt-${r.id}`} label="Total (₹)" error={errors.amount}>
          <Input id={`c-amt-${r.id}`} inputMode="decimal" className="num h-10" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
        </Field>
      </div>
      {diffs && (
        <div role="alert" className="rounded-md bg-warn/10 p-2 text-xs">
          <p className="font-medium text-warn">Confirmed, but it doesn&apos;t match the record:</p>
          <ul className="mt-1 list-disc pl-4">{diffs.map((d) => <li key={d}>{d}</li>)}</ul>
          <p className="mt-1">The record wasn&apos;t changed. Edit it if the receipt is right.</p>
          <Button type="button" size="sm" variant="outline" className="mt-2 h-9" onClick={onDone}>Done</Button>
        </div>
      )}
      {!diffs && <Button type="submit" className="h-10 w-fit" disabled={busy}>{busy ? "Saving…" : "Confirm"}</Button>}
    </form>
  );
}
