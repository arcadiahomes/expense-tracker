"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { UserPlus, UserMinus } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Panel } from "@/components/panel";
import { SelectField } from "@/components/select-field";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SITE_ROLES, SITE_ROLE_LABEL, type SiteRole } from "@/lib/permissions";
import { useCanManageOrg, useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { removeSiteMemberAction, setSiteMemberRoleAction } from "@/server/actions/people";

export type SiteMember = { id: string; name: string; email: string; role: SiteRole };

/** Who is on a site and with which role. Rendered only for site owners; the server checks every change. */
export function SitePeople({ siteId, siteName, members }: { siteId: string; siteName: string; members: SiteMember[] }) {
  const { user, org } = useSession();
  const orgAdmin = useCanManageOrg();
  const [removing, setRemoving] = useState<SiteMember | null>(null);
  const [pending, start] = useTransition();

  // Mirrors assertMayChange on the server: site owners can't touch owners or themselves.
  const locked = (m: SiteMember) => !orgAdmin && (m.role === "owner" || m.id === user.id);
  const roleOptions = SITE_ROLES.filter((r) => r !== "owner" || orgAdmin).map((r) => ({ value: r, label: SITE_ROLE_LABEL[r] }));

  function changeRole(m: SiteMember, role: SiteRole) {
    start(async () => {
      const res = await setSiteMemberRoleAction({ siteId, userId: m.id, role });
      if (!res.ok) toast.error(res.error);
      else toast.success(`${m.name} is now ${SITE_ROLE_LABEL[role].toLowerCase()}`);
    });
  }

  return (
    <Panel
      title="People"
      description={orgAdmin ? "Organization owners and admins can manage every site." : "Owners manage who works on this site."}
      action={
        // New people get accounts from the admin, on the Assistant engineers page.
        org.role === "owner" && (
          <Link href="/engineers" className={cn(buttonVariants({ variant: "outline" }), "h-11 px-4")}>
            <UserPlus aria-hidden /> Add people
          </Link>
        )
      }
    >
      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">No one has been added to this site yet.</p>
      ) : (
        <ul className="grid gap-1" aria-busy={pending}>
          {members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 rounded-lg py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{m.name}{m.id === user.id && <span className="text-muted-foreground"> (you)</span>}</p>
                <p className="truncate text-xs text-muted-foreground">{m.email}</p>
              </div>
              {locked(m) ? (
                <span className="text-sm text-muted-foreground">{SITE_ROLE_LABEL[m.role]}</span>
              ) : (
                <>
                  <SelectField
                    aria-label={`Role for ${m.name}`}
                    className="w-36"
                    value={m.role}
                    onChange={(r) => changeRole(m, r)}
                    options={roleOptions.some((o) => o.value === m.role) ? roleOptions : [{ value: m.role, label: SITE_ROLE_LABEL[m.role] }, ...roleOptions]}
                  />
                  <Button variant="ghost" size="icon" className="size-11 text-over" aria-label={`Remove ${m.name}`} onClick={() => setRemoving(m)}>
                    <UserMinus aria-hidden />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name ?? ""}?`}
        description={`They lose access to ${siteName} straight away. Their past entries stay.`}
        confirmLabel="Remove"
        onConfirm={() => {
          const m = removing;
          if (!m) return;
          start(async () => {
            const res = await removeSiteMemberAction(siteId, m.id);
            if (!res.ok) toast.error(res.error);
            else toast.success(`${m.name} removed from ${siteName}`);
          });
        }}
      />
    </Panel>
  );
}
