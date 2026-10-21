"use client";

import { useRouter } from "next/navigation";
import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { Building2, Search } from "lucide-react";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

/** Jump straight to a site by name, area or client. */
export function SiteSearch({ className }: { className?: string }) {
  const { sites } = useSession();
  const router = useRouter();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const q = query.trim().toLowerCase();
  const results = useMemo(
    () =>
      q
        ? sites
            .filter((s) => `${s.name} ${s.location}`.toLowerCase().includes(q))
            .slice(0, 6)
        : [],
    [sites, q],
  );

  function go(id: string) {
    setQuery("");
    setOpen(false);
    router.push(`/sites/${id}`);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[active]) {
      go(results[active].id);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const showList = open && q.length > 0;

  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <input
        type="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && results[active] ? `${listId}-${results[active].id}` : undefined}
        aria-label="Find a site"
        placeholder="Find a site by name or area"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
        className="h-11 w-full rounded-xl border border-[var(--line)] bg-card pr-3 pl-10 text-sm outline-none transition-colors placeholder:text-muted-foreground hover:border-primary/40 focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-ring/20"
      />
      {showList && (
        <ul id={listId} role="listbox" className="surface-raised absolute inset-x-0 top-full z-50 mt-2 overflow-hidden rounded-xl p-1">
          {results.length === 0 ? (
            <li className="px-3 py-3 text-sm text-muted-foreground">No site matches “{query.trim()}”.</li>
          ) : (
            results.map((s, i) => (
              <li
                key={s.id}
                id={`${listId}-${s.id}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(s.id)}
                className={cn("flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5", i === active && "bg-accent text-accent-foreground")}
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary text-primary">
                  <Building2 className="size-4" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{s.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{s.location}</span>
                </span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
