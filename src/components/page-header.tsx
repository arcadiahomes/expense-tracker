import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between lg:mb-8">
      <div className="min-w-0">
        {back}
        <h1 className="font-display text-[1.75rem] leading-[1.1] font-bold text-balance sm:text-[2.125rem]">
          {title}
        </h1>
        {description && (
          <p className="mt-1.5 max-w-[60ch] text-[0.9375rem] text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="no-print flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </header>
  );
}
