import type { Category, Site } from "./types";

/**
 * Shapes of the aggregates the server computes (src/server/data/dashboard.ts,
 * sites.ts). Only display helpers live here; no totals are computed client-side.
 */

export type PeriodTotals = {
  today: number;
  yesterday: number;
  week: number;
  lastWeekToDate: number;
  month: number;
  lastMonthToDate: number;
};

export type TrendPoint = { key: string; label: string; total: number } & Record<Category, number>;

export type Granularity = "daily" | "weekly" | "monthly";

export type CategoryTotal = { category: Category; amount: number };

export type SiteSummary = {
  site: Site;
  spent: number;
  balance: number;
  utilisation: number; // 0..n (1 = 100%)
  /** The total budget's alert threshold, 0..1. */
  alertAt: number;
  monthSpend: number;
  lastEntry?: string;
  daysRunning: number;
  entryCount: number;
};

/** Budget state used for colour + label (never colour alone). `alertAt` is the line's threshold, 0..1. */
export function budgetState(utilisation: number, alertAt = 0.8) {
  if (utilisation > 1) return "over" as const;
  if (utilisation >= alertAt) return "tight" as const;
  return "ok" as const;
}
