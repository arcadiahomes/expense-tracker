import { CATEGORY_META } from "@/lib/categories";
import type { Category } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Category icon tile; the colour only marks identity, the label carries it. */
export function CategoryIcon({ category, className }: { category: Category; className?: string }) {
  const meta = CATEGORY_META[category];
  const Icon = meta.icon;
  return (
    <span
      className={cn("grid size-10 shrink-0 place-items-center rounded-xl", className)}
      style={{
        backgroundColor: `color-mix(in oklab, ${meta.color} 14%, transparent)`,
        color: meta.color,
      }}
    >
      <Icon className="size-5" aria-hidden />
    </span>
  );
}

export function CategoryChip({ category }: { category: Category }) {
  const meta = CATEGORY_META[category];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="size-2 rounded-full" style={{ backgroundColor: meta.color }} aria-hidden />
      {meta.label}
    </span>
  );
}
