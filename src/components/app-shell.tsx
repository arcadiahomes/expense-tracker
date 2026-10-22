"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  Bell,
  Boxes,
  Building2,
  ClipboardCheck,
  ClipboardList,
  FileText,
  HardHat,
  History,
  LayoutGrid,
  Menu,
  Mic,
  Moon,
  ReceiptIndianRupee,
  ReceiptText,
  Settings,
  Store,
  Sun,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { can } from "@/lib/permissions";
import { useTheme } from "@/lib/theme";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDate } from "@/lib/format";
import { useApprovalSites, useSession, useSubmitsForApproval, useWritableSites } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Logo } from "./logo";
import { SiteSearch } from "./site-search";
import { ActiveSiteChip, ActiveSiteSelect } from "./active-site";
import { ConnectionBanner } from "./pwa";

type NavItem = { href: string; label: string; icon: LucideIcon };

const NAV_GROUPS: { label: string; items: string[] }[] = [
  { label: "Overview", items: ["/", "/my", "/approvals"] },
  { label: "Operations", items: ["/sites", "/engineers", "/voice", "/materials", "/labour"] },
  { label: "Finance", items: ["/reports", "/invoices", "/bills", "/suppliers", "/activity"] },
];

const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutGrid },
  { href: "/my", label: "My entries", icon: ClipboardList },
  { href: "/approvals", label: "Approvals", icon: ClipboardCheck },
  { href: "/sites", label: "Sites", icon: Building2 },
  { href: "/engineers", label: "Assistant engineers", icon: Users },
  { href: "/voice", label: "Voice entry", icon: Mic },
  { href: "/reports", label: "Reports", icon: FileText },
  { href: "/invoices", label: "Invoices", icon: ReceiptIndianRupee },
  { href: "/bills", label: "Bills", icon: ReceiptText },
  { href: "/materials", label: "Materials", icon: Boxes },
  { href: "/labour", label: "Labour", icon: HardHat },
  { href: "/suppliers", label: "Suppliers", icon: Store },
  { href: "/activity", label: "Activity", icon: History },
];

/** The four on the phone's bottom bar; the rest live behind "More". */
const BOTTOM = ["/", "/sites", "/voice", "/labour"];
/** An assistant engineer's whole app: their entries and voice entry. */
const ASSISTANT_NAV = ["/my", "/voice"];

/**
 * What the user's roles allow. Activity is for site owners and accountants (and org admins),
 * Approvals for site owners, Invoices for site owners and accountants, My entries for anyone
 * whose entries need approval. Someone who is only an assistant engineer sees just their
 * entries and voice entry. Assistant engineers' accounts are managed by the admin (the
 * organization owner) only. (The server enforces all of this; hiding links only keeps the
 * app tidy.)
 */
function useVisibleNav() {
  const { sites, org, readsRecords } = useSession();
  const approves = useApprovalSites().length > 0;
  const submits = useSubmitsForApproval();
  if (!readsRecords) return NAV.filter((n) => ASSISTANT_NAV.includes(n.href));
  const audit = org.role !== "member" || sites.some((s) => can(s.role, "audit:read"));
  const admin = org.role === "owner";
  const invoices = org.role !== "member" || sites.some((s) => can(s.role, "finance:manage"));
  return NAV.filter(
    (n) =>
      (n.href !== "/activity" || audit) &&
      (n.href !== "/approvals" || approves) &&
      (n.href !== "/my" || submits) &&
      (n.href !== "/engineers" || admin) &&
      (n.href !== "/invoices" || invoices),
  );
}

/** Waiting approvals or unread notices, shown on a nav link. */
function useBadge(href: string) {
  const { pendingApprovals, unreadNotices } = useSession();
  if (href === "/approvals") return pendingApprovals;
  if (href === "/my") return unreadNotices;
  return 0;
}

function isActive(pathname: string | null, href: string) {
  if (!pathname) return false;
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

const useMounted = () =>
  useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("");
}

/* ---------- Sidebar (tablet rail + desktop) ---------- */

function SidebarLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  const badge = useBadge(item.href);
  const link = (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      aria-label={badge ? `${item.label}, ${badge} new` : item.label}
      className={cn(
        "group relative flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-sidebar-ring md:justify-center lg:justify-start",
        active
          ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {active && <span aria-hidden className="absolute inset-y-2 -left-3 w-[3px] rounded-r-full bg-sidebar-primary" />}
      <Icon className={cn("size-[18px] shrink-0", active && "text-sidebar-primary")} aria-hidden />
      <span className="md:sr-only lg:not-sr-only">{item.label}</span>
      {badge > 0 && (
        <span aria-hidden className="num ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-warn px-1 text-[0.6875rem] font-bold text-background md:absolute md:top-0.5 md:right-1 lg:static">
          {badge}
        </span>
      )}
    </Link>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="block" />}>{link}</TooltipTrigger>
      <TooltipContent side="right" className="lg:hidden">{item.label}</TooltipContent>
    </Tooltip>
  );
}

function SidebarNav({ pathname }: { pathname: string | null }) {
  const nav = useVisibleNav();
  return (
    <div className="space-y-5">
      {NAV_GROUPS.map((group) => (
        <div key={group.label}>
          <p className="mb-1.5 px-3 text-xs font-medium text-muted-foreground md:sr-only lg:not-sr-only">{group.label}</p>
          <ul className="flex flex-col gap-0.5">
            {nav.filter((n) => group.items.includes(n.href)).map((item) => (
              <li key={item.href}>
                <SidebarLink item={item} active={isActive(pathname, item.href)} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function SidebarNavLive() {
  return <SidebarNav pathname={usePathname()} />;
}

function SettingsLink() {
  const pathname = usePathname();
  return <SidebarLink item={{ href: "/settings", label: "Settings", icon: Settings }} active={isActive(pathname, "/settings")} />;
}

function ProfileCard() {
  const { settings } = useSession();
  return (
    <Link
      href="/settings"
      className="flex items-center gap-3 rounded-lg p-2 text-sidebar-foreground transition-colors hover:bg-muted md:justify-center lg:justify-start"
    >
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-sm font-bold text-accent-foreground">
        {initials(settings.name)}
      </span>
      {/* Visually hidden (not removed) when the sidebar is collapsed, so the link keeps its name. */}
      <span className="min-w-0 leading-tight md:sr-only lg:not-sr-only lg:block">
        <span className="block truncate text-sm font-semibold text-foreground">{settings.name}</span>
        <span className="block truncate text-xs">{settings.role}, {settings.company}</span>
      </span>
    </Link>
  );
}

function Sidebar() {
  const canWrite = useWritableSites().length > 0;
  return (
    <aside className="no-print sticky top-0 hidden h-dvh flex-col glass-bar border-r border-[var(--line)] px-3 py-5 text-sidebar-foreground md:flex">
      <Link href="/" className="mb-8 flex items-center gap-3 px-1.5 md:justify-center lg:justify-start">
        <Logo className="size-9 shrink-0" />
        <span className="leading-tight md:sr-only lg:not-sr-only lg:block">
          <span className="font-display block text-[1.0625rem] font-extrabold text-foreground">Arcadia Home</span>
          <span className="block text-xs text-muted-foreground">Site expenses ERP</span>
        </span>
      </Link>

      <nav aria-label="Main" className="flex-1">
        <Suspense fallback={<SidebarNav pathname={null} />}>
          <SidebarNavLive />
        </Suspense>
      </nav>

      <div className="space-y-3">
        {canWrite && (
        <Link
          href="/voice"
          aria-label="Log by voice"
          className="brand-fill flex h-11 items-center justify-center gap-2 rounded-lg font-semibold transition-colors hover:brightness-110"
        >
          <Mic className="size-[18px]" aria-hidden />
          <span className="md:sr-only lg:not-sr-only">Log by voice</span>
        </Link>
        )}
        <Suspense fallback={null}>
          <SettingsLink />
        </Suspense>
        <div className="border-t border-sidebar-border pt-3">
          <ProfileCard />
        </div>
      </div>
    </aside>
  );
}

/* ---------- Top bar ---------- */

/** Site owners: how many entries wait for their approval, one tap away on any screen. */
function ApprovalsPill() {
  const { pendingApprovals: n } = useSession();
  if (!n) return null;
  return (
    <Link
      href="/approvals"
      aria-label={`${n} ${n === 1 ? "expense" : "expenses"} waiting for approval`}
      className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg border border-warn/40 bg-warn/10 px-3 text-sm font-semibold text-warn transition-colors hover:bg-warn/15"
    >
      <ClipboardCheck className="size-[18px]" aria-hidden />
      <span className="num">{n}</span>
      <span className="hidden sm:inline">waiting</span>
    </Link>
  );
}

/** Bills for people who see them; for an assistant engineer, their review results. */
function OverdueBell({ className }: { className?: string }) {
  const { overdueBills: overdue, readsRecords, unreadNotices } = useSession();
  if (!readsRecords) {
    return (
      <Link
        href="/my"
        aria-label={unreadNotices ? `${unreadNotices} new review ${unreadNotices === 1 ? "result" : "results"}` : "My entries, no new review results"}
        className={cn("relative grid size-11 place-items-center rounded-lg border border-[var(--line)] bg-card text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary", className)}
      >
        <Bell className="size-[18px]" aria-hidden />
        {unreadNotices > 0 && (
          <span className="num absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-full bg-warn px-1 text-[0.6875rem] font-bold text-background ring-2 ring-background">
            {unreadNotices}
          </span>
        )}
      </Link>
    );
  }
  return (
    <Link
      href="/bills"
      aria-label={overdue ? `${overdue} overdue bills` : "Bills, none overdue"}
      className={cn("relative grid size-11 place-items-center rounded-lg border border-[var(--line)] bg-card text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary", className)}
    >
      <Bell className="size-[18px]" aria-hidden />
      {overdue > 0 && (
        <span className="num absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-full bg-over px-1 text-[0.6875rem] font-bold text-white ring-2 ring-background">
          {overdue}
        </span>
      )}
    </Link>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useMounted();
  const dark = mounted && resolvedTheme === "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      className="grid size-11 place-items-center rounded-lg border border-[var(--line)] bg-card text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
    >
      {dark ? <Sun className="size-[18px]" aria-hidden /> : <Moon className="size-[18px]" aria-hidden />}
    </button>
  );
}

function TopBar() {
  const { settings, today } = useSession();
  return (
    <header className="no-print sticky top-0 z-30 hidden glass-bar border-b border-[var(--line)] md:block">
      <div className="mx-auto flex h-16 max-w-[1320px] items-center gap-3 px-6 lg:px-10">
        <SiteSearch className="w-full max-w-md" />
        <ActiveSiteSelect />
        <div className="ml-auto flex items-center gap-2">
          <span className="num hidden h-11 items-center rounded-lg border border-[var(--line)] bg-card px-3.5 text-sm text-muted-foreground xl:inline-flex">
            {formatDate(today, settings.dateFormat)}
          </span>
          <ApprovalsPill />
          <OverdueBell />
          <ThemeToggle />
          <Link
            href="/settings"
            className="brand-fill grid size-11 place-items-center rounded-full text-sm font-bold"
          >
            <span aria-hidden>{initials(settings.name)}</span>
            <span className="sr-only">Profile and settings</span>
          </Link>
        </div>
      </div>
    </header>
  );
}

function MobileTopBar() {
  return (
    <header className="no-print sticky top-0 z-30 flex h-[calc(4rem+env(safe-area-inset-top))] items-center justify-between gap-2 glass-bar border-b border-[var(--line)] px-4 pt-[env(safe-area-inset-top)] md:hidden">
      <div className="flex min-w-0 items-center gap-2">
        <Link href="/" className="shrink-0" aria-label="Arcadia Home dashboard">
          <Logo className="size-8" />
        </Link>
        <ActiveSiteChip />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ApprovalsPill />
        <OverdueBell />
        <Link
          href="/settings"
          aria-label="Settings"
          className="grid size-11 place-items-center rounded-lg border border-[var(--line)] bg-card text-muted-foreground"
        >
          <Settings className="size-[18px]" aria-hidden />
        </Link>
      </div>
    </header>
  );
}

/* ---------- Mobile bottom navigation ---------- */

function BottomNavItems({ pathname }: { pathname: string | null }) {
  const nav = useVisibleNav();
  const { readsRecords } = useSession();
  const bottom = readsRecords ? BOTTOM : ASSISTANT_NAV;
  const [moreOpen, setMoreOpen] = useState(false);
  const more = nav.filter((n) => !bottom.includes(n.href));
  const moreActive = more.some((n) => isActive(pathname, n.href)) || isActive(pathname, "/settings");
  const tab = (active: boolean, Icon: LucideIcon, label: string) => (
    <>
      <span className={cn("grid h-7 w-12 place-items-center rounded-full transition-colors", active && "bg-accent")}>
        <Icon className="size-5" aria-hidden />
      </span>
      {label}
    </>
  );
  const tabClass = (active: boolean) =>
    cn("flex h-16 w-full flex-col items-center justify-center gap-1 text-[0.6875rem]", active ? "font-semibold text-primary" : "text-muted-foreground");
  return (
    <>
      <ul className={cn("grid items-end", readsRecords ? "grid-cols-5" : "grid-cols-3")}>
        {nav
          .filter((n) => bottom.includes(n.href))
          .map((item) => {
            const active = isActive(pathname, item.href);
            if (item.href === "/voice") {
              return (
                <li key={item.href} className="flex justify-center">
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    aria-label="Voice entry"
                    className="brand-fill -mt-7 mb-1.5 grid size-15 place-items-center rounded-full shadow-[0_10px_20px_-10px_rgb(22_101_52/0.9)] ring-4 ring-background"
                  >
                    <Mic className="size-7" aria-hidden />
                  </Link>
                </li>
              );
            }
            return (
              <li key={item.href}>
                <BottomTab item={item} active={active} className={tabClass(active)}>
                  {tab(active, item.icon, item.label === "Dashboard" ? "Home" : item.label)}
                </BottomTab>
              </li>
            );
          })}
        <li>
          <button type="button" onClick={() => setMoreOpen(true)} aria-haspopup="dialog" className={tabClass(moreActive)}>
            {tab(moreActive, Menu, "More")}
          </button>
        </li>
      </ul>
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]">
          <SheetHeader>
            <SheetTitle>More</SheetTitle>
          </SheetHeader>
          <ul className="grid grid-cols-3 gap-2 px-4">
            {[...more, { href: "/settings", label: "Settings", icon: Settings }].map((item) => {
              const Icon = item.icon;
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setMoreOpen(false)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex h-20 flex-col items-center justify-center gap-1.5 rounded-xl border text-sm",
                      active ? "border-primary/40 bg-accent font-semibold text-primary" : "border-[var(--line)] bg-card",
                    )}
                  >
                    <Icon className="size-5" aria-hidden />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </SheetContent>
      </Sheet>
    </>
  );
}

function BottomTab({ item, active, className, children }: { item: NavItem; active: boolean; className: string; children: ReactNode }) {
  const badge = useBadge(item.href);
  return (
    <Link href={item.href} aria-current={active ? "page" : undefined} aria-label={badge ? `${item.label}, ${badge} new` : undefined} className={cn("relative", className)}>
      {children}
      {badge > 0 && (
        <span aria-hidden className="num absolute top-1.5 left-1/2 ml-2 grid h-4.5 min-w-4.5 place-items-center rounded-full bg-warn px-1 text-[0.625rem] font-bold text-background">
          {badge}
        </span>
      )}
    </Link>
  );
}

function BottomNav() {
  return <BottomNavItems pathname={usePathname()} />;
}

/* ---------- Shell ---------- */

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[84px_1fr] lg:grid-cols-[264px_1fr]">
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>

      <Sidebar />

      <div className="flex min-w-0 flex-col">
        <ConnectionBanner />
        <MobileTopBar />
        <TopBar />
        <main id="main" className="mx-auto w-full max-w-[1320px] flex-1 px-4 pt-6 pb-32 sm:px-6 md:pb-12 lg:px-10 lg:pt-8">
          {children}
        </main>
      </div>

      <nav
        aria-label="Main"
        className="no-print fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 rounded-2xl surface-raised md:hidden"
      >
        <Suspense fallback={<BottomNavItems pathname={null} />}>
          <BottomNav />
        </Suspense>
      </nav>
    </div>
  );
}
