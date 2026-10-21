"use client";

import { useRouter } from "next/navigation";
import { useCallback, useTransition } from "react";
import { useSession } from "./session";

/** Remembers the active site for a year. Only an id; the server checks access every time it's used. */
export function writeActiveSiteCookie(id: string) {
  document.cookie = `active_site=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
}

/** The active site and a setter that remembers it and refreshes server data for it. */
export function useActiveSite() {
  const { sites, activeSiteId } = useSession();
  const router = useRouter();
  const [pending, start] = useTransition();
  const site = sites.find((s) => s.id === activeSiteId) ?? null;
  const setActive = useCallback(
    (id: string) => {
      writeActiveSiteCookie(id);
      start(() => router.refresh());
    },
    [router],
  );
  return { site, setActive, pending };
}
