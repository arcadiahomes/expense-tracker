"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";

const subscribe = (cb: () => void) => {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
};

/** navigator.onLine, kept current. It can say "online" on a dead connection, so requests still handle failure. */
export function useOnline() {
  return useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
}

/** While `pending`, shows a "still working" notice after a few seconds, so a slow network doesn't look like a hang. */
export function useSlowNotice(pending: boolean, message = "Still working. The connection is slow; keep this screen open.") {
  useEffect(() => {
    if (!pending) return;
    let id: string | number | undefined;
    const t = setTimeout(() => (id = toast.loading(message)), 4000);
    return () => {
      clearTimeout(t);
      if (id !== undefined) toast.dismiss(id);
    };
  }, [pending, message]);
}

/**
 * Ignores a second call while the first is still running, so a double tap on a slow
 * network can't send the same request twice. (Buttons are disabled too, but a fast
 * second tap can land before React re-renders.)
 */
export function useSubmitGuard() {
  const busy = useRef(false);
  return useCallback(<T,>(fn: () => Promise<T>) => {
    if (busy.current) return Promise.resolve(undefined);
    busy.current = true;
    return fn().finally(() => {
      busy.current = false;
    });
  }, []);
}
