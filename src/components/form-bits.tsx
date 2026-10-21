"use client";

import { useCallback, useRef, type ReactNode } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import type { ActionResult } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Label, control and inline error, the way every form in the app lays them out. */
export function Field({ id, label, error, hint, children, className }: { id: string; label: ReactNode; error?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={id} className="text-sm font-medium">
        {label}
      </Label>
      {children}
      {error ? (
        <p className="text-xs font-medium text-over" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function Stat({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: "good" | "warn" | "over"; hint?: ReactNode }) {
  return (
    <div className="surface rounded-xl p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn("num font-display mt-1 text-xl font-bold sm:text-2xl", tone === "good" && "text-good", tone === "warn" && "text-warn", tone === "over" && "text-over")}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * Runs a server action from a form: shows its error as a toast and returns field
 * errors for inline display. A thrown action means the request never arrived.
 */
export async function submit<T>(
  call: () => Promise<ActionResult<T>>,
  onErrors: (errors: Record<string, string>) => void,
): Promise<T | null> {
  // A slow network gets a "still working" notice instead of looking frozen.
  let slow: string | number | undefined;
  const timer = setTimeout(() => (slow = toast.loading("Still saving. The connection is slow; keep this screen open.")), 4000);
  try {
    const res = await call();
    if (!res.ok) {
      onErrors(res.fieldErrors ?? {});
      toast.error(res.error);
      return null;
    }
    onErrors({});
    return res.data;
  } catch {
    toast.error("Couldn't reach the server, so we can't confirm this was saved. Check the list before trying again.");
    return null;
  } finally {
    clearTimeout(timer);
    if (slow !== undefined) toast.dismiss(slow);
  }
}

/**
 * `submit` with a double-tap guard for one form: a second call while the first is
 * still running is ignored (returns null), because a fast tap or Enter can land
 * before the disabled button re-renders and purchases and payments aren't idempotent.
 */
export function useSubmit() {
  const busy = useRef(false);
  return useCallback(async <T,>(call: () => Promise<ActionResult<T>>, onErrors: (errors: Record<string, string>) => void): Promise<T | null> => {
    if (busy.current) return null;
    busy.current = true;
    try {
      return await submit(call, onErrors);
    } finally {
      busy.current = false;
    }
  }, []);
}

export const qty =(q: string) => (q.includes(".") ? q.replace(/\.?0+$/, "") : q) || "0";
