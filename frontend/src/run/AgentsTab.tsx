// Agents: roster with stance filter + search, and a detail drawer (stance history,
// traits, memories, knowledge, posts with evidence chips). Activity comes from the
// run's real posts; nothing here is invented.
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { Agent, Post } from "../types";
import * as api from "../api";
import { Spinner, useFocusTrap } from "../common";
import { fetchChunk, initials, postOverallStance } from "./helpers";

const CLS = (v: number) => (v > 0.15 ? "pro" : v < -0.15 ? "con" : "neu");
const LABEL = (v: number) => (v > 0.15 ? "PRO" : v < -0.15 ? "CON" : "NEUTRAL");

function meanStance(a: Agent): number {
  const vals = Object.values(a.stances).map((s) => s.value);
  return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 0;
}

export default function AgentsTab({ runId, runSourceId, posts, bumpKey, onError, roundFilter }: {
  runId: string;
  runSourceId: string | null;
  posts: Post[];
  bumpKey: number;
  onError: (e: unknown) => void;
  roundFilter?: number | null;
}) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "pro" | "neu" | "con">("all");
  const [groupFilter, setGroupFilter] = useState("all");
  const [issueFilter, setIssueFilter] = useState("all");
  const [influenceFilter, setInfluenceFilter] = useState("all");
  const [activityFilter, setActivityFilter] = useState<"all" | "active" | "silent">("all");
  const [sort, setSort] = useState<"stance" | "activity" | "influence" | "name">("influence");

  useEffect(() => {
    api.listAgents(runId).then((a) => setAgents(a.agents)).catch((e) => onError(e));
  }, [runId, bumpKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // activity derived from the run's posts: post count + last tick per agent
  const activity = useMemo(() => {
    const m = new Map<string, { n: number; lastTick: number }>();
    for (const p of posts) {
      if (roundFilter != null && p.tick > roundFilter) continue;
      const e = m.get(p.agent_id) ?? { n: 0, lastTick: 0 };
      e.n += 1;
      if (p.tick > e.lastTick) e.lastTick = p.tick;
      m.set(p.agent_id, e);
    }
    return m;
  }, [posts, roundFilter]);

  const shown = useMemo(() => {
    if (!agents) return [];
    let out = agents;
    if (filter !== "all") {
      out = out.filter((a) => CLS(meanStance(a)) === filter);
    }
    if (groupFilter !== "all") {
      out = out.filter((a) => (a.group || "") === groupFilter);
    }
    if (issueFilter !== "all") {
      out = out.filter((a) => a.stances[issueFilter] !== undefined);
    }
    if (influenceFilter !== "all") {
      const [lo, hi] = influenceFilter.split("-").map(Number);
      out = out.filter((a) => {
        const inf = a.influence ?? 0;
        return inf >= lo && (hi === undefined || inf <= hi);
      });
    }
    if (activityFilter !== "all") {
      out = out.filter((a) => {
        const n = activity.get(a.id)?.n ?? 0;
        return activityFilter === "active" ? n > 0 : n === 0;
      });
    }
    if (q.trim()) {
      const n = q.toLowerCase();
      out = out.filter((a) => a.name.toLowerCase().includes(n) || a.handle.toLowerCase().includes(n) || (a.group || "").toLowerCase().includes(n));
    }
    const sorted = [...out];
    sorted.sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "activity") {
        return (activity.get(b.id)?.n ?? 0) - (activity.get(a.id)?.n ?? 0);
      }
      if (sort === "influence") {
        return (b.influence ?? 0) - (a.influence ?? 0);
      }
      return meanStance(b) - meanStance(a);
    });
    return sorted;
  }, [agents, filter, groupFilter, issueFilter, influenceFilter, activityFilter, q, sort, activity]);

  const groupOptions = useMemo(
    () => (agents ? [...new Set(agents.map((a) => a.group).filter(Boolean))].sort() : []),
    [agents]);
  const issueOptions = useMemo(() => {
    const ids = new Set<string>();
    (agents ?? []).forEach((a) => Object.keys(a.stances).forEach((i) => ids.add(i)));
    return [...ids].sort();
  }, [agents]);

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
          <Search className="ic" aria-hidden />
          <input
            className="input"
            placeholder="Search name, @handle or group"
            aria-label="Search agents"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </span>
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="field" style={{ minWidth: 140 }}>
          <span className="label">Stakeholder group</span>
          <select className="input" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
            <option value="all">All groups</option>
            {groupOptions.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </label>
        <label className="field" style={{ minWidth: 120 }}>
          <span className="label">Issue</span>
          <select className="input" value={issueFilter} onChange={(e) => setIssueFilter(e.target.value)}>
            <option value="all">All issues</option>
            {issueOptions.map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
        </label>
        <label className="field" style={{ minWidth: 130 }}>
          <span className="label">Influence</span>
          <select className="input" value={influenceFilter} onChange={(e) => setInfluenceFilter(e.target.value)}>
            <option value="all">Any</option>
            <option value="0-2">Low (0–2)</option>
            <option value="2-4">Medium (2–4)</option>
            <option value="4-10">High (4+)</option>
          </select>
        </label>
        <label className="field" style={{ minWidth: 120 }}>
          <span className="label">Activity</span>
          <select className="input" value={activityFilter}
                  onChange={(e) => setActivityFilter(e.target.value as typeof activityFilter)}>
            <option value="all">Any</option>
            <option value="active">Posted</option>
            <option value="silent">Never posted</option>
          </select>
        </label>
        <label className="field" style={{ minWidth: 130 }}>
          <span className="label">Sort by</span>
          <select className="input" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="influence">Influence</option>
            <option value="activity">Posting activity</option>
            <option value="stance">Current stance</option>
            <option value="name">Name</option>
          </select>
        </label>
        <span className="t-meta ml-auto">{shown.length} of {agents.length} agents</span>
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
                  {act ? <>{act.n} post{act.n === 1 ? "" : "s"} · R{String(act.lastTick).padStart(2, "0")}</> : "no posts"}
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
          roundFilter={roundFilter}
          onClose={() => setSel(null)}
          onError={onError}
          bumpKey={bumpKey}
        />
      )}
    </div>
  );
}

