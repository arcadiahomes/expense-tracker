"use client";

import { useState, useSyncExternalStore, useTransition, type FormEvent, type ReactNode } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/theme";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/page-header";
import { Field } from "@/components/expense-form-dialog";
import { formatDate, formatMoney } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { DateFormat, Language, NumberStyle, Settings } from "@/lib/types";
import { signOutAction } from "@/server/actions/auth";
import { updatePreferencesAction } from "@/server/actions/preferences";
import { selectOrganizationAction } from "@/server/actions/people";
import { cn } from "@/lib/utils";

const LANGUAGES: { value: Language; native: string; english: string }[] = [
  { value: "en", native: "English", english: "English (India)" },
  { value: "hi", native: "हिन्दी", english: "Hindi" },
  { value: "ml", native: "മലയാളം", english: "Malayalam" },
  { value: "ta", native: "தமிழ்", english: "Tamil" },
  { value: "kn", native: "ಕನ್ನಡ", english: "Kannada" },
];

const DATE_FORMATS: DateFormat[] = ["d MMM yyyy", "dd/MM/yyyy", "yyyy-MM-dd"];

const THEMES = [
  { value: "light", label: "Light", icon: Sun, hint: "Best in bright sun" },
  { value: "dark", label: "Dark", icon: Moon, hint: "Easier at night" },
  { value: "system", label: "System", icon: Monitor, hint: "Follow the phone" },
] as const;

const useMounted = () =>
  useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

const ROLE_LABEL = { owner: "Owner", admin: "Admin", member: "Member" } as const;

type Workspace = { id: string; name: string; role: keyof typeof ROLE_LABEL; active: boolean };

export function SettingsView({ organizations }: { organizations: Workspace[] }) {
  const { settings, today, org } = useSession();
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const [profile, setProfile] = useState({ name: settings.name, phone: settings.phone, role: settings.role });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, startSaving] = useTransition();
  const [signingOut, startSignOut] = useTransition();

  const dirty = profile.name !== settings.name || profile.phone !== settings.phone || profile.role !== settings.role;

  /** Saves to the user's record; the server refresh updates every screen's formatting. */
  function savePrefs(patch: Partial<Settings> & { jobTitle?: string }, message?: string) {
    startSaving(async () => {
      const res = await updatePreferencesAction(patch);
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      setErrors({});
      if (message) toast.success(message);
    });
  }

  function saveProfile(e: FormEvent) {
    e.preventDefault();
    savePrefs({ name: profile.name, phone: profile.phone, jobTitle: profile.role }, "Profile saved");
  }

  const set = (k: keyof typeof profile, v: string) => setProfile((p) => ({ ...p, [k]: v }));

  return (
    <>
      <PageHeader title="Settings" description="Your profile and how Arcadia Home shows money, dates and colours." />

      <div className="grid max-w-3xl gap-4 lg:gap-5">
        <Section title="Profile" description="Shown on entries you make and on exported reports.">
          <form onSubmit={saveProfile} noValidate className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Full name" htmlFor="p-name" error={errors.name}>
                <Input id="p-name" autoComplete="name" className="h-11" value={profile.name} onChange={(e) => set("name", e.target.value)} />
              </Field>
              <Field label="Mobile" htmlFor="p-phone" error={errors.phone} optional>
                <Input id="p-phone" type="tel" autoComplete="tel" className="h-11" value={profile.phone} onChange={(e) => set("phone", e.target.value)} />
              </Field>
              <Field label="Email" htmlFor="p-email">
                <Input id="p-email" type="email" className="h-11" value={settings.email} disabled />
              </Field>
              <Field label="Job title" htmlFor="p-role" error={errors.jobTitle} optional>
                <Input id="p-role" className="h-11" value={profile.role} onChange={(e) => set("role", e.target.value)} />
              </Field>
              <Field label="Company" htmlFor="p-company">
                <Input id="p-company" className="h-11" value={`${settings.company} (${ROLE_LABEL[org.role]})`} disabled />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              {dirty && (
                <Button type="button" variant="ghost" className="h-11" onClick={() => setProfile({ name: settings.name, phone: settings.phone, role: settings.role })}>
                  Discard
                </Button>
              )}
              <Button type="submit" className="h-11 px-5" disabled={!dirty || saving}>{saving ? "Saving…" : "Save profile"}</Button>
            </div>
          </form>
        </Section>

        <Section title="Language" description="Used for voice entry now. Screen translations are coming next.">
          <ChoiceGrid name="language" cols="sm:grid-cols-3">
            {LANGUAGES.map((l) => (
              <Choice
                key={l.value}
                name="language"
                checked={settings.language === l.value}
                onSelect={() => savePrefs({ language: l.value }, `Voice entry set to ${l.english}`)}
                title={l.native}
                hint={l.english}
                lang={l.value}
              />
            ))}
          </ChoiceGrid>
        </Section>

        <Section title="Currency" description="All amounts are in Indian rupees with lakh and crore grouping.">
          <div className="mb-4 flex items-center justify-between rounded-xl bg-secondary/70 px-3.5 py-3 text-sm">
            <span>Currency</span>
            <span className="font-semibold">₹ Indian rupee (INR)</span>
          </div>
          <ChoiceGrid name="number-style" cols="sm:grid-cols-2">
            {(["full", "compact"] as NumberStyle[]).map((s) => (
              <Choice
                key={s}
                name="number-style"
                checked={settings.numberStyle === s}
                onSelect={() => savePrefs({ numberStyle: s })}
                title={s === "full" ? "Full amount" : "Short (lakh, crore)"}
                hint={<span className="num">{formatMoney(1_84_52_300, s)}</span>}
              />
            ))}
          </ChoiceGrid>
        </Section>

        <Section title="Date format">
          <ChoiceGrid name="date-format" cols="sm:grid-cols-3">
            {DATE_FORMATS.map((f) => (
              <Choice
                key={f}
                name="date-format"
                checked={settings.dateFormat === f}
                onSelect={() => savePrefs({ dateFormat: f })}
                title={<span className="num">{formatDate(today, f)}</span>}
                hint={f === "d MMM yyyy" ? "Easy to read" : f === "dd/MM/yyyy" ? "Common in India" : "Sorts in Excel"}
              />
            ))}
          </ChoiceGrid>
        </Section>

        <Section title="Theme">
          <ChoiceGrid name="theme" cols="grid-cols-3">
            {THEMES.map((t) => {
              const Icon = t.icon;
              return (
                <Choice
                  key={t.value}
                  name="theme"
                  checked={mounted && theme === t.value}
                  onSelect={() => setTheme(t.value)}
                  title={<span className="inline-flex items-center gap-2"><Icon className="size-4" aria-hidden />{t.label}</span>}
                  hint={t.hint}
                />
              );
            })}
          </ChoiceGrid>
        </Section>

        {organizations.length > 1 && <WorkspaceSection organizations={organizations} />}

        <Section title="Account" description={`Signed in as ${settings.email}.`}>
          <Button variant="outline" className="h-11" disabled={signingOut} onClick={() => startSignOut(() => signOutAction())}>
            {signingOut ? "Signing out…" : "Sign out"}
          </Button>
        </Section>
      </div>

    </>
  );
}

