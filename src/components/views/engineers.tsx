"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Check, Copy, KeyRound, MapPin, UserCheck, UserPlus, UserX, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Field } from "@/components/expense-form-dialog";
import { useSubmit } from "@/components/form-bits";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/states";
import { SITE_ROLE_LABEL } from "@/lib/permissions";
import { useFormat, useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { createAccountAction, issuePasswordLinkAction, setAccountActiveAction, setAccountSitesAction } from "@/server/actions/people";
import type { AccountSummary } from "@/server/data/accounts";

type Link = { url: string; email: string; purpose: "setup" | "reset" };

/** The admin's list of assistant engineer accounts. Every change is checked again on the server. */
export function EngineersView({ accounts }: { accounts: AccountSummary[] }) {
  const [creating, setCreating] = useState(false);
  const [editingSites, setEditingSites] = useState<AccountSummary | null>(null);
  const [toggling, setToggling] = useState<AccountSummary | null>(null);
  const [link, setLink] = useState<Link | null>(null);
  const [pending, start] = useTransition();

  function issueLink(a: AccountSummary) {
    start(async () => {
      const res = await issuePasswordLinkAction(a.id);
      if (!res.ok) toast.error(res.error);
      else setLink({ url: `${window.location.origin}${res.data.path}`, email: res.data.email, purpose: res.data.purpose });
    });
  }

  return (
    <>
      <PageHeader
        title="Assistant engineers"
        description="Create accounts, choose each person's sites, and send password links. Assistant engineers add expenses to their sites for your approval."
        actions={
          <Button className="h-11 px-4" onClick={() => setCreating(true)}>
            <UserPlus aria-hidden /> Add assistant engineer
          </Button>
        }
      />
      {accounts.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No assistant engineers yet"
          description="Add someone, then send them the link to set their password."
          action={
            <Button className="h-11 px-4" onClick={() => setCreating(true)}>
              <UserPlus aria-hidden /> Add assistant engineer
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-3" aria-busy={pending}>
          {accounts.map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              busy={pending}
              onSites={() => setEditingSites(a)}
              onLink={() => issueLink(a)}
              onToggle={() => setToggling(a)}
            />
          ))}
        </ul>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
          {creating && (
            <CreateForm
              onDone={(created) => {
                setCreating(false);
                if (created) setLink(created);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={!!editingSites} onOpenChange={(o) => !o && setEditingSites(null)}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
          {editingSites && <SitesForm account={editingSites} onDone={() => setEditingSites(null)} />}
        </DialogContent>
      </Dialog>
      <Dialog open={!!link} onOpenChange={(o) => !o && setLink(null)}>
        <DialogContent className="sm:max-w-lg">{link && <LinkPanel link={link} onDone={() => setLink(null)} />}</DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!toggling}
        onOpenChange={(o) => !o && setToggling(null)}
        title={toggling?.active ? `Deactivate ${toggling.name}?` : `Reactivate ${toggling?.name ?? ""}?`}
        description={
          toggling?.active
            ? "They're signed out everywhere and can't sign in until you reactivate them. Their entries stay."
            : "They can sign in again with their password, on the sites they had."
        }
        confirmLabel={toggling?.active ? "Deactivate" : "Reactivate"}
        onConfirm={() => {
          const a = toggling;
          if (!a) return;
          start(async () => {
            const res = await setAccountActiveAction({ userId: a.id, active: !a.active });
            if (!res.ok) toast.error(res.error);
            else toast.success(a.active ? `${a.name} deactivated` : `${a.name} reactivated`);
          });
        }}
      />
    </>
  );
}

function AccountRow({
  account: a,
  busy,
  onSites,
  onLink,
  onToggle,
}: {
  account: AccountSummary;
  busy: boolean;
  onSites: () => void;
  onLink: () => void;
  onToggle: () => void;
}) {
  const format = useFormat();
  const status = !a.active
    ? { label: "Deactivated", tone: "bg-secondary text-muted-foreground" }
    : !a.hasPassword
      ? { label: "Password not set", tone: "bg-warn/15 text-warn" }
      : { label: "Active", tone: "bg-good/15 text-good" };
  return (
    <li className="surface grid gap-3 rounded-xl p-4 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className={cn("truncate font-medium", !a.active && "text-muted-foreground")}>{a.name}</p>
          <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", status.tone)}>{status.label}</span>
        </div>
        <p className="truncate text-sm text-muted-foreground">{a.email}</p>
        <p className="mt-1 text-sm">
          {a.sites.length ? a.sites.map((s) => (s.role === "assistant" ? s.name : `${s.name} (${SITE_ROLE_LABEL[s.role]})`)).join(", ") : "No sites"}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {a.lastSignInAt ? `Last signed in ${format.date(a.lastSignInAt.slice(0, 10))}` : "Never signed in"}
          {a.pendingLink && ` · ${a.pendingLink.purpose === "setup" ? "Setup" : "Reset"} link expires ${format.date(a.pendingLink.expiresAt.slice(0, 10))}`}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="h-11" onClick={onSites} disabled={busy} aria-label={`Sites for ${a.name}`}>
          <MapPin aria-hidden /> Sites
        </Button>
        {a.active && (
          <Button variant="outline" className="h-11" onClick={onLink} disabled={busy} aria-label={`Password link for ${a.name}`}>
            <KeyRound aria-hidden /> {a.hasPassword ? "Reset password" : "Setup link"}
          </Button>
        )}
        <Button variant="ghost" className={cn("h-11", a.active && "text-over")} onClick={onToggle} disabled={busy} aria-label={`${a.active ? "Deactivate" : "Reactivate"} ${a.name}`}>
          {a.active ? <UserX aria-hidden /> : <UserCheck aria-hidden />} {a.active ? "Deactivate" : "Reactivate"}
        </Button>
      </div>
    </li>
  );
}

/** Checkboxes for the organization's sites (the admin is owner of all of them). */
function SitePicker({ value, onChange, error }: { value: string[]; onChange: (ids: string[]) => void; error?: string }) {
  const { sites } = useSession();
  const toggle = (id: string, on: boolean) => onChange(on ? [...value, id] : value.filter((x) => x !== id));
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1.5 text-sm font-medium">Sites</legend>
      {sites.length === 0 ? (
        <p className="text-sm text-muted-foreground">Create a site first.</p>
      ) : (
        <div className="grid max-h-56 gap-1 overflow-y-auto rounded-xl border border-[var(--line)] p-1">
          {sites.map((s) => (
            <label key={s.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2.5 hover:bg-secondary">
              <Checkbox checked={value.includes(s.id)} onCheckedChange={(on) => toggle(s.id, on)} />
              <span className="min-w-0 flex-1 truncate text-sm">{s.name}</span>
              <span className="truncate text-xs text-muted-foreground">{s.location}</span>
            </label>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-over" role="alert">{error}</p>}
    </fieldset>
  );
}

function CreateForm({ onDone }: { onDone: (created: Link | null) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const send = useSubmit();

  function submit(e: FormEvent) {
    e.preventDefault();
    start(async () => {
      const saved = await send(() => createAccountAction({ name, email, siteIds }), setErrors);
      if (saved) {
        toast.success(`Account created for ${name.trim()}`);
        onDone({ url: `${window.location.origin}${saved.path}`, email: saved.email, purpose: saved.purpose });
      }
    });
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="font-display text-xl font-bold">Add assistant engineer</DialogTitle>
        <DialogDescription>They can add expenses to the sites you pick. You approve them before they count.</DialogDescription>
      </DialogHeader>
      <Field label="Full name" htmlFor="acc-name" error={errors.name}>
        <Input id="acc-name" autoComplete="off" className="h-11" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Email" htmlFor="acc-email" error={errors.email}>
        <Input id="acc-email" type="email" autoComplete="off" className="h-11" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <SitePicker value={siteIds} onChange={setSiteIds} error={errors.siteIds} />
      <DialogFooter>
        <Button type="button" variant="outline" className="h-11" onClick={() => onDone(null)} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" className="h-11 px-5" disabled={pending || siteIds.length === 0}>
          {pending ? "Creating…" : "Create account"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function SitesForm({ account, onDone }: { account: AccountSummary; onDone: () => void }) {
  const [siteIds, setSiteIds] = useState(account.sites.map((s) => s.id));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const send = useSubmit();

  function submit(e: FormEvent) {
    e.preventDefault();
    start(async () => {
      const saved = await send(() => setAccountSitesAction({ userId: account.id, siteIds }), setErrors);
      if (saved !== null) {
        toast.success(`Sites saved for ${account.name}`);
        onDone();
      }
    });
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="font-display text-xl font-bold">Sites for {account.name}</DialogTitle>
        <DialogDescription>Removing a site takes away their access to it straight away. Their past entries stay.</DialogDescription>
      </DialogHeader>
      <SitePicker value={siteIds} onChange={setSiteIds} error={errors.siteIds} />
      <DialogFooter>
        <Button type="button" variant="outline" className="h-11" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" className="h-11 px-5" disabled={pending}>
          {pending ? "Saving…" : "Save sites"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The one-time link, shown once. Earlier links for the same person stop working. */
function LinkPanel({ link, onDone }: { link: Link; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy. Select the link and copy it.");
    }
  }
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="font-display text-xl font-bold">{link.purpose === "setup" ? "Password setup link" : "Password reset link"}</DialogTitle>
        <DialogDescription>
          Send this privately to {link.email}. It works once and expires in 48 hours. It won&rsquo;t be shown again; any earlier link for them
          has stopped working.
        </DialogDescription>
      </DialogHeader>
      <div className="flex gap-2">
        <Input readOnly value={link.url} aria-label="Password link" className="num h-11" onFocus={(e) => e.currentTarget.select()} />
        <Button type="button" variant="outline" className="h-11 shrink-0 px-4" onClick={copy}>
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <DialogFooter>
        <Button className="h-11 px-5" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}
