import "server-only";
import { ValidationError } from "./errors";
import { MAX_RECEIPT_BYTES, RECEIPT_TYPES } from "./validation";

export type ReceiptType = (typeof RECEIPT_TYPES)[number];

/**
 * Checks an uploaded file by its bytes, not just its name or declared type. Returns the
 * bytes to store: identical for PDFs and most images, but with EXIF/XMP removed from
 * JPEGs (phone cameras write the GPS location there).
 */
export function inspectUpload(bytes: Uint8Array, declared: string): { bytes: Uint8Array; type: ReceiptType; pages: number | null } {
  if (bytes.byteLength === 0) throw new ValidationError("That file is empty.", { file: "That file is empty." });
  if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new ValidationError("Files must be under 4 MB.", { file: "Files must be under 4 MB." });
  const sniffed = sniff(bytes);
  if (!sniffed) {
    throw new ValidationError("That file isn't a PDF, JPG, PNG, WebP or HEIC image.", { file: "Upload a PDF or a photo." });
  }
  // A declared type that disagrees with the content is refused, so a renamed file can't slip through.
  const declaredType = declared === "image/jpg" ? "image/jpeg" : declared === "image/heif" ? "image/heic" : declared;
  if (declaredType && declaredType !== "application/octet-stream" && declaredType !== sniffed) {
    throw new ValidationError("The file's contents don't match its type. Export it again and retry.", { file: "Contents don't match the file type." });
  }
  if (sniffed === "application/pdf") {
    checkPdf(bytes);
    return { bytes, type: sniffed, pages: pdfPageCount(bytes) };
  }
  return { bytes: sniffed === "image/jpeg" ? stripJpegMetadata(bytes) : bytes, type: sniffed, pages: null };
}

const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, at: number, len: number) => String.fromCharCode(...b.subarray(at, at + len));

export function sniff(b: Uint8Array): ReceiptType | null {
  if (ascii(b, 0, 5) === "%PDF-") return "application/pdf";
  if (starts(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
  // ISO base media file: "ftyp" at 4, HEIF brands from 8.
  if (ascii(b, 4, 4) === "ftyp" && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(ascii(b, 8, 4))) return "image/heic";
  return null;
}

/**
 * Receipts don't need active content. PDFs that can run script, launch programs or
 * carry embedded files are refused rather than stored and later opened by staff.
 */
function checkPdf(b: Uint8Array) {
  // latin1 keeps byte offsets 1:1; PDF names are ASCII.
  const text = Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");
  if (/\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA)\b/.test(text) || /\/OpenAction\s*<<[^>]*\/S\s*\/(JavaScript|Launch)/.test(text)) {
    throw new ValidationError("PDFs with scripts, launch actions or attached files aren't accepted. Print it to a new PDF or upload a photo.", {
      file: "This PDF has active content.",
    });
  }
}

function pdfPageCount(b: Uint8Array) {
  const text = Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");
  const n = (text.match(/\/Type\s*\/Page\b/g) ?? []).length;
  return n || null;
}

/** Removes APP1 (EXIF, XMP) and other APPn metadata segments, keeping JFIF (APP0) and ICC colour (APP2). */
export function stripJpegMetadata(b: Uint8Array): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    // Start of scan: the rest is image data.
    if (marker === 0xda) break;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return b; // malformed: keep the original rather than corrupt it
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const keep = !isApp || marker === 0xe0 || marker === 0xe2;
    if (keep) for (let k = i; k < i + 2 + len; k++) out.push(b[k]);
    i += 2 + len;
  }
  if (i >= b.length) return b;
  const result = new Uint8Array(out.length + (b.length - i));
  result.set(out, 0);
  result.set(b.subarray(i), out.length);
  return result;
}

/** A file name safe to show and to put in a Content-Disposition header. */
export function cleanFileName(name: string, type: ReceiptType) {
  const ext = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic" }[type];
  const base = name
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩"\\/:*?<>|]/g, "")
    .replace(/\.[^.]*$/, "")
    .trim()
    .slice(0, 150);
  return `${base || "receipt"}.${ext}`;
}
