import { CircleCheckBig, CirclePause, CirclePlay } from "lucide-react";
import type { SiteStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const META = {
  active: { label: "Active", icon: CirclePlay, className: "bg-good/12 text-good" },
  "on-hold": { label: "On hold", icon: CirclePause, className: "bg-warn/12 text-warn" },
  completed: { label: "Completed", icon: CircleCheckBig, className: "bg-muted text-muted-foreground" },
} as const;

export function SiteStatusBadge({ status }: { status: SiteStatus }) {
  const m = META[status];
  const Icon = m.icon;
  return (
    <span className={cn("inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs font-medium", m.className)}>
      <Icon className="size-3.5" aria-hidden />
      {m.label}
    </span>
  );
}
