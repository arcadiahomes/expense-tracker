import "server-only";
import { localStorageDriver } from "./local";
import { s3StorageDriver } from "./s3";

export type SignedUrlOptions = {
  /** inline: open in the browser (preview). attachment: download. */
  disposition: "inline" | "attachment";
  fileName: string;
  contentType: string;
  /** Seconds the URL stays valid. */
  expiresIn: number;
};

/**
 * Where receipt files live. Rows in `receipts` only keep the storage key; files are
 * never served from a public path. Readers get a short-lived signed URL after the
 * data layer has checked their access.
 */
export interface StorageDriver {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  signedUrl(key: string, opts: SignedUrlOptions): Promise<string>;
}

/** How long a preview or download link works. */
export const SIGNED_URL_TTL = 300;

function pick(): StorageDriver {
  if (process.env.STORAGE_DRIVER === "s3") {
    const bucket = process.env.S3_BUCKET;
    if (!bucket) throw new Error("STORAGE_DRIVER=s3 needs S3_BUCKET (plus S3_REGION, and S3_ENDPOINT for R2 or MinIO).");
    return s3StorageDriver({ bucket, region: process.env.S3_REGION || "auto", endpoint: process.env.S3_ENDPOINT || undefined });
  }
  // Serverless file systems are read-only or wiped between requests: uploads would be lost.
  if (process.env.VERCEL) throw new Error("Set STORAGE_DRIVER=s3 (with S3_BUCKET) on Vercel; local file storage doesn't persist there.");
  return localStorageDriver(process.env.UPLOAD_DIR || ".uploads");
}

let driver: StorageDriver | undefined;

/** Picked on first use, so a misconfiguration fails the upload or download, not the build. */
export const storage: StorageDriver = {
  put: (...a) => (driver ??= pick()).put(...a),
  get: (...a) => (driver ??= pick()).get(...a),
  delete: (...a) => (driver ??= pick()).delete(...a),
  signedUrl: (...a) => (driver ??= pick()).signedUrl(...a),
};
