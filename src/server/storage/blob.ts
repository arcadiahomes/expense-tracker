import "server-only";
import { del, get, put } from "@vercel/blob";
import { signFileToken } from "./local";
import type { StorageDriver } from "./index";

/**
 * Vercel Blob, private store only. Credentials come from BLOB_READ_WRITE_TOKEN or the
 * runtime's OIDC token with BLOB_STORE_ID, never from the client. Blob's presigned GETs
 * can't set Content-Disposition or our security headers, so signed URLs use the same
 * HMAC token as local storage and /api/files/<token> streams the bytes (receipts are
 * capped at 4 MB, under Vercel's 4.5 MB response limit).
 */
export function blobStorageDriver(): StorageDriver {
  return {
    async put(key, bytes, contentType) {
      await put(key, Buffer.from(bytes), {
        access: "private",
        contentType,
        // Keys are opaque and never reused; an overwrite would mean a bug.
        addRandomSuffix: false,
        allowOverwrite: false,
        cacheControlMaxAge: 60,
      });
    },
    async get(key) {
      // Skip the CDN cache so a removed receipt can't be served from a cached copy.
      const res = await get(key, { access: "private", useCache: false });
      if (!res || res.statusCode !== 200) return null;
      return new Uint8Array(await new Response(res.stream).arrayBuffer());
    },
    async delete(key) {
      await del(key);
    },
    async signedUrl(key, opts) {
      return `/api/files/${signFileToken({ key, d: opts.disposition, n: opts.fileName, t: opts.contentType, exp: Math.floor(Date.now() / 1000) + opts.expiresIn })}`;
    },
  };
}
