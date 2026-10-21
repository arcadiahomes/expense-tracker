"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import type {
  NameType,
  ValueType,
} from "recharts/types/component/DefaultTooltipContent";
import { CATEGORY_META } from "@/lib/categories";
import { formatINR, formatINRCompact, percent } from "@/lib/format";
import type { TrendPoint } from "@/lib/analytics";
import { CATEGORIES, type Category } from "@/lib/types";

const axisTick = { fill: "var(--muted-foreground)", fontSize: 12 };

export function CategoryLegend({ categories = CATEGORIES }: { categories?: readonly Category[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      {categories.map((c) => (
        <li key={c} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px]" style={{ backgroundColor: CATEGORY_META[c].color }} aria-hidden />
          {CATEGORY_META[c].label}
        </li>
      ))}
    </ul>
  );
}

function TrendTooltip({ active, payload, label }: TooltipContentProps<ValueType, NameType>) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload as TrendPoint;
  return (
    <div className="surface-raised min-w-48 rounded-xl p-3 text-xs text-popover-foreground">
      <div className="mb-2 flex justify-between gap-4 font-semibold">
        <span>{label}</span>
        <span className="num">{formatINR(point.total)}</span>
      </div>
      <ul className="space-y-1">
        {[...CATEGORIES].reverse().map((c) =>
          point[c] > 0 ? (
            <li key={c} className="flex items-center justify-between gap-4">
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <span className="size-2 rounded-full" style={{ backgroundColor: CATEGORY_META[c].color }} />
                {CATEGORY_META[c].label}
              </span>
              <span className="num">{formatINR(point[c])}</span>
            </li>
          ) : null,
        )}
      </ul>
    </div>
  );
}

/** Stacked spend per period, one segment per category. */
export function SpendTrendChart({ data, height = 260 }: { data: TrendPoint[]; height?: number }) {
  const total = data.reduce((t, d) => t + d.total, 0);
  return (
    <figure>
      <div style={{ height }} role="img" aria-label={`Spending trend, total ${formatINR(total)} over ${data.length} periods`}>
        <ResponsiveContainer width="100%" height="100%">
          {/* Not focusable itself: the figure's label and data table carry the numbers for assistive tech. */}
          <BarChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barCategoryGap="22%" accessibilityLayer={false}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--border)" }} interval="preserveStartEnd" minTickGap={12} />
            <YAxis tick={axisTick} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => formatINRCompact(v)} />
            <Tooltip content={TrendTooltip} cursor={{ fill: "var(--muted)", opacity: 0.7 }} />
            {CATEGORIES.map((c, i) => (
              <Bar
                key={c}
                dataKey={c}
                stackId="spend"
                fill={CATEGORY_META[c].color}
                stroke="var(--card)"
                strokeWidth={1}
                radius={i === CATEGORIES.length - 1 ? [3, 3, 0, 0] : 0}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="mt-3">
        <CategoryLegend />
      </figcaption>
      {/* sr-only on a wrapper: tables ignore its width/overflow and would widen the page on phones. */}
      <div className="sr-only">
      <table>
        <caption>Spending per period by category</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            {CATEGORIES.map((c) => <th key={c} scope="col">{CATEGORY_META[c].label}</th>)}
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.key}>
              <th scope="row">{d.label}</th>
              {CATEGORIES.map((c) => <td key={c}>{formatINR(d[c])}</td>)}
              <td>{formatINR(d.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </figure>
  );
}

/** Ranked horizontal bars for category share. HTML so labels never collide. */
export function CategoryBars({ data }: { data: { category: Category; amount: number }[] }) {
  const total = data.reduce((t, d) => t + d.amount, 0);
  const max = Math.max(1, ...data.map((d) => d.amount));
  return (
    <ul className="space-y-3.5">
      {data.map(({ category, amount }) => {
        const meta = CATEGORY_META[category];
        const Icon = meta.icon;
        return (
          <li key={category}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
              <span className="inline-flex items-center gap-2">
                <Icon className="size-4" style={{ color: meta.color }} aria-hidden />
                {meta.label}
              </span>
              <span className="num">
                <span className="font-semibold">{formatINRCompact(amount)}</span>
                <span className="ml-2 inline-block w-9 text-right text-muted-foreground">{percent(amount, total)}%</span>
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted">
              <div className="h-full rounded-full" style={{ width: `${(amount / max) * 100}%`, backgroundColor: meta.color }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function SiteTooltip({ active, payload }: TooltipContentProps<ValueType, NameType>) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as { name: string; amount: number };
  return (
    <div className="surface-raised rounded-xl px-3 py-2 text-xs">
      <p className="font-semibold">{p.name}</p>
      <p className="num text-muted-foreground">{formatINR(p.amount)}</p>
    </div>
  );
}

/** One series (spend per site), so one colour and no legend. */
export function SiteComparisonChart({ data }: { data: { name: string; amount: number }[] }) {
  const height = Math.max(160, data.length * 44 + 24);
  return (
    <div style={{ height }} role="img" aria-label={`Spend by site: ${data.map((d) => `${d.name} ${formatINR(d.amount)}`).join(", ")}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 56, left: 0, bottom: 0 }} barCategoryGap="28%" accessibilityLayer={false}>
          <defs>
            <linearGradient id="site-bar" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#34d399" />
              <stop offset="1" stopColor="var(--primary)" />
            </linearGradient>
          </defs>
          <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="name" tick={axisTick} tickLine={false} axisLine={false} width={150} />
          <Tooltip content={SiteTooltip} cursor={{ fill: "var(--muted)", opacity: 0.7 }} />
          <Bar
            dataKey="amount"
            fill="url(#site-bar)"
            radius={[0, 4, 4, 0]}
            isAnimationActive={false}
            label={{ position: "right", fill: "var(--muted-foreground)", fontSize: 12, formatter: (v: unknown) => formatINRCompact(Number(v)) }}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Decorative trend line for a stat card; the card itself carries the numbers. */
export function Sparkline({ data, color, id }: { data: number[]; color: string; id: string }) {
  const points = data.map((v, i) => ({ i, v }));
  return (
    <div className="h-full w-full" aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} accessibilityLayer={false}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity={0.35} />
              <stop offset="1" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey="v" stroke={color} strokeWidth={2} fill={`url(#${id})`} isAnimationActive={false} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
