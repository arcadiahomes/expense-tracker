import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SignedUrlOptions, StorageDriver } from "./index";

/**
 * Development driver: files under UPLOAD_DIR, keyed by an opaque storage key. Signed
 * URLs point at /api/files/<token>, an HMAC-signed, expiring token that names the key
 * and how to serve it, so the app never serves a file by a guessable path.
 */
export function localStorageDriver(dir: string): StorageDriver {
  const root = path.resolve(dir);
  const resolve = (key: string) => {
    const full = path.resolve(root, key);
    // Keys are generated server-side, but never let one escape the upload dir.
    if (!full.startsWith(root + path.sep)) throw new Error("Invalid storage key.");
    return full;
  };
  return {
    async put(key, bytes) {
      const file = resolve(key);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes, { mode: 0o600 });
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(resolve(key)));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async delete(key) {
      await rm(resolve(key), { force: true });
    },
    async signedUrl(key, opts) {
      return `/api/files/${signFileToken({ key, d: opts.disposition, n: opts.fileName, t: opts.contentType, exp: Math.floor(Date.now() / 1000) + opts.expiresIn })}`;
    },
  };
}

type FileToken = { key: string; d: SignedUrlOptions["disposition"]; n: string; t: string; exp: number };

function secret() {
  const s = process.env.FILE_URL_SECRET || process.env.BETTER_AUTH_SECRET;
  if (!s) throw new Error("Set FILE_URL_SECRET (or BETTER_AUTH_SECRET) to sign file links.");
  return s;
}

const mac = (body: string) => createHmac("sha256", secret()).update(body).digest("base64url");

export function signFileToken(t: FileToken) {
  const body = Buffer.from(JSON.stringify(t)).toString("base64url");
  return `${body}.${mac(body)}`;
}

/** The token's contents if its signature is valid and it hasn't expired; otherwise null. */
export function verifyFileToken(token: string, now = Math.floor(Date.now() / 1000)): FileToken | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const want = Buffer.from(mac(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as FileToken;
    return typeof t.exp === "number" && t.exp >= now && typeof t.key === "string" ? t : null;
  } catch {
    return null;
  }
}
