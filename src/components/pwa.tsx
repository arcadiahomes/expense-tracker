"use client";

import { useEffect } from "react";
import { WifiOff } from "lucide-react";
import { useOnline } from "@/lib/network";

/**
 * Registers the service worker in production builds only (in development it would
 * fight hot reloading). The worker caches build assets and an offline page, never data.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // Not fatal: the app works without it, it just can't show the offline page.
    });
  }, []);
  return null;
}

/** A clear, persistent notice while offline. Saving needs a connection; nothing claims otherwise. */
export function ConnectionBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div role="status" aria-live="polite" className="no-print sticky top-0 z-40 flex items-center justify-center gap-2 bg-warn px-4 py-2 text-center text-sm font-medium text-white">
      <WifiOff className="size-4 shrink-0" aria-hidden />
      You&apos;re offline. Nothing will be saved until you reconnect; voice entries can be kept on this device as unsynced drafts.
    </div>
  );
}
