// Overview: stance trend, engagement, roster snapshot. All values from the DB.
import { useEffect, useMemo, useState } from "react";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { Agent, Post, RunDetail } from "../types";
import * as api from "../api";
import { Spinner } from "../common";
import { postOverallStance } from "./helpers";

export default function OverviewTab({ run, posts, runId, onError, bumpKey }: {
  run: RunDetail;
  posts: Post[];
  runId: string;
  onError: (e: unknown) => void;
  bumpKey: number;
}) {
  const [metrics, setMetrics] = useState<Awaited<ReturnType<typeof api.getMetrics>> | null>(null);
  const [agents, setAgents] = useState<Agent[] | null>(null);

  useEffect(() => {
    api.getMetrics(runId).then(setMetrics as never).catch((e) => onError(e));
    api.listAgents(runId).then((a) => setAgents(a.agents)).catch((e) => onError(e));
  }, [runId, bumpKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const engSeries = useMemo(
    () => (metrics?.metrics ?? []).map((m) => ({ tick: m.tick, engagement: m.engagement ?? 0 })),
    [metrics]);

  const stanceCounts = useMemo(() => {
    const c = { pro: 0, neu: 0, con: 0 };
    for (const p of posts) c[postOverallStance(p)] += 1;
    return c;
  }, [posts]);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="panel p-4 lg:col-span-2">
        <h2 className="eyebrow mb-2">Mean stance per issue (−1 oppose … +1 support)</h2>
        {metrics && Object.keys(metrics.stance_by_issue).length > 0 ? (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={mergeStanceSeries(metrics.stance_by_issue)}>
              <CartesianGrid stroke="var(--line-1)" strokeDasharray="3 3" />
              <XAxis dataKey="tick" stroke="var(--fg-3)" fontSize={11} />
              <YAxis domain={[-1, 1]} stroke="var(--fg-3)" fontSize={11} ticks={[-1, -0.5, 0, 0.5, 1]} />
              <Tooltip contentStyle={{ background: "var(--bg-1)", border: "1px solid var(--line-2)", borderRadius: 6, fontSize: 12 }} />
              {Object.keys(metrics.stance_by_issue).map((issue) => (
                <Area key={issue} type="monotone" dataKey={issue}
                      stroke="var(--ac)" fill="var(--ac)" fillOpacity={0.15} strokeWidth={2} />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <p className="panel-2 p-4 text-sm" style={{ color: "var(--fg-3)" }}>
            No stance history yet — start the run. The chart is drawn only from recorded stance ticks.
          </p>
        )}

        {engSeries.length > 1 && (
          <>
            <h2 className="eyebrow mt-4 mb-2">Engagement per tick</h2>
            <ResponsiveContainer width="100%" height={140}>
              <AreaChart data={engSeries}>
                <CartesianGrid stroke="var(--line-1)" strokeDasharray="3 3" />
                <XAxis dataKey="tick" stroke="var(--fg-3)" fontSize={11} />
                <Tooltip contentStyle={{ background: "var(--bg-1)", border: "1px solid var(--line-2)", borderRadius: 6, fontSize: 12 }} />
                <Area type="monotone" dataKey="engagement" stroke="var(--ev)" fill="var(--ev)" fillOpacity={0.15} />
              </AreaChart>
            </ResponsiveContainer>
          </>
        )}
      </div>

      <div className="panel p-4">
        <h2 className="eyebrow mb-2">Stance split (posts)</h2>
        {posts.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--fg-3)" }}>No posts yet.</p>
        ) : (
          <div className="flex h-2 overflow-hidden rounded-full">
            <span style={{ width: `${(stanceCounts.pro / posts.length) * 100}%`, background: "var(--pro)" }} />
            <span style={{ width: `${(stanceCounts.neu / posts.length) * 100}%`, background: "var(--neu)" }} />
            <span style={{ width: `${(stanceCounts.con / posts.length) * 100}%`, background: "var(--con)" }} />
          </div>
        )}
        <dl className="mt-3 grid gap-1 text-xs">
          <Row k="PRO" v={stanceCounts.pro} color="var(--pro-fg)" />
          <Row k="NEUTRAL" v={stanceCounts.neu} color="var(--neu-fg)" />
          <Row k="CON" v={stanceCounts.con} color="var(--con-fg)" />
        </dl>
        <div className="divider my-3" />
        <h2 className="eyebrow mb-2">Scenario</h2>
        <p className="text-sm" style={{ color: "var(--fg-2)" }}>
          {run.scenario.question || "—"}
        </p>
      </div>

      <div className="panel max-h-[480px] overflow-y-auto p-4 lg:col-span-3">
        <h2 className="eyebrow mb-2">Agents</h2>
        {!agents ? <Spinner /> : agents.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--fg-3)" }}>Not seeded yet.</p>
        ) : (
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            {agents.map((a) => (
              <li key={a.id} className="panel-2 p-2">
                <p style={{ fontWeight: 600 }}>{a.name} <span className="mono text-xs" style={{ color: "var(--fg-3)" }}>@{a.handle}</span></p>
                <p className="text-xs" style={{ color: "var(--fg-3)" }}>{a.group} · {a.archetype}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {Object.entries(a.stances).map(([iss, st]) => (
                    <span key={iss} className={`badge ${st.value > 0.15 ? "st-pro" : st.value < -0.15 ? "st-con" : "st-neu"}`}>
                      {iss} {st.value > 0 ? "+" : ""}{st.value.toFixed(2)}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Row({ k, v, color }: { k: string; v: number; color: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt style={{ color }}>{k}</dt>
      <dd className="num" style={{ color: "var(--fg-2)" }}>{v}</dd>
    </div>
  );
}

function mergeStanceSeries(byIssue: Record<string, { tick: number; value: number }[]>) {
  const rows = new Map<number, Record<string, number>>();
  for (const [issue, pts] of Object.entries(byIssue)) {
    for (const pt of pts) {
      const r = rows.get(pt.tick) ?? { tick: pt.tick };
      r[issue] = pt.value;
      rows.set(pt.tick, r);
    }
  }
  return [...rows.values()].sort((a, b) => a.tick - b.tick);
}
