"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/states";
import { PageHeader } from "@/components/page-header";
import { SelectField } from "@/components/select-field";
import { can } from "@/lib/permissions";
import { useSession } from "@/lib/session";
import { loadAuditAction } from "@/server/actions/audit";
import type { AuditRow } from "@/server/data/audit";

const ALL = "all";

export function ActivityView({ siteId, page }: { siteId: string | null; page: { items: AuditRow[]; nextCursor: string | null } }) {
  const { sites, settings } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [items, setItems] = useState(page.items);
  const [cursor, setCursor] = useState(page.nextCursor);
  const [loading, start] = useTransition();
  const auditable = sites.filter((s) => can(s.role, "audit:read"));
  const siteName = (id: string | null) => (id ? (sites.find((s) => s.id === id)?.name ?? "Site") : "Organization");
  const when = (iso: string) =>
    new Intl.DateTimeFormat("en-IN", { dateStyle: settings.dateFormat === "yyyy-MM-dd" ? "short" : "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(iso));

  function more() {
    start(async () => {
      try {
        const res = await loadAuditAction({ siteId: siteId ?? undefined, cursor: cursor ?? undefined });
        if (!res.ok) return void toast.error(res.error);
        setItems((list) => [...list, ...res.data.items]);
        setCursor(res.data.nextCursor);
      } catch {
        toast.error("Couldn't load more. Check your connection.");
      }
    });
  }

  return (
    <>
      <PageHeader title="Activity" description="Every change to money, stock, attendance and records: who did it, and when. Entries can't be edited or removed." />
      <div className="mb-4 sm:w-72">
        <SelectField
          aria-label="Site"
          value={siteId ?? ALL}
          onChange={(v) => router.push(v === ALL ? pathname : `${pathname}?site=${v}`)}
          options={[{ value: ALL, label: "All sites" }, ...auditable.map((s) => ({ value: s.id, label: s.name }))]}
        />
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
      ) : (
        <ol className="surface divide-y rounded-xl">
          {items.map((a) => (
            <li key={a.id} className="px-4 py-3">
              <p className="text-sm">{a.summary}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {a.actorName} · {siteName(a.siteId)} · <time dateTime={a.createdAt}>{when(a.createdAt)}</time>
              </p>
            </li>
          ))}
        </ol>
      )}
      {cursor && (
        <Button variant="outline" className="mt-4 h-11 w-full sm:w-auto" onClick={more} disabled={loading}>
          {loading ? "Loading…" : "Show more"}
        </Button>
      )}
    </>
  );
}

export function ActivityUnavailable() {
  return <EmptyState icon={History} title="No activity to show" description="The activity log is for site owners and accountants." />;
}
