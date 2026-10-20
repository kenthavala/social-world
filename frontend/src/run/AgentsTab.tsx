// Agents: roster with stance filter + search, and a detail drawer (stance history,
// traits, memories, knowledge, posts with evidence chips). Activity comes from the
// run's real posts; nothing here is invented.
import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { Agent, Post } from "../types";
import * as api from "../api";
import { Spinner } from "../common";
import { fetchChunk, initials, postOverallStance } from "./helpers";

const CLS = (v: number) => (v > 0.15 ? "pro" : v < -0.15 ? "con" : "neu");
const LABEL = (v: number) => (v > 0.15 ? "PRO" : v < -0.15 ? "CON" : "NEUTRAL");

function meanStance(a: Agent): number {
  const vals = Object.values(a.stances).map((s) => s.value);
  return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 0;
}

export default function AgentsTab({ runId, runSourceId, posts, bumpKey, onError }: {
  runId: string;
  runSourceId: string | null;
  posts: Post[];
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

  // activity derived from the run's posts: post count + last tick per agent
  const activity = useMemo(() => {
    const m = new Map<string, { n: number; lastTick: number }>();
    for (const p of posts) {
      const e = m.get(p.agent_id) ?? { n: 0, lastTick: 0 };
      e.n += 1;
      if (p.tick > e.lastTick) e.lastTick = p.tick;
      m.set(p.agent_id, e);
    }
    return m;
  }, [posts]);

  const shown = useMemo(() => {
    if (!agents) return [];
    let out = agents;
    if (filter !== "all") {
      out = out.filter((a) => CLS(meanStance(a)) === filter);
    }
    if (q.trim()) {
      const n = q.toLowerCase();
      out = out.filter((a) => a.name.toLowerCase().includes(n) || a.handle.toLowerCase().includes(n) || (a.group || "").toLowerCase().includes(n));
    }
    return out;
  }, [agents, filter, q]);

  if (!agents) return <Spinner label="Loading agents…" />;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {(["all", "pro", "neu", "con"] as const).map((f) => (
          <button
            key={f}
            className="chip"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {f !== "all" && <span className={`sg sg-${f}`} />}
            {f === "all" ? "All" : f.toUpperCase()}
            <span className="chip-n">{f === "all" ? agents.length : agents.filter((a) => CLS(meanStance(a)) === f).length}</span>
          </button>
        ))}
        <span className="input-wrap ml-auto max-w-64 flex-1">
          <Search className="ic-sm" aria-hidden />
          <input
            className="input"
            placeholder="Search name, @handle or group"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </span>
      </div>

      {agents.length === 0 ? (
        <div className="empty panel">
          <span className="empty-ic">
            <svg className="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
              <circle cx="6" cy="5.5" r="2.5" /><path d="M1.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4M10.5 3.2a2.5 2.5 0 0 1 0 4.6M12 9.8c1.5.5 2.5 1.8 2.5 3.7" />
            </svg>
          </span>
          <p className="t-h3">Not seeded yet</p>
          <p className="t-meta" style={{ maxWidth: 340 }}>
            Agents are generated when the run starts — seeding reads the world brief and samples
            personas per stakeholder group.
          </p>
        </div>
      ) : shown.length === 0 ? (
        <div className="empty panel">
          <p className="t-h3">No agents match</p>
          <p className="t-meta">Clear the search or the stance filter.</p>
        </div>
      ) : (
        <div className="panel overflow-hidden">
          {shown.map((a, i) => {
            const mean = meanStance(a);
            const act = activity.get(a.id);
            return (
              <button
                key={a.id}
                onClick={() => setSel(a.id)}
                className={`list-row ${sel === a.id ? "is-selected" : ""}`}
                style={{ borderBottom: i < shown.length - 1 ? "1px solid var(--line-1)" : 0 }}
              >
                <span className={`av av-sm av-${CLS(mean)}`} aria-hidden>{initials(a.name, a.handle)}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span style={{ fontWeight: 600 }}>{a.name}</span>
                    <span className={`stance stance-${CLS(mean)}`}>
                      <span className={`sg sg-${CLS(mean)}`} />{LABEL(mean)}
                    </span>
                  </span>
                  <span className="t-meta block" style={{ marginTop: 2 }}>
                    @{a.handle} · {a.group}{a.archetype ? ` · ${a.archetype}` : ""}
                  </span>
                </span>
                <span className="hidden flex-wrap justify-end gap-1 lg:flex">
                  {Object.entries(a.stances).slice(0, 3).map(([iss, st]) => (
                    <span key={iss} className={`badge st-${CLS(st.value)}`}>
                      {iss} {st.value > 0 ? "+" : ""}{st.value.toFixed(2)}
                    </span>
                  ))}
                </span>
                <span className="mono hidden w-24 text-right md:block" style={{ fontSize: 11.5, color: "var(--fg-3)" }}>
                  {act ? <>{act.n} post{act.n === 1 ? "" : "s"} · T{String(act.lastTick).padStart(2, "0")}</> : "no posts"}
                </span>
              </button>
            );
          })}
        </div>
      )}

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
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    api.getAgentDetail(runId, agentId).then(setDetail).catch((e) => {
      setDetail(null);
      onError(e);
    });
  }, [runId, agentId, bumpKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!detail || !runSourceId) return;
    const ids = new Set<string>();
    for (const p of detail.posts) (p.cited_chunk_ids ?? []).forEach((c) => ids.add(c));
    ids.forEach((id) => {
      fetchChunk(runSourceId, id).then((info) => {
        setPages((m) => ({ ...m, [id]: info.page }));
      }).catch(() => undefined);
    });
  }, [detail, runSourceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const a = detail?.agent;

  return (
    <>
      <button className="scrim" onClick={onClose} aria-label="Close agent details" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="ag-title">
        <div className="drawer-head">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="eyebrow">Agent</span>
            {a ? (
              <div className="flex items-center gap-3">
                <span className={`av av-${CLS(meanStance(a))}`} aria-hidden>{initials(a.name, a.handle)}</span>
                <div className="min-w-0">
                  <h2 id="ag-title" className="t-h2 truncate">{a.name}</h2>
                  <p className="t-meta">@{a.handle} · {a.group}{a.archetype ? ` · ${a.archetype}` : ""}</p>
                </div>
              </div>
            ) : (
              <h2 id="ag-title" className="t-h2">Loading…</h2>
            )}
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close agent details">
            <X size={15} />
          </button>
        </div>

        <div className="drawer-body">
          {!a || !detail ? (
            <Spinner label="Loading agent…" />
          ) : (
            <>
              {a.bio && <p className="t-body fg-2">{a.bio}</p>}

              <Section title="Stances now">
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(a.stances).map(([iss, st]) => (
                    <span key={iss} className={`badge st-${CLS(st.value)}`}>
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

              {a.belief_summary && <Section title="Self-described beliefs"><span className="t-body fg-2">{a.belief_summary}</span></Section>}

              {a.traits && Object.keys(a.traits).length > 0 && (
                <Section title="Traits">
                  <dl className="grid gap-1 text-xs sm:grid-cols-2">
                    {Object.entries(a.traits).map(([k, v]) => (
                      <div key={k} className="flex justify-between">
                        <dt className="capitalize" style={{ color: "var(--fg-3)" }}>{k}</dt>
                        <dd className="num m-0">{typeof v === "number" ? v.toFixed(2) : String(v)}</dd>
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
                        <dd className="num m-0">{typeof v === "number" ? v.toFixed(2) : String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                </Section>
              )}

              {detail.memories.length > 0 && (
                <Section title={`Memories — ${detail.memories.length}`}>
                  <ul className="flex list-none flex-col gap-1.5 p-0 text-xs">
                    {detail.memories.slice(0, 12).map((m, i) => (
                      <li key={i} className="panel-2 p-2">
                        <span className="mono" style={{ color: "var(--fg-4)" }}>T{m.tick}</span>{" "}
                        <span className="badge" style={{ fontSize: 10 }}>{m.kind}</span>{" "}
                        {m.text}
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {(a.knowledge ?? []).length > 0 && (
                <Section title={`Knowledge — ${a.knowledge.length} chunks`}>
                  <ul className="flex list-none flex-col gap-1 p-0 text-xs">
                    {a.knowledge.slice(0, 10).map((c, i) => {
                      const cid = typeof c === "string" ? c : String((c as { chunk_id?: string })?.chunk_id ?? c);
                      return <li key={i} className="mono" style={{ color: "var(--fg-3)" }}>{cid}</li>;
                    })}
                  </ul>
                </Section>
              )}

              <Section title={`Posts — ${detail.posts.length}`}>
                {detail.posts.length === 0 ? (
                  <p className="t-meta">Nothing posted yet.</p>
                ) : (
                  <ul className="flex list-none flex-col gap-2 p-0">
                    {detail.posts.map((p: Post) => (
                      <li key={p.id} className="panel-2 p-2.5">
                        <div className="flex items-center gap-2 text-xs">
                          <span className={`stance stance-${postOverallStance(p)}`}>
                            <span className={`sg sg-${postOverallStance(p)}`} />{postOverallStance(p).toUpperCase()}
                          </span>
                          <span className="mono" style={{ color: "var(--fg-4)" }}>T{String(p.tick).padStart(2, "0")}</span>
                          {p.is_fallback && <span className="badge s-warn">fallback</span>}
                          <span className="mono ml-auto" style={{ color: "var(--fg-4)", fontSize: 11 }}>
                            ♥ {p.likes} · ↻ {p.reposts} · ↩ {p.replies}
                          </span>
                        </div>
                        <p className="t-post mt-1.5" style={{ fontSize: 13 }}>{p.text}</p>
                        {(p.cited_chunk_ids ?? []).length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {p.cited_chunk_ids.map((c) => (
                              <span key={c} className="cite" style={{ cursor: "default" }}>
                                {pages[c] != null && <><span className="cite-p">p. {pages[c]}</span><span className="cite-sep">·</span></>}
                                <span>{c.length > 10 ? c.slice(0, 10) : c}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </>
          )}
        </div>
      </aside>
    </>
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
                stroke={i === 0 ? "var(--accent)" : "var(--evt)"} strokeWidth={2} dot={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="eyebrow mb-1.5">{title}</p>
      {children}
    </div>
  );
}
