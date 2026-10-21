"use client";

import { useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/expense-form-dialog";
import { useSubmit } from "@/components/form-bits";
import { SelectField } from "@/components/select-field";
import { formatINR } from "@/lib/format";
import { useCanManageOrg, useSession } from "@/lib/session";
import { createSiteAction, updateSiteAction } from "@/server/actions/sites";
import type { Site, SiteStatus } from "@/lib/types";

export const STATUS_OPTIONS: { value: SiteStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "on-hold", label: "On hold" },
  { value: "completed", label: "Completed" },
];

export function SiteFormDialog({
  open,
  onOpenChange,
  site,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  site?: Site;
  onSaved?: (site: Site) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        {open && (
          <SiteForm
            site={site}
            onDone={(saved) => {
              onOpenChange(false);
              if (saved) onSaved?.(saved);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

const NO_ENGINEER = "__none__";

function SiteForm({ site, onDone }: { site?: Site; onDone: (saved?: Site) => void }) {
  const { today, members } = useSession();
  const canAssign = useCanManageOrg() && members.length > 0;
  const [name, setName] = useState(site?.name ?? "");
  const [location, setLocation] = useState(site?.location ?? "");
  const [client, setClient] = useState(site?.client ?? "");
  const [engineerId, setEngineerId] = useState(site?.engineerUserId ?? NO_ENGINEER);
  const [budget, setBudget] = useState(site ? String(site.budget) : "");
  const [startDate, setStartDate] = useState(site?.startDate ?? today);
  const [status, setStatus] = useState<SiteStatus>(site?.status ?? "active");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const send = useSubmit();

  const budgetNum = Number(budget);

  function submit(e: FormEvent) {
    e.preventDefault();
    const payload = {
      ...(site ? { id: site.id } : {}),
      name,
      location,
      clientName: client,
      budget: budget || "0",
      startDate,
      status: status === "on-hold" ? "on_hold" : status,
      engineerUserId: engineerId === NO_ENGINEER ? undefined : engineerId,
    };
    start(async () => {
      const saved = await send(() => (site ? updateSiteAction(payload) : createSiteAction(payload)), setErrors);
      if (!saved) return;
      toast.success(site ? "Site updated" : "Site created", { description: saved.site.name });
      onDone(saved.site);
    });
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="font-display text-xl font-bold">{site ? "Edit site" : "New site"}</DialogTitle>
        <DialogDescription>Budget and details are visible to everyone on this site.</DialogDescription>
      </DialogHeader>
      <Field label="Site name" htmlFor="site-name" error={errors.name}>
        <Input id="site-name" className="h-11" placeholder="e.g. Edappally Apartments" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Location" htmlFor="site-loc" error={errors.location}>
        <Input id="site-loc" className="h-11" placeholder="Area, city" value={location} onChange={(e) => setLocation(e.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Client" htmlFor="site-client" optional>
          <Input id="site-client" className="h-11" value={client} onChange={(e) => setClient(e.target.value)} />
        </Field>
        {canAssign ? (
          <Field label="Site engineer" htmlFor="site-eng" optional error={errors.engineerUserId}>
            <SelectField
              id="site-eng"
              value={engineerId}
              onChange={setEngineerId}
              options={[{ value: NO_ENGINEER, label: "Not assigned" }, ...members.map((m) => ({ value: m.id, label: m.name }))]}
            />
          </Field>
        ) : (
          <Field label="Site engineer" htmlFor="site-eng">
            <Input id="site-eng" className="h-11" value={site?.engineer || "Not assigned"} disabled />
          </Field>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Budget (₹)" htmlFor="site-budget" error={errors.budget}>
          <Input id="site-budget" inputMode="numeric" className="num h-11" placeholder="e.g. 4500000" value={budget} onChange={(e) => setBudget(e.target.value.replace(/\D/g, ""))} />
          {budgetNum > 0 && (
            <span className="num text-xs text-muted-foreground">
              {formatINR(budgetNum)}
            </span>
          )}
        </Field>
        <Field label="Start date" htmlFor="site-start" error={errors.startDate}>
          <Input id="site-start" type="date" className="h-11" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </Field>
      </div>
      <Field label="Status" htmlFor="site-status">
        <SelectField id="site-status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" className="h-11" onClick={() => onDone()} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" className="h-11 px-5" disabled={pending}>
          {pending ? "Saving…" : site ? "Save changes" : "Create site"}
        </Button>
      </DialogFooter>
    </form>
  );
}
