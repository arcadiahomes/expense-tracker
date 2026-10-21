"use client";

import { useSyncExternalStore } from "react";
import type { VoiceDraft, VoiceLanguage } from "./voice";

/**
 * Voice entries kept on this device because they couldn't be sent. They are never
 * shown as saved: each is labelled unsynced until the server confirms the save.
 *
 * - Stored per user and organization, so another account on a shared phone neither
 *   sees nor sends them.
 * - Each draft keeps the save key it was created with. Syncing reuses it, so if an
 *   earlier attempt did reach the server, the server returns that save instead of
 *   saving twice.
 * - A draft is only removed when the server confirms the save, or when the user
 *   discards it. A sync that's refused (duplicates to confirm, a site no longer
 *   available, entries already saved with different values) leaves it in place,
 *   marked for review.
 */

export type DraftStatus = "unsynced" | "needs_review" | "conflict";

export type OfflineDraft = {
  /** The save key (idempotency key) used for every attempt. */
  clientKey: string;
  userId: string;
  orgId: string;
  /** When the entries were captured. Sent to the server, never changed. */
  capturedAt: string;
  updatedAt: string;
  status: DraftStatus;
  message: string | null;
  attempts: number;
  siteName: string;
  totalPaise: number;
  payload: {
    transcript?: string;
    language: VoiceLanguage;
    extractor: "rules" | "claude" | "manual";
    spoken: boolean;
    entries: VoiceDraft[];
    acknowledgedDuplicates: number[];
  };
};

const key = (userId: string, orgId: string) => `arcadia.voiceDrafts.v1.${userId}.${orgId}`;
const listeners = new Set<() => void>();
let cache: { k: string; raw: string | null; list: OfflineDraft[] } | null = null;

function read(userId: string, orgId: string): OfflineDraft[] {
  const k = key(userId, orgId);
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(k);
  } catch {
    return [];
  }
  if (cache && cache.k === k && cache.raw === raw) return cache.list;
  let list: OfflineDraft[] = [];
  try {
    const parsed = raw ? (JSON.parse(raw) as OfflineDraft[]) : [];
    list = Array.isArray(parsed) ? parsed.filter((d) => d.userId === userId && d.orgId === orgId) : [];
  } catch {
    list = [];
  }
  cache = { k, raw, list };
  return list;
}

function write(userId: string, orgId: string, list: OfflineDraft[]) {
  try {
    localStorage.setItem(key(userId, orgId), JSON.stringify(list));
  } catch {
    throw new Error("This device has no room to keep the draft. Free some space, or note the entries down.");
  }
  listeners.forEach((l) => l());
}

export function saveDraft(d: OfflineDraft) {
  const list = read(d.userId, d.orgId).filter((x) => x.clientKey !== d.clientKey);
  write(d.userId, d.orgId, [...list, { ...d, updatedAt: new Date().toISOString() }]);
}

export function updateDraft(userId: string, orgId: string, clientKey: string, patch: Partial<OfflineDraft>) {
  write(
    userId,
    orgId,
    read(userId, orgId).map((d) => (d.clientKey === clientKey ? { ...d, ...patch, updatedAt: new Date().toISOString() } : d)),
  );
}

export function removeDraft(userId: string, orgId: string, clientKey: string) {
  write(userId, orgId, read(userId, orgId).filter((d) => d.clientKey !== clientKey));
}

/** The user's drafts, oldest first, kept in sync across tabs. */
export function useOfflineDrafts(userId: string, orgId: string) {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      const onStorage = (e: StorageEvent) => e.key === key(userId, orgId) && cb();
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(cb);
        window.removeEventListener("storage", onStorage);
      };
    },
    () => read(userId, orgId),
    () => EMPTY,
  );
}
const EMPTY: OfflineDraft[] = [];

/** Runs `fn` with a cross-tab lock where the browser supports it, so two tabs never sync the same drafts at once. */
export async function withSyncLock<T>(fn: () => Promise<T>): Promise<T | undefined> {
  const locks = (navigator as Navigator & { locks?: { request: (name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<T | undefined>) => Promise<T | undefined> } }).locks;
  if (!locks) return fn();
  return locks.request("arcadia-voice-sync", { ifAvailable: true }, async (lock) => (lock ? fn() : undefined));
}
