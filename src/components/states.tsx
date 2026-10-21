"use client";

import type { ReactNode } from "react";
import { CloudOff, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-xl border border-dashed border-primary/25 bg-[var(--card)] px-6 py-12 text-center",
        className,
      )}
    >
      <span className="mb-3 grid size-12 place-items-center rounded-xl bg-accent text-primary">
        <Icon className="size-6" aria-hidden />
      </span>
      <p className="font-semibold">{title}</p>
      {description && (
        <p className="mt-1 max-w-[44ch] text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = "Couldn't load site data",
  description = "The sync server didn't respond. Check your connection, then try again. Entries saved on this phone are kept.",
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="flex flex-col items-center surface rounded-xl border-over/40 px-6 py-12 text-center">
      <span className="mb-3 grid size-12 place-items-center rounded-full bg-over/10 text-over">
        <CloudOff className="size-6" aria-hidden />
      </span>
      <p className="font-semibold">{title}</p>
      <p className="mt-1 max-w-[48ch] text-sm text-muted-foreground">{description}</p>
      {onRetry && (
        <Button className="mt-4 h-11 px-5" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-72" />
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    </div>
  );
}