function AgentDrawer({ runId, agentId, runSourceId, onClose, onError, bumpKey, roundFilter }: {
  runId: string;
  agentId: string;
  runSourceId: string | null;
  onClose: () => void;
  onError: (e: unknown) => void;
  bumpKey: number;
  roundFilter?: number | null;
}) {
  const [detail, setDetail] = useState<api.AgentDetail | null>(null);
  const [pages, setPages] = useState<Record<string, number | null>>({});
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(ref, onClose);

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
  const visiblePosts = detail
    ? (roundFilter != null ? detail.posts.filter((p) => p.tick <= roundFilter) : detail.posts)
    : [];

  return (
    <>
      <button className="scrim" onClick={onClose} aria-label="Close agent details" />
      <aside className="drawer" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="ag-title">
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

              <AgentExplanation agent={a} detail={detail} />

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
                  <StanceHistoryCard series={detail.stance_history} maxTick={roundFilter ?? undefined} />
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
                        <span className="mono" style={{ color: "var(--fg-3)" }}>R{m.tick}</span>{" "}
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

              <Section title={`Posts — ${visiblePosts.length}${roundFilter != null ? ` up to round ${roundFilter}` : ""}`}>
                {visiblePosts.length === 0 ? (
                  <p className="t-meta">Nothing posted yet.</p>
                ) : (
                  <ul className="flex list-none flex-col gap-2 p-0">
                    {visiblePosts.map((p: Post) => (
                      <li key={p.id} className="panel-2 p-2.5">
                        <div className="flex items-center gap-2 text-xs">
                          <span className={`stance stance-${postOverallStance(p)}`}>
                            <span className={`sg sg-${postOverallStance(p)}`} />{postOverallStance(p).toUpperCase()}
                          </span>
                          <span className="mono" style={{ color: "var(--fg-3)" }}>R{String(p.tick).padStart(2, "0")}</span>
                          {Boolean(p.is_fallback) && <span className="badge s-warn">fallback</span>}
                          <span className="mono ml-auto" style={{ color: "var(--fg-3)", fontSize: 11 }}>
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

function StanceHistoryCard({ series, maxTick }: {
  series: Record<string, { tick: number; value: number }[]>;
  maxTick?: number;
}) {
  const rows = new Map<number, Record<string, number>>();
  for (const [issue, pts] of Object.entries(series)) {
    for (const pt of pts) {
      if (maxTick != null && pt.tick > maxTick) continue;
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
                stroke={i === 0 ? "var(--accent)" : i === 1 ? "var(--accent-fg)" : "var(--neu)"}
                strokeWidth={2} dot={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function AgentExplanation({ agent, detail }: { agent: Agent; detail: api.AgentDetail }) {
  // Everything below is read from the recorded stance series and posts; the
  // sentences are assembled from those facts, never generated.
  const rows = Object.entries(detail.stance_history ?? {}).map(([issue, pts]) => {
    const first = pts[0]?.value ?? 0;
    const last = pts[pts.length - 1]?.value ?? 0;
    return { issue, first, last, delta: last - first };
  });
  const movers = rows.filter((r) => Math.abs(r.delta) >= 0.1)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const mean = meanStance(agent);
  const posts = detail.posts.length;
  const cited = new Set(detail.posts.flatMap((p) => p.cited_chunk_ids ?? [])).size;
  const influence = agent.influence;

  return (
    <div className="panel-2 p-3.5" style={{ borderLeft: "3px solid var(--accent)" }}>
      <div className="eyebrow">Reading this agent</div>
      <p className="t-body mt-1">
        {agent.name} represents <strong>{agent.group}</strong>
        {agent.group_description ? ` (${agent.group_description})` : ""}
        {influence != null ? `, with configured influence ${influence}` : ""}. Their current
        average position is <strong>{mean.toFixed(2)}</strong> on the −1…+1 stance scale.
      </p>
      {movers.length === 0 ? (
        <p className="t-body fg-2 mt-1">
          Their position did not move by 0.10 or more on any issue, so the record does not
          support an explanation of change — they were stable across the run.
        </p>
      ) : (
        <p className="t-body fg-2 mt-1">
          They moved most on <strong>{movers[0].issue}</strong>, from{" "}
          {movers[0].first.toFixed(2)} to {movers[0].last.toFixed(2)} (
          {movers[0].delta > 0 ? "+" : ""}{movers[0].delta.toFixed(2)})
          {movers.length > 1
            ? `, with smaller shifts on ${movers.slice(1, 3).map((m) => m.issue).join(" and ")}.`
            : "."}
        </p>
      )}
      <p className="t-body fg-2 mt-1">
        They wrote {posts} post{posts === 1 ? "" : "s"}
        {cited > 0 ? ` citing ${cited} distinct source passage${cited === 1 ? "" : "s"}` : " with no recorded citation"}
        {detail.memories?.length
          ? `, and hold ${detail.memories.length} recorded memory item${detail.memories.length === 1 ? "" : "s"}.`
          : "."}
      </p>
      <p className="t-meta mt-1">
        The simulation records stance changes with their trigger where the engine attributed one;
        it does not record why an unattributed change happened, so none is claimed here.
      </p>
    </div>
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
