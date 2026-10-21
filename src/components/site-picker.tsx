"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { SelectField } from "@/components/select-field";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { writeActiveSiteCookie } from "@/lib/active-site";

/** Switches the page's `?site=` (server results depend on it), keeping other params except those listed in `reset`. */
export function SitePicker({ siteId, reset = [], className }: { siteId: string; reset?: string[]; className?: string }) {
  const { sites } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  return (
    <div className={cn("min-w-0 sm:w-72", pending && "opacity-60", className)}>
      <SelectField
        aria-label="Site"
        value={siteId}
        options={sites.map((s) => ({ value: s.id, label: s.name }))}
        onChange={(id) =>
          start(() => {
            const next = new URLSearchParams(params);
            next.set("site", id);
            // Picking a site on a page also makes it the active site everywhere else.
            writeActiveSiteCookie(id);
            for (const k of reset) next.delete(k);
            router.push(`${pathname}?${next}`);
          })
        }
      />
    </div>
  );
}
