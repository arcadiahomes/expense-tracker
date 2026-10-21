import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { db } from "@/db";
import { auditLog, expenses, receipts } from "@/db/schema";
import { createBill, getBill } from "@/server/data/bills";
import { listExpenses } from "@/server/data/expenses";
import {
  acknowledgeDuplicate,
  addReceipt,
  confirmReceiptDetails,
  extractReceiptDetails,
  getReceipt,
  listReceipts,
  readReceipt,
  receiptLink,
  removeReceipt,
  replaceReceipt,
  scanUpload,
} from "@/server/data/receipts";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { sniff, stripJpegMetadata } from "@/server/files";
import { MAX_RECEIPT_BYTES } from "@/lib/types";
import { buildReport } from "@/server/reports/build";
import { storage } from "@/server/storage";
import { signFileToken, verifyFileToken } from "@/server/storage/local";
import { addExpense, world } from "./fixtures";

// OCR is replaced by a controllable stub; nothing leaves the machine in tests.
const ocr = vi.hoisted(() => ({ available: true, read: vi.fn() }));
vi.mock("@/server/receipt-ocr", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/receipt-ocr")>();
  return { ...real, ocrAvailable: () => ocr.available, readReceipt: ocr.read };
});

const enc = (s: string) => new TextEncoder().encode(s);
let n = 0;
/** A small, unique, valid PDF. */
const pdf = (tag = `${++n}`) => enc(`%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n% ${tag}\n%%EOF`);
const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ++n]);
/** JPEG with a JFIF header, an EXIF block carrying a GPS marker, then image data. */
function jpegWithGps() {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...enc("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const exifBody = [...enc("Exif\0\0GPSLatitude 10.0159N 76.3419E")];
  const app1 = [0xff, 0xe1, (exifBody.length + 2) >> 8, (exifBody.length + 2) & 0xff, ...exifBody];
  const sos = [0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, ...enc("pixels"), ++n, 0xff, 0xd9];
  return new Uint8Array([0xff, 0xd8, ...app0, ...app1, ...sos]);
}

let w: Awaited<ReturnType<typeof world>>;
let mine: string; // eng1's expense on site 1
let theirs: string; // accountant's expense on site 1
let billId: string;
beforeAll(async () => {
  w = await world();
  mine = (await addExpense(w.a.eng1, w.site1, { description: "Cement", items: [{ description: "Cement", unitPrice: "8000" }] })).id;
  theirs = (await addExpense(w.a.accountant, w.site1, { description: "Sand", items: [{ description: "Sand", unitPrice: "5000" }] })).id;
  billId = (await createBill(w.a.owner, { siteId: w.site1, supplierName: "Kerala Steels", billNumber: "KS-9", billDate: "2026-10-10", dueDate: "2026-10-30", amount: "12000" })).id;
}, 600_000);
beforeEach(() => {
  ocr.available = true;
  ocr.read.mockReset();
});

const upload = (actor = w.a.eng1, over: Record<string, unknown> = {}, bytes: Uint8Array = pdf()) =>
  addReceipt(actor, { siteId: w.site1, expenseId: mine, fileName: "receipt.pdf", contentType: "application/pdf", ...over }, bytes);
const auditFor = (id: string) => db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, id));

