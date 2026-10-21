"use client";

import Link from "next/link";
import { useState } from "react";
import { Building2, MapPin, MoreVertical, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/states";
import { TapeMeter } from "@/components/tape-meter";
import { SiteFormDialog } from "@/components/site-form-dialog";
import { SiteStatusBadge } from "@/components/site-status";
import { ConfirmDialog } from "@/components/confirm-dialog";
import type { SiteSummary } from "@/lib/analytics";
import { can } from "@/lib/permissions";
import { useCanManageOrg, useFormat } from "@/lib/session";
import { deleteSiteAction } from "@/server/actions/sites";
import type { Site, SiteStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

type Filter = "all" | SiteStatus;

export function SitesView({ summaries }: { summaries: SiteSummary[] }) {
  const [creating, setCreating] = useState(false);
  const canCreate = useCanManageOrg();
  return (
    <>
      <PageHeader
        title="Sites"
        description="Budgets, spending and balance for every site you run."
        actions={
          canCreate && (
            <Button className="h-11 px-4" onClick={() => setCreating(true)}>
              <Plus aria-hidden /> New site
            </Button>
          )
        }
      />
      <SitesBody summaries={summaries} onCreate={canCreate ? () => setCreating(true) : undefined} />
      <SiteFormDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

function SitesBody({ summaries, onCreate }: { summaries: SiteSummary[]; onCreate?: () => void }) {
  const sites = summaries.map((s) => s.site);
  const canDelete = useCanManageOrg();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Site | undefined>();
  const [deleting, setDeleting] = useState<Site | undefined>();

  const q = query.trim().toLowerCase();
  const visible = summaries.filter(
    (s) =>
      (filter === "all" || s.site.status === filter) &&
      (!q || `${s.site.name} ${s.site.location} ${s.site.client}`.toLowerCase().includes(q)),
  );
  const count = (f: Filter) => (f === "all" ? sites.length : sites.filter((s) => s.status === f).length);

  if (sites.length === 0) {
    return (
      <EmptyState
        icon={Building2}
        title="No sites yet"
        description={
          onCreate
            ? "Add your first site with its approved budget. Expenses are tracked against it from day one."
            : "You haven't been added to any site yet. Ask your organization owner to add you."
        }
        action={onCreate && <Button className="h-11 px-5" onClick={onCreate}><Plus aria-hidden /> New site</Button>}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList className="h-11!">
            {(["all", "active", "on-hold", "completed"] as Filter[]).map((f) => (
              <TabsTrigger key={f} value={f} className="px-3">
                {f === "all" ? "All" : f === "on-hold" ? "On hold" : f[0].toUpperCase() + f.slice(1)}
                <span className="num ml-1 text-muted-foreground">{count(f)}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="relative sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            aria-label="Search sites"
            placeholder="Search by name, area or client"
            className="h-11 pl-9"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No sites match"
          description="Try a different name or switch the status filter to All."
          action={<Button variant="outline" className="h-11" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</Button>}
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((s) => (
            <li key={s.site.id}>
              <SiteCard
                summary={s}
                onEdit={can(s.site.role, "site:manage") ? () => setEditing(s.site) : undefined}
                onDelete={canDelete ? () => setDeleting(s.site) : undefined}
              />
            </li>
          ))}
        </ul>
      )}

      <SiteFormDialog open={!!editing} onOpenChange={(o) => !o && setEditing(undefined)} site={editing} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={`Delete ${deleting?.name ?? "site"}?`}
        description="This removes the site along with all its expenses and bills. It can't be undone."
        confirmLabel="Delete site"
        onConfirm={async () => {
          if (!deleting) return;
          const res = await deleteSiteAction(deleting.id);
          if (res.ok) toast.success("Site deleted", { description: deleting.name });
          else toast.error(res.error);
        }}
      />
    </div>
  );
}

export function SiteCard({
  summary,
  onEdit,
  onDelete,
}: {
  summary: SiteSummary;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const fmt = useFormat();
  const { site, spent, balance, utilisation, monthSpend, lastEntry } = summary;
  return (
    <article className="surface lift relative flex h-full flex-col rounded-xl p-4 focus-within:border-primary/50 sm:p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <SiteStatusBadge status={site.status} />
          <h2 className="mt-2 text-lg leading-snug font-semibold">
            <Link href={`/sites/${site.id}`} className="after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none">
              {site.name}
            </Link>
          </h2>
          <p className="mt-0.5 flex items-center gap-1 truncate text-sm text-muted-foreground">
            <MapPin className="size-3.5 shrink-0" aria-hidden />
            {site.location}
          </p>
        </div>
        {(onEdit || onDelete) && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon" className="relative z-10 -mt-1 -mr-2 size-10 text-muted-foreground" aria-label={`Actions for ${site.name}`} />}
          >
            <MoreVertical />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            {onEdit && <DropdownMenuItem className="h-10" onClick={onEdit}><Pencil /> Edit site</DropdownMenuItem>}
            {onDelete && <DropdownMenuItem className="h-10" variant="destructive" onClick={onDelete}><Trash2 /> Delete</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
        )}
      </div>

      <dl className="mt-5 grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Budget</dt>
          <dd className="num mt-0.5 font-semibold">{fmt.money(site.budget)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Spent</dt>
          <dd className="num mt-0.5 font-semibold">{fmt.money(spent)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Balance</dt>
          <dd className={cn("num mt-0.5 font-semibold", balance < 0 && "text-over")}>{fmt.money(balance)}</dd>
        </div>
      </dl>

      <TapeMeter utilisation={utilisation} alertAt={summary.alertAt} label={`Budget used, ${site.name}`} className="mt-4" />

      <p className="mt-auto pt-4 text-xs text-muted-foreground">
        {site.status === "active"
          ? `${fmt.money(monthSpend)} this month`
          : lastEntry
            ? `Last entry ${fmt.date(lastEntry)}`
            : "No entries yet"}
      </p>
    </article>
  );
}