function WorkspaceSection({ organizations }: { organizations: Workspace[] }) {
  const [pending, start] = useTransition();
  return (
    <Section title="Workspace" description="You belong to more than one company. Pick the one to work in.">
      <ChoiceGrid name="workspace" cols="sm:grid-cols-2">
        {organizations.map((o) => (
          <Choice
            key={o.id}
            name="workspace"
            checked={o.active}
            onSelect={() =>
              start(async () => {
                const res = await selectOrganizationAction(o.id);
                if (!res.ok) toast.error(res.error);
                else toast.success(`Switched to ${o.name}`);
              })
            }
            title={o.name}
            hint={pending ? "Switching…" : ROLE_LABEL[o.role]}
          />
        ))}
      </ChoiceGrid>
    </Section>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 surface rounded-xl p-4 sm:p-5 md:grid-cols-[200px_1fr] md:gap-8">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function ChoiceGrid({ name, cols, children }: { name: string; cols: string; children: ReactNode }) {
  return (
    <div role="radiogroup" aria-label={name.replace("-", " ")} className={cn("grid gap-2", cols)}>
      {children}
    </div>
  );
}

function Choice({
  name,
  checked,
  onSelect,
  title,
  hint,
  lang,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  title: ReactNode;
  hint?: ReactNode;
  lang?: string;
}) {
  return (
    <label
      className={cn(
        "relative flex min-h-14 cursor-pointer flex-col justify-center rounded-xl border px-3.5 py-2.5 transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring",
        checked ? "border-primary bg-accent text-accent-foreground ring-1 ring-primary" : "border-[var(--line)] bg-card hover:border-primary/40 hover:bg-secondary",
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onSelect} className="sr-only" />
      <span className="text-sm font-medium" lang={lang}>{title}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}
