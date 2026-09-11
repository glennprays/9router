"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import PropTypes from "prop-types";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  PieChart,
  Pie,
} from "recharts";
import { Card, CardSkeleton, SegmentedControl, Select } from "@/shared/components";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
];

const METRICS = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
  { value: "requests", label: "Requests" },
];

const METRIC_LABELS = { cost: "Cost", tokens: "Tokens", requests: "Requests" };

// Dark-legible series colors; fixed order keeps member/provider hues stable across renders.
const PALETTE = ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#3b82f6", "#a855f7", "#14b8a6", "#f97316"];

// Select always renders a disabled placeholder for value "", so "all" needs a selectable sentinel.
const ALL_MEMBERS = "__all__";

const TOOLTIP_STYLE = {
  backgroundColor: "var(--color-bg)",
  border: "1px solid var(--color-border)",
  borderRadius: "8px",
  fontSize: "12px",
};

const fmtTokens = (n) => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n || 0);
};
const fmtCost = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const fmtNum = (n) => Number(n || 0).toLocaleString();
const fmtMetricFor = (metric) => (metric === "cost" ? fmtCost : metric === "tokens" ? fmtTokens : fmtNum);
const truncateTick = (v) => (String(v).length > 24 ? `${String(v).slice(0, 23)}…` : String(v));

