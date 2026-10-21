import { AlertTriangle, CircleCheck, OctagonAlert } from "lucide-react";
import { budgetState } from "@/lib/analytics";
import { cn } from "@/lib/utils";

const STATE = {
  ok: { label: "On budget", fill: "brand-fill", text: "text-muted-foreground", icon: CircleCheck },
  tight: { label: "Nearing budget", fill: "bg-warn", text: "text-warn", icon: AlertTriangle },
  over: { label: "Over budget", fill: "bg-over", text: "text-over", icon: OctagonAlert },
} as const;

/**
 * Budget utilisation drawn like a measuring tape: ticks every 10%,
 * fill colour plus a text label for the state.
 */
export function TapeMeter({
  utilisation,
  alertAt,
  label = "Budget used",
  size = "md",
  showLabel = true,
  className,
}: {
  utilisation: number;
  /** The budget's alert threshold (0..1); defaults to 80%. */
  alertAt?: number;
  /** Accessible name of the meter, e.g. "Budget used, Site One". */
  label?: string;
  size?: "sm" | "md" | "lg";
  showLabel?: boolean;
  className?: string;
}) {
  const state = budgetState(utilisation, alertAt);
  const meta = STATE[state];
  const Icon = meta.icon;
  const pct = Math.round(utilisation * 100);
  return (
    <div className={cn("w-full", className)}>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(pct, 100)}
        aria-valuetext={`${pct}% of budget used, ${meta.label.toLowerCase()}`}
        className={cn(
          "tape relative overflow-hidden rounded-full",
          size === "sm" ? "h-2" : size === "lg" ? "h-5" : "h-3",
        )}
      >
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-500", meta.fill)}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      {showLabel && (
        <div className={cn("mt-1.5 flex items-center justify-between gap-2 text-xs", meta.text)}>
          <span className="inline-flex items-center gap-1">
            <Icon className="size-3.5" aria-hidden />
            {meta.label}
          </span>
          <span className="num font-semibold text-foreground">{pct}% used</span>
        </div>
      )}
    </div>
  );
}
