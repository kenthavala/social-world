// Agents tab: roster + detail drawer (stance history, posts, memories, knowledge).
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { Agent, Post } from "../types";
import * as api from "../api";
import { Spinner } from "../common";
import { initials, hashHue, postOverallStance } from "./helpers";

const CLS = (v: number) => (v > 0.15 ? "st-pro" : v < -0.15 ? "st-con" : "st-neu");

export default function AgentsTab({ runId, runSourceId, bumpKey, onError }: {
  runId: string;
  runSourceId: string | null;
  bumpKey: number;
  onError: (e: unknown) => void;
}) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "pro" | "neu" | "con">("all");

  useEffect(() => {
    api.listAgents(runId).then((a) => setAgents(a.agents)).catch((e) => onError(e));
  }, [runId, bumpKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    if (!agents) return [];
    let out = agents;
    if (filter !== "all") {
      out = out.filter((a) => {
        const vals = Object.values(a.stances).map((s) => s.value);
        const mean = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 0;
        return filter === "pro" ? mean > 0.15 : filter === "con" ? mean < -0.15 : Math.abs(mean) <= 0.15;
      });
    }
    if (q.trim()) {
      const n = q.toLowerCase();
      out = out.filter((a) => a.name.toLowerCase().includes(n) || a.handle.toLowerCase().includes(n));
    }
    return out;
  }, [agents, filter, q]);

  if (!agents) return <Spinner label="Loading agents" />;

  return (
    <div className="flex gap-4">
      <div className="min-w-0 flex-1">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {(["all", "pro", "neu", "con"] as const).map((f) => (
            <button
              key={f}
              className="chip cursor-pointer"
              onClick={() => setFilter(f)}
              style={filter === f
                ? { borderColor: "var(--ac-line)", color: "var(--ac-fg)", background: "var(--ac-soft)" }
                : undefined}
            >
              {f.toUpperCase()}
            </button>
          ))}
          <input
            className="input ml-auto max-w-48"
            placeholder="Search name or @handle"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        {agents.length === 0 ? (
          <div className="panel p-10 text-center text-sm" style={{ color: "var(--fg-3)" }}>
            Not seeded yet — start the run to generate agents.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {shown.map((a) => {
              const hue = hashHue(a.handle);
              const vals = Object.values(a.stances).map((s) => s.value);
              const mean = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 0;
              return (
                <button
                  key={a.id}
                  onClick={() => setSel(a.id)}
                  className="panel flex cursor-pointer items-center gap-3 p-3 text-left"
                  style={sel === a.id
                    ? { borderColor: "var(--ac-line)" }
                    : { borderColor: "var(--line-2)" }}
                >
                  <span
                    className="mono flex-none place-items-center"
                    style={{
                      width: 30, height: 30, borderRadius: "var(--r-2)", display: "grid",
                      fontSize: 11, fontWeight: 600, color: `hsl(${hue} 65% 72%)`,
                      background: `hsl(${hue} 50% 16%)`, border: `1px solid hsl(${hue} 50% 30%)`,
                    }}
                    aria-hidden
                  >
                    {initials(a.name, a.handle)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span style={{ fontWeight: 600 }}>{a.name}</span>
                      <span className={`badge ${CLS(mean)}`}>
                        {mean > 0.15 ? "PRO" : mean < -0.15 ? "CON" : "NEUTRAL"}
                      </span>
                    </div>
                    <div className="text-xs" style={{ color: "var(--fg-3)" }}>
                      @{a.handle} · {a.group} · {a.archetype}
                    </div>
                  </div>
                  <div className="hidden flex-wrap justify-end gap-1 md:flex">
                    {Object.entries(a.stances).map(([iss, st]) => (
                      <span key={iss} className={`badge ${CLS(st.value)}`}>
                        {iss} {st.value > 0 ? "+" : ""}{st.value.toFixed(2)}
                      </span>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {sel && (
        <AgentDrawer
          runId={runId}
          agentId={sel}
          runSourceId={runSourceId}
          onClose={() => setSel(null)}
          onError={onError}
          bumpKey={bumpKey}
        />
      )}
    </div>
  );
}

function AgentDrawer({ runId, agentId, runSourceId, onClose, onError, bumpKey }: {
  runId: string;
  agentId: string;
  runSourceId: string | null;
  onClose: () => void;
  onError: (e: unknown) => void;
  bumpKey: number;
}) {
  const [detail, setDetail] = useState<api.AgentDetail | null>(null);
  const [pages, setPages] = useState<Record<string, number | null>>({});

  useEffect(() => {
    api.getAgentDetail(runId, agentId).then(setDetail).catch((e) => {
      setDetail(null);
      onError(e);
    });
  }, [runId, agentId, bumpKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // resolve real chunk pages for this agent's citations
  useEffect(() => {
    if (!detail || !runSourceId) return;
    const ids = new Set<string>();
    for (const p of detail.posts) (p.cited_chunk_ids ?? []).forEach((c) => ids.add(c));
    const missing = [...ids].filter((c) => !(c in pages));
    if (missing.length === 0) return;
    let alive = true;
    for (const id of missing) {
      api.getChunk(runSourceId, id).then((c) => {
        if (alive) setPages((m) => ({ ...m, [id]: c.page_start ?? null }));
      }).catch(() => {
        if (alive) setPages((m) => ({ ...m, [id]: null }));
      });
    }
    return () => { alive = false; };
  }, [detail, runSourceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const a = detail?.agent;

  return (
    <aside
      className="sticky top-2 hidden h-[calc(100vh-1rem)] w-[430px] flex-none overflow-y-auto lg:block"
      style={{ background: "var(--bg-1)", border: "1px solid var(--line-2)", borderRadius: "var(--r-3)" }}
    >
      <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3"
           style={{ background: "var(--bg-1)", borderBottom: "1px solid var(--line-1)" }}>
        <span className="eyebrow">Agent details</span>
        <button className="btn-ghost btn-sm" onClick={onClose}><X size={13} /></button>
      </div>

      {!a || !detail ? (
        <Spinner label="Loading agent" />
      ) : (
        <div className="px-4 py-4">
          <div className="flex items-center gap-3">
            <AvatarChip handle={a.handle} name={a.name} />
            <div className="min-w-0">
              <p style={{ fontWeight: 600 }}>{a.name}</p>
              <p className="text-xs" style={{ color: "var(--fg-3)" }}>
                @{a.handle} · {a.group} · {a.archetype}
              </p>
            </div>
          </div>

          {a.bio && <p className="mt-3 text-sm" style={{ color: "var(--fg-2)" }}>{a.bio}</p>}

          <Section title="Stances now">
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(a.stances).map(([iss, st]) => (
                <span key={iss} className={`badge ${CLS(st.value)}`}>
                  {iss} {st.value > 0 ? "+" : ""}{st.value.toFixed(2)}
                  <span style={{ opacity: 0.7 }}> conf {st.confidence?.toFixed(2) ?? "—"}</span>
                </span>
              ))}
            </div>
          </Section>

          {Object.keys(detail.stance_history).length > 0 && (
            <Section title="Stance history per issue">
              <StanceHistoryCard series={detail.stance_history} />
            </Section>
          )}

          {a.belief_summary && (
            <Section title="Self-described beliefs">
              {a.belief_summary}
            </Section>
          )}

          {a.traits && Object.keys(a.traits).length > 0 && (
            <Section title="Traits">
              <dl className="grid gap-1 text-xs sm:grid-cols-2">
                {Object.entries(a.traits).map(([k, v]) => (
                  <div key={k} className="flex justify-between">
                    <dt className="capitalize" style={{ color: "var(--fg-3)" }}>{k}</dt>
                    <dd className="num">{typeof v === "number" ? v.toFixed(2) : String(v)}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          )}

          {Object.keys(a.big5 ?? {}).length > 0 && (
            <Section title="Big five (seeded, model-reported)">
              <dl className="grid gap-1 text-xs sm:grid-cols-2">
                {Object.entries(a.big5 ?? {}).map(([k, v]) => (
                  <div key={k} className="flex justify-between">
                    <dt style={{ color: "var(--fg-3)" }}>{k}</dt>
                    <dd className="num">{typeof v === "number" ? v.toFixed(2) : String(v)}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          )}

          {detail.memories.length > 0 && (
            <Section title={`Memories — ${detail.memories.length}`}>
              <ul className="flex flex-col gap-1.5 text-xs">
                {detail.memories.slice(0, 12).map((m, i) => (
                  <li key={i} className="panel-2 p-2">
                    <span className="mono" style={{ color: "var(--fg-4)" }}>T{m.tick}</span>{" "}
                    <span className="chip" style={{ fontSize: 10 }}>{m.kind}</span>{" "}
                    {m.text}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {(a.knowledge ?? []).length > 0 && (
            <Section title={`Knowledge — ${a.knowledge.length} chunks`}>
              <ul className="flex flex-col gap-1 text-xs">
                {a.knowledge.slice(0, 10).map((c, i) => {
                  const cid = typeof c === "string" ? c : String((c as { chunk_id?: string })?.chunk_id ?? c);
                  return <li key={i} className="mono" style={{ color: "var(--fg-3)" }}>{cid}</li>;
                })}
              </ul>
            </Section>
          )}

          <Section title={`Posts — ${detail.posts.length}`}>
            {detail.posts.length === 0 ? (
              <p className="text-xs" style={{ color: "var(--fg-3)" }}>Nothing posted yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {detail.posts.map((p: Post) => (
                  <li key={p.id} className="panel-2 p-2.5">
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`badge ${CLS(Object.values(p.stance ?? {}).reduce((s, x) => s + x.value, 0) / Math.max(1, Object.keys(p.stance ?? {}).length))}`}>
                        {postOverallStance(p).toUpperCase()}
                      </span>
                      <span className="mono" style={{ color: "var(--fg-4)" }}>T{p.tick}</span>
                      {p.is_fallback && <span className="badge s-warn">fallback</span>}
                    </div>
                    <p className="t-post mt-1" style={{ fontSize: 13 }}>{p.text}</p>
                    <div className="mono mt-1 flex flex-wrap gap-1.5 text-[11px]" style={{ color: "var(--fg-3)" }}>
                      {(p.cited_chunk_ids ?? []).map((c) => (
                        <span key={c} className="chip">SOURCES {pages[c] != null ? `p. ${pages[c]}` : ""} · {c.slice(0, 6)}</span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}
    </aside>
  );
}

function StanceHistoryCard({ series }: { series: Record<string, { tick: number; value: number }[]> }) {
  const rows = new Map<number, Record<string, number>>();
  for (const [issue, pts] of Object.entries(series)) {
    for (const pt of pts) {
      const r = rows.get(pt.tick) ?? { tick: pt.tick };
      r[issue] = pt.value;
      rows.set(pt.tick, r);
    }
  }
  const data = [...rows.values()].sort((x, y) => x.tick - y.tick);
  return (
    <ResponsiveContainer width="100%" height={140}>
      <LineChart data={data}>
        <CartesianGrid stroke="var(--line-1)" strokeDasharray="3 3" />
        <XAxis dataKey="tick" stroke="var(--fg-3)" fontSize={10} />
        <YAxis domain={[-1, 1]} stroke="var(--fg-3)" fontSize={10} ticks={[-1, 0, 1]} />
        <Tooltip contentStyle={{ background: "var(--bg-1)", border: "1px solid var(--line-2)", borderRadius: 6, fontSize: 11 }} />
        {Object.keys(series).map((issue, i) => (
          <Line key={issue} type="monotone" dataKey={issue}
                stroke={i === 0 ? "var(--ac)" : "var(--ev)"} strokeWidth={2} dot={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function AvatarChip({ handle, name }: { handle: string; name: string }) {
  const hue = hashHue(handle);
  return (
    <span
      className="mono flex-none place-items-center"
      style={{
        width: 34, height: 34, borderRadius: "var(--r-2)", display: "grid",
        fontSize: 11, fontWeight: 600, color: `hsl(${hue} 65% 72%)`,
        background: `hsl(${hue} 50% 16%)`, border: `1px solid hsl(${hue} 50% 30%)`,
      }}
      aria-hidden
    >
      {initials(name, handle)}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <p className="eyebrow mb-1.5">{title}</p>
      {children}
    </div>
  );
}