export default function TeamAnalytics({ keys = [] }) {
  const [period, setPeriod] = useState("30d");
  const [metric, setMetric] = useState("cost");
  const [member, setMember] = useState(ALL_MEMBERS);
  const [data, setData] = useState(null);

  const selectedKey = member === ALL_MEMBERS ? "" : member;
  const memberName = selectedKey
    ? (keys.find((k) => k.key === selectedKey)?.name || `${selectedKey.slice(0, 8)}...`)
    : "";

  const fetchAnalytics = useCallback(() => {
    const apiKeyParam = member === ALL_MEMBERS ? "" : `&apiKey=${encodeURIComponent(member)}`;
    return fetch(`/api/team/analytics?period=${period}${apiKeyParam}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((next) => {
        if (next) setData(next);
      })
      .catch((error) => console.log("Error fetching team analytics:", error));
  }, [period, member]);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  // Payload is metric-complete: switching metric re-renders charts client-side, no refetch.
  const fmtMetric = fmtMetricFor(metric);
  const metricVal = (row) => row[metric] || 0;
  const hasPositive = (arr) => Array.isArray(arr) && arr.some((row) => metricVal(row) > 0);

  /** Top n rows by the active metric; the remainder folds into "Others" (slices total exactly). */
  const topN = (arr, n) => {
    if (!Array.isArray(arr)) return [];
    const sorted = [...arr].sort((a, b) => metricVal(b) - metricVal(a));
    if (sorted.length <= n) return sorted;
    const others = sorted.slice(n).reduce((acc, row) => ({
      requests: acc.requests + (row.requests || 0),
      tokens: acc.tokens + (row.tokens || 0),
      cost: acc.cost + (row.cost || 0),
    }), { name: "Others", requests: 0, tokens: 0, cost: 0 });
    return [...sorted.slice(0, n), others];
  };

  /** Top n rows by the active metric, no "Others" fold (bar charts). */
  const topOnly = (arr, n) => (
    Array.isArray(arr)
      ? [...arr].sort((a, b) => metricVal(b) - metricVal(a)).slice(0, n)
      : []
  );

  // Stacked per-member rows: top-6 members by the active metric, the rest folded into "Others".
  const memberSeries = useMemo(() => {
    const buckets = data?.perMemberSeries?.buckets || [];
    const totals = {};
    for (const bucket of buckets) {
      for (const [name, v] of Object.entries(bucket.values || {})) {
        totals[name] = (totals[name] || 0) + (v[metric] || 0);
      }
    }
    const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    const top = ranked.slice(0, 6).map(([name]) => name);
    const hasOthers = ranked.length > top.length;
    const names = hasOthers ? [...top, "Others"] : top;
    const rows = buckets.map((bucket) => {
      // Seed every series to 0 so sparse members don't leave gaps that break area stacking.
      const row = { label: bucket.label };
      for (const name of names) row[name] = 0;
      const others = { requests: 0, tokens: 0, cost: 0 };
      for (const [name, v] of Object.entries(bucket.values || {})) {
        if (top.includes(name)) row[name] += v[metric] || 0;
        else {
          others.requests += v.requests || 0;
          others.tokens += v.tokens || 0;
          others.cost += v.cost || 0;
        }
      }
      if (hasOthers) row.Others = others[metric];
      return row;
    });
    const total = ranked.reduce((sum, [, v]) => sum + v, 0);
    return { rows, names, total };
  }, [data, metric]);

  if (!data) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const scopeSuffix = memberName ? ` — ${memberName}` : "";
  const timeHasData = hasPositive(data.timeSeries);

  return (
    <div className="flex min-w-0 flex-col gap-4 sm:gap-6">
      {/* Controls bar */}
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <SegmentedControl options={METRICS} value={metric} onChange={setMetric} size="sm" />
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl options={PERIODS} value={period} onChange={setPeriod} size="sm" />
          <Select
            value={member}
            onChange={(e) => setMember(e.target.value)}
            options={[
              { value: ALL_MEMBERS, label: "All members" },
              ...keys.map((k) => ({ value: k.key, label: k.name })),
            ]}
            selectClassName="w-44"
          />
        </div>
      </div>

      {/* KPI tiles */}
      <div className="grid min-w-0 grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
          <span className="text-text-muted text-sm uppercase font-semibold">Total Cost</span>
          <span className="truncate text-2xl font-bold">{fmtCost(data.totals.cost)}</span>
        </Card>
        <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
          <span className="text-text-muted text-sm uppercase font-semibold">Total Tokens</span>
          <span className="truncate text-2xl font-bold text-primary">{fmtTokens(data.totals.tokens)}</span>
        </Card>
        <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
          <span className="text-text-muted text-sm uppercase font-semibold">Total Requests</span>
          <span className="truncate text-2xl font-bold text-info">{fmtNum(data.totals.requests)}</span>
        </Card>
        <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
          <span className="text-text-muted text-sm uppercase font-semibold">Active Members</span>
          <span className="truncate text-2xl font-bold text-success">{fmtNum(data.activeMembers)}</span>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-2">
        <div className="min-w-0 lg:col-span-2">
          <ChartCard title={`Usage over time${scopeSuffix}`} hasData={timeHasData} height={240}>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={data.timeSeries} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="gradTeamMetric" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={fmtMetric}
                  width={50}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(value) => [fmtMetric(value), METRIC_LABELS[metric]]}
                />
                <Area
                  type="monotone"
                  dataKey={metric}
                  stroke="#6366f1"
                  strokeWidth={2}
                  fill="url(#gradTeamMetric)"
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>

        <ChartCard title="Share by member (team-wide)" hasData={hasPositive(data.byMember)}>
          <DonutChart slices={topN(data.byMember, 6)} metric={metric} />
        </ChartCard>

        <ChartCard title={`Share by provider${scopeSuffix}`} hasData={hasPositive(data.byProvider)}>
          <DonutChart slices={topN(data.byProvider, 6)} metric={metric} />
        </ChartCard>

        <ChartCard title={`Top models${scopeSuffix}`} hasData={hasPositive(data.byModel)}>
          <HBarChart rows={topOnly(data.byModel, 8)} metric={metric} color={PALETTE[2]} />
        </ChartCard>

        <ChartCard title="Top endpoints (team-wide)" hasData={hasPositive(data.byEndpoint)}>
          <HBarChart rows={topOnly(data.byEndpoint, 8)} metric={metric} color={PALETTE[4]} />
        </ChartCard>

        <div className="min-w-0 lg:col-span-2">
          <ChartCard title="Per-member over time (team-wide)" hasData={memberSeries.total > 0} height={240}>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={memberSeries.rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={fmtMetric}
                  width={50}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(value, name) => [fmtMetric(value), name]}
                />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                {memberSeries.names.map((name, i) => (
                  <Area
                    key={name}
                    type="monotone"
                    dataKey={name}
                    stackId="1"
                    stroke={PALETTE[i % PALETTE.length]}
                    fill={PALETTE[i % PALETTE.length]}
                    fillOpacity={0.35}
                    strokeWidth={1.5}
                    dot={false}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      </div>
    </div>
  );
}

function ChartCard({ title, hasData, height = 220, children }) {
  return (
    <Card className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {!hasData ? (
        <div className="flex items-center justify-center text-text-muted text-sm" style={{ height }}>
          No data for this period
        </div>
      ) : (
        children
      )}
    </Card>
  );
}

function DonutChart({ slices, metric }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        {/* Slice color rides on each data entry's fill (v3 pattern); <Cell> children trip a
            React key warning inside recharts' PolarLabelContextProvider. */}
        <Pie
          data={slices.map((entry, i) => ({ ...entry, fill: PALETTE[i % PALETTE.length] }))}
          dataKey={metric}
          nameKey="name"
          innerRadius={55}
          outerRadius={85}
          paddingAngle={2}
          stroke="none"
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={(value, name) => [fmtMetricFor(metric)(value), name]}
        />
        <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

function HBarChart({ rows, metric, color }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} horizontal={false} />
        <XAxis
          type="number"
          tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={fmtMetricFor(metric)}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={150}
          tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.7 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={truncateTick}
        />
        <Tooltip
          cursor={{ fill: "currentColor", fillOpacity: 0.06 }}
          contentStyle={TOOLTIP_STYLE}
          formatter={(value) => [fmtMetricFor(metric)(value), METRIC_LABELS[metric]]}
        />
        <Bar dataKey={metric} fill={color} radius={[0, 4, 4, 0]} barSize={14} />
      </BarChart>
    </ResponsiveContainer>
  );
}

TeamAnalytics.propTypes = {
  keys: PropTypes.array,
};

ChartCard.propTypes = {
  title: PropTypes.string.isRequired,
  hasData: PropTypes.bool.isRequired,
  height: PropTypes.number,
  children: PropTypes.node,
};

DonutChart.propTypes = {
  slices: PropTypes.array.isRequired,
  metric: PropTypes.string.isRequired,
};

HBarChart.propTypes = {
  rows: PropTypes.array.isRequired,
  metric: PropTypes.string.isRequired,
  color: PropTypes.string.isRequired,
};