describe("file checks", () => {
  it("identify files by their content", () => {
    expect(sniff(pdf())).toBe("application/pdf");
    expect(sniff(png())).toBe("image/png");
    expect(sniff(jpegWithGps())).toBe("image/jpeg");
    expect(sniff(new Uint8Array([0, 0, 0, 0x18, ...enc("ftypheic"), 0, 0]))).toBe("image/heic");
    expect(sniff(enc("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniff(enc("MZ\x90\0 not a receipt"))).toBeNull();
  });

  it("refuse a mismatched type, unknown content, empty and oversized files", async () => {
    await expect(upload(w.a.eng1, { contentType: "image/png" }, pdf())).rejects.toBeInstanceOf(ValidationError);
    await expect(upload(w.a.eng1, { fileName: "x.pdf" }, enc("<html><script>alert(1)</script>"))).rejects.toBeInstanceOf(ValidationError);
    await expect(upload(w.a.eng1, {}, new Uint8Array())).rejects.toBeInstanceOf(ValidationError);
    // Just over the limit: Vercel refuses request bodies over 4.5 MB, so files are capped at 4 MB.
    const big = new Uint8Array(MAX_RECEIPT_BYTES + 1);
    big.set(enc("%PDF-1.4"));
    await expect(upload(w.a.eng1, {}, big)).rejects.toBeInstanceOf(ValidationError);
    await expect(upload(w.a.eng1, { contentType: "application/x-msdownload" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuse PDFs with scripts, launch actions or embedded files", async () => {
    for (const body of ["/OpenAction << /S /JavaScript /JS (app.alert(1)) >>", "/Launch << /F (cmd.exe) >>", "/EmbeddedFile 3 0 R"]) {
      await expect(upload(w.a.eng1, {}, enc(`%PDF-1.7\n${body}\n%%EOF`))).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("strip GPS and other EXIF from camera photos, keeping the image", async () => {
    const raw = jpegWithGps();
    const stripped = stripJpegMetadata(raw);
    const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");
    expect(text(raw)).toContain("GPSLatitude");
    expect(text(stripped)).not.toContain("GPSLatitude");
    expect(text(stripped)).toContain("JFIF");
    expect(text(stripped)).toContain("pixels");
    const r = await upload(w.a.eng1, { fileName: "IMG_2041.jpg", contentType: "image/jpeg", captureSource: "camera" }, raw);
    const stored = await readReceipt(w.a.eng1, r.id);
    expect(text(stored.bytes)).not.toContain("GPS");
    expect(r.captureSource).toBe("camera");
    expect(r.sizeBytes).toBe(stripped.byteLength);
  });

  it("clean file names", async () => {
    const r = await upload(w.a.eng1, { fileName: '../../"bill"‮gnp.exe' });
    expect(r.fileName).toBe("....billgnp.pdf");
  });
});

describe("access", () => {
  it("uploads need permission to add expenses on that site, to a record on that site", async () => {
    await expect(upload(w.a.viewer)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(upload(w.a.eng2)).rejects.toBeInstanceOf(NotFoundError);
    await expect(upload(w.b.owner)).rejects.toBeInstanceOf(NotFoundError);
    await expect(upload(w.a.owner, { siteId: w.site2 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(upload(w.a.eng1, { supplierBillId: billId })).rejects.toThrow();
  });

  it("anyone who can see the site can view; only the record's managers can replace or remove", async () => {
    const onTheirs = await upload(w.a.accountant, { expenseId: theirs });
    expect((await getReceipt(w.a.viewer, onTheirs.id)).canManage).toBe(false);
    await expect(getReceipt(w.a.eng2, onTheirs.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(removeReceipt(w.a.eng1, { id: onTheirs.id, reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(replaceReceipt(w.a.viewer, onTheirs.id, { fileName: "a.pdf", contentType: "application/pdf" }, pdf())).rejects.toBeInstanceOf(ForbiddenError);
    // Engineers manage files on their own expenses; bill files are for finance roles.
    const own = await upload(w.a.eng1);
    expect((await getReceipt(w.a.eng1, own.id)).canManage).toBe(true);
    const onBill = await upload(w.a.eng1, { expenseId: undefined, supplierBillId: billId });
    await expect(removeReceipt(w.a.eng1, { id: onBill.id, reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await removeReceipt(w.a.accountant, { id: onBill.id, reason: "Wrong bill" });
  });
});

describe("signed links", () => {
  it("are short-lived, tamper-proof and checked against site access", async () => {
    const r = await upload();
    const { url, expiresIn } = await receiptLink(w.a.viewer, r.id, "download");
    expect(expiresIn).toBe(300);
    const token = url.split("/").pop()!;
    expect(verifyFileToken(token)).toMatchObject({ d: "attachment", n: "receipt.pdf", t: "application/pdf" });
    expect(verifyFileToken(token, Math.floor(Date.now() / 1000) + 301)).toBeNull();
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), key: "other-org/secret.pdf" })).toString("base64url");
    expect(verifyFileToken(`${forged}.${sig}`)).toBeNull();
    await expect(receiptLink(w.a.eng2, r.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(receiptLink(w.b.owner, r.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("serve the file with safe headers, and refuse once expired", async () => {
    const { GET } = await import("@/app/api/files/[token]/route");
    const r = await upload(w.a.eng1, { fileName: "photo.png", contentType: "image/png" }, png());
    const token = (await receiptLink(w.a.eng1, r.id)).url.split("/").pop()!;
    const res = await GET(new Request("http://t"), { params: Promise.resolve({ token }) } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="photo.png"/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    const row = (await db.select().from(receipts).where(eq(receipts.id, r.id)))[0];
    const expired = signFileToken({ key: row.storageKey, d: "inline", n: "x.png", t: "image/png", exp: Math.floor(Date.now() / 1000) - 1 });
    expect((await GET(new Request("http://t"), { params: Promise.resolve({ token: expired }) } as never)).status).toBe(403);
  });
});

describe("replace and remove", () => {
  it("replacing keeps the old row for the record and deletes the old file", async () => {
    const old = await upload();
    const oldKey = (await db.select().from(receipts).where(eq(receipts.id, old.id)))[0].storageKey;
    const fresh = await replaceReceipt(w.a.eng1, old.id, { fileName: "better.jpg", contentType: "image/jpeg" }, jpegWithGps());
    expect(fresh.replacesId).toBe(old.id);
    expect(await storage.get(oldKey)).toBeNull();
    await expect(getReceipt(w.a.eng1, old.id)).rejects.toBeInstanceOf(NotFoundError);
    const live = await listReceipts(w.a.eng1, { expenseId: mine });
    expect(live.some((x) => x.id === old.id)).toBe(false);
    const history = await listReceipts(w.a.eng1, { expenseId: mine }, { history: true });
    expect(history.find((x) => x.id === old.id)?.removed?.reason).toBe("Replaced");
    expect((await auditFor(fresh.id)).map((a) => a.action)).toEqual(["receipt.replace"]);
  });

  it("removing needs a reason, deletes the file and records who and why", async () => {
    const r = await upload();
    await expect(removeReceipt(w.a.eng1, { id: r.id, reason: "" })).rejects.toBeInstanceOf(ZodError);
    await removeReceipt(w.a.eng1, { id: r.id, reason: "Blurry photo" });
    const [row] = await db.select().from(receipts).where(eq(receipts.id, r.id));
    expect([row.deleteReason, row.deletedBy]).toEqual(["Blurry photo", w.a.eng1.userId]);
    expect(await storage.get(row.storageKey)).toBeNull();
    await expect(receiptLink(w.a.eng1, r.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await auditFor(r.id)).map((a) => a.action).sort()).toEqual(["receipt.remove", "receipt.upload"]);
  });

  it("removed bill files no longer show on the bill", async () => {
    const r = await upload(w.a.owner, { expenseId: undefined, supplierBillId: billId });
    expect((await getBill(w.a.owner, billId)).attachment?.id).toBe(r.id);
    await removeReceipt(w.a.owner, { id: r.id, reason: "Duplicate scan" });
    expect((await getBill(w.a.owner, billId)).attachment).toBeUndefined();
  });
});

describe("duplicates", () => {
  it("flags the same file uploaded twice, and removes nothing", async () => {
    const bytes = pdf("same-bill");
    const first = await upload(w.a.eng1, {}, bytes);
    const second = await upload(w.a.accountant, { expenseId: theirs }, bytes);
    expect(first.duplicateOfId).toBeNull();
    expect(second.duplicateOfId).toBe(first.id);
    expect(second.duplicateReason).toMatch(/Same file/);
    expect((await getReceipt(w.a.eng1, first.id)).removed).toBeNull();
    const ack = await acknowledgeDuplicate(w.a.accountant, second.id);
    expect(ack.duplicate).toMatchObject({ ofId: first.id, acknowledged: true });
    expect((await auditFor(second.id)).map((a) => a.action).sort()).toEqual(["receipt.duplicate_ok", "receipt.upload"]);
  });

  it("flags a different file with the same supplier and bill number", async () => {
    const a = await upload();
    await confirmReceiptDetails(w.a.eng1, { id: a.id, supplier: "Malabar Hardware", billNumber: "MH-42" });
    const b = await upload(w.a.accountant, { expenseId: theirs, ocr: { supplier: "malabar hardware", billNumber: "mh-42", date: null, amount: null, legible: true, notes: null, model: "test" } });
    expect(b.duplicateOfId).toBe(a.id);
    expect(b.duplicateReason).toMatch(/bill number/);
  });
});

describe("reading details (OCR)", () => {
  const suggestion = { supplier: "Sri Balaji", billNumber: "SB-1", date: "2026-10-12", amount: "7999.00", legible: true, notes: null, model: "test" };

  it("stores suggestions without changing the expense, until a person confirms", async () => {
    ocr.read.mockResolvedValue(suggestion);
    const r = await upload();
    const read = await extractReceiptDetails(w.a.eng1, r.id);
    expect([read.ocrStatus, read.ocr?.amount, read.confirmed]).toEqual(["done", "7999.00", null]);
    const [exp] = await db.select({ total: expenses.totalAmount }).from(expenses).where(eq(expenses.id, mine));
    expect(exp.total).toBe("8000.00");

    const { receipt, differences } = await confirmReceiptDetails(w.a.eng1, { id: r.id, supplier: "Sri Balaji", amount: "7999", date: "2026-10-12" });
    expect(receipt.confirmed).toEqual({ supplier: "Sri Balaji", amount: "7999", date: "2026-10-12" });
    expect(receipt.confirmedBy).toBe("Engineer One");
    expect(differences).toEqual([expect.stringMatching(/receipt says ₹7,999.*expense is ₹8,000/), expect.stringMatching(/dated 2026-10-12; the expense is dated 2026-10-20/)]);
    // Still unchanged: confirming a receipt never edits the record.
    expect((await db.select({ total: expenses.totalAmount }).from(expenses).where(eq(expenses.id, mine)))[0].total).toBe("8000.00");
    await expect(confirmReceiptDetails(w.a.eng1, { id: r.id, date: "2026-10-21" })).rejects.toBeInstanceOf(ValidationError);
    await expect(confirmReceiptDetails(w.a.viewer, { id: r.id, amount: "1" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("records failures and unsupported files instead of guessing", async () => {
    ocr.read.mockRejectedValue(new Error("timeout"));
    expect((await extractReceiptDetails(w.a.eng1, (await upload()).id)).ocrStatus).toBe("failed");
    const heic = await upload(w.a.eng1, { fileName: "IMG.heic", contentType: "image/heic" }, new Uint8Array([0, 0, 0, 0x18, ...enc("ftypheic"), ++n]));
    expect((await extractReceiptDetails(w.a.eng1, heic.id)).ocrStatus).toBe("unsupported");
    ocr.available = false;
    await expect(extractReceiptDetails(w.a.eng1, heic.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("can read a file before it's saved, storing nothing", async () => {
    ocr.read.mockResolvedValue(suggestion);
    const before = (await db.select().from(receipts)).length;
    const res = await scanUpload(w.a.eng1, w.site1, "application/pdf", pdf());
    expect(res.suggestion.billNumber).toBe("SB-1");
    expect((await db.select().from(receipts)).length).toBe(before);
    await expect(scanUpload(w.a.viewer, w.site1, "application/pdf", pdf())).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("expenses and reports", () => {
  it("show how many receipts each expense has", async () => {
    const { items } = await listExpenses(w.a.eng1, { siteId: w.site1 });
    const live = await db.select().from(receipts).where(and(eq(receipts.expenseId, mine)));
    expect(items.find((e) => e.id === mine)?.receipts).toBe(live.filter((r) => !r.deletedAt).length);
    expect(items.find((e) => e.id === mine)?.canManageReceipts).toBe(true);
  });

  it("list receipts per expense and count expenses without one", async () => {
    await addExpense(w.a.eng1, w.site1, { description: "No receipt here", items: [{ description: "x", unitPrice: "10" }] });
    const r = await buildReport(w.a.owner, { kind: "expenses", format: "xlsx", from: "2026-10-01", to: "2026-10-20", siteId: w.site1 });
    const s = r.sections[0];
    const rows = s.groups.flatMap((g) => g.rows);
    expect(rows.find((x) => x.description === "No receipt here")?.receipts).toBe(0);
    expect(Number(rows.find((x) => x.description === "Cement")?.receipts)).toBeGreaterThan(0);
    expect(String(s.total?.description)).toMatch(/\d+ without a receipt/);
  });
});
