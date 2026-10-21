"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { formatDate, formatMoney } from "./format";
import { can } from "./permissions";
import type { OrgRole, Settings, SiteRole, SiteStatus } from "./types";

/**
 * What every screen needs about the signed-in user, loaded on the server by
 * src/app/(app)/layout.tsx and refreshed after each mutation. Records themselves
 * (expenses, bills, totals) are fetched per page, never kept here.
 */
export type SessionData = {
  user: { id: string; name: string; email: string };
  org: { id: string; name: string; role: OrgRole };
  settings: Settings;
  /** Business date (IST) from the server, so client and server agree. */
  today: string;
  sites: { id: string; name: string; location: string; status: SiteStatus; role: SiteRole }[];
  members: { id: string; name: string }[];
  workers: string[];
  suppliers: string[];
  overdueBills: number;
  /** False for someone who is only an assistant engineer: no totals, budgets, reports or other people's entries. */
  readsRecords: boolean;
  /** Expenses waiting for this user's approval (site owners and org admins). */
  pendingApprovals: number;
  unreadNotices: number;
  /** The site the user is working on: last picked (cookie) if still visible, else their first writable site. */
  activeSiteId: string | null;
  /** Server features that are switched on for this deployment. */
  features: { receiptOcr: boolean };
};

const SessionContext = createContext<SessionData | null>(null);

export function SessionProvider({ value, children }: { value: SessionData; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}

export function useCanManageOrg() {
  const { org } = useSession();
  return org.role === "owner" || org.role === "admin";
}

/** The active site, if it's one the user can add expenses to; else their first such site. */
export function useDefaultWritableSiteId() {
  const { activeSiteId } = useSession();
  const writable = useWritableSites();
  return writable.find((s) => s.id === activeSiteId)?.id ?? writable[0]?.id ?? "";
}

/** Sites where the user can add expenses (not completed). */
export function useWritableSites() {
  const { sites } = useSession();
  return useMemo(() => sites.filter((s) => can(s.role, "expense:create") && s.status !== "completed"), [sites]);
}

/** Sites where the user approves assistant engineers' expenses. */
export function useApprovalSites() {
  const { sites } = useSession();
  return useMemo(() => sites.filter((s) => can(s.role, "expense:approve")), [sites]);
}

/** Whether the user has any site where their own entries need approval (assistant engineers). */
export function useSubmitsForApproval() {
  const { sites } = useSession();
  return useMemo(() => sites.some((s) => can(s.role, "expense:create") && !can(s.role, "expense:direct")), [sites]);
}

/** Sites whose people the user manages. */
export function useManagedSites() {
  const { sites } = useSession();
  return useMemo(() => sites.filter((s) => can(s.role, "site:manage")), [sites]);
}

/** Money and date formatters that follow the user's settings. */
export function useFormat() {
  const { settings } = useSession();
  return useMemo(
    () => ({
      money: (n: number) => formatMoney(n, settings.numberStyle),
      date: (iso: string) => formatDate(iso, settings.dateFormat),
    }),
    [settings.numberStyle, settings.dateFormat],
  );
}
