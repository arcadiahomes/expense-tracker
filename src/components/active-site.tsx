"use client";

import { useState } from "react";
import { Building2, Check, ChevronDown } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SelectField } from "@/components/select-field";
import { useActiveSite } from "@/lib/active-site";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

/** Desktop: the active site as a labelled select in the top bar. */
export function ActiveSiteSelect() {
  const { sites } = useSession();
  const { site, setActive, pending } = useActiveSite();
  if (!sites.length) return null;
  return (
    <div className={cn("flex items-center gap-2", pending && "opacity-60")}>
      <span id="active-site-label" className="hidden text-sm text-muted-foreground xl:inline">Active site</span>
      <SelectField
        aria-label="Active site"
        className="w-56"
        value={site?.id ?? null}
        placeholder="Pick a site"
        onChange={setActive}
        options={sites.map((s) => ({ value: s.id, label: s.name }))}
      />
    </div>
  );
}

/** Mobile: a compact chip in the header that opens a sheet of sites. */
export function ActiveSiteChip() {
  const { sites } = useSession();
  const { site, setActive, pending } = useActiveSite();
  const [open, setOpen] = useState(false);
  if (!sites.length) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`Active site: ${site?.name ?? "none"}. Change site`}
        className={cn("flex h-11 min-w-0 max-w-[11rem] items-center gap-1.5 rounded-lg border border-[var(--line)] bg-card px-2.5 text-sm font-medium", pending && "opacity-60")}
      >
        <Building2 className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="truncate">{site?.name ?? "Pick a site"}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[80dvh] overflow-y-auto rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]">
          <SheetHeader>
            <SheetTitle>Active site</SheetTitle>
            <SheetDescription>Voice entry, new expenses, labour and materials open on this site.</SheetDescription>
          </SheetHeader>
          <ul role="radiogroup" aria-label="Active site" className="grid gap-1.5 px-4">
            {sites.map((s) => {
              const on = s.id === site?.id;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => {
                      setActive(s.id);
                      setOpen(false);
                    }}
                    className={cn("flex min-h-12 w-full items-center justify-between gap-3 rounded-xl border px-3 text-left", on ? "border-primary/50 bg-accent font-semibold" : "border-[var(--line)] bg-card")}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{s.name}</span>
                      <span className="block truncate text-xs font-normal text-muted-foreground">{s.location}{s.status !== "active" && ` · ${s.status === "on-hold" ? "On hold" : "Completed"}`}</span>
                    </span>
                    {on && <Check className="size-5 shrink-0 text-primary" aria-hidden />}
                  </button>
                </li>
              );
            })}
          </ul>
        </SheetContent>
      </Sheet>
    </>
  );
}
