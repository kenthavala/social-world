// Home: what OASIS is, what a simulation is, how to start, and what already exists.
// The active run gets the tick ruler; everything else is a clean library view.
import { useEffect, useMemo, useState } from "react";
import { Plus, Upload } from "lucide-react";
import type { Post, Provider, RunDetail, RunListItem, SourceStats } from "./types";
import * as api from "./api";
import { Spinner, StatusBadge } from "./common";
import { buildRuler, initials, postOverallStance, rulerSegs } from "./run/helpers";
import { sourceBadgeClass, sourceStatusMeta } from "./status";

const HOW = [
  ["01", "Source", "Upload a document"],
  ["02", "Brief", "Frame the scenario"],
  ["03", "Agents", "Set population & stances"],
  ["04", "Run", "Watch it unfold"],
];

function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (h < 24 && d.getDate() === new Date().getDate()) return `today ${time}`;
  const y = new Date(Date.now() - 86400000);
  if (d.getDate() === y.getDate() && d.getMonth() === y.getMonth()) return `yesterday ${time}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + `, ${time}`;
}

export default function HomePage({ onNew, onOpen, onError, settingsVersion }: {
  onNew: () => void;
  onOpen: (runId: string) => void;
  onError: (e: unknown) => void;
  settingsVersion: number;
}) {
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [docs, setDocs] = useState<SourceStats[] | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [active, setActive] = useState<{ run: RunDetail; posts: Post[] } | null>(null);

  useEffect(() => {
    api.listRuns().then((r) => setRuns(r.runs)).catch((e) => {
      setRuns([]);
      onError(e);
    });
    api.listSources().then((r) => setDocs(r.sources)).catch(() => setDocs([]));
    api.getHealth().then((h) => setProvider(h.provider)).catch(() => setProvider(null));
    api.getSettings().then((r) => setSettings(r.settings)).catch(() => setSettings(null));
    api.listProviders().then((r) => setProviders(r.providers)).catch(() => setProviders(null));
  }, [onError, settingsVersion]);

  // Poll the run list while something is live, so Home never shows a stale tick.
  const liveId = runs?.find((r) => ["running", "seeding", "paused"].includes(r.status))?.id ?? null;
  useEffect(() => {
    if (!liveId) return;
    const t = window.setInterval(() => {
      api.listRuns().then((r) => setRuns(r.runs)).catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(t);
  }, [liveId]);

  // the active run: its real detail + posts for the tick ruler
  useEffect(() => {
    const live = runs?.find((r) => ["running", "seeding", "paused"].includes(r.status));
    if (!live) { setActive(null); return; }
    let alive = true;
    Promise.all([api.getRun(live.id), api.listPosts(live.id, { limit: 500 })])
      .then(([run, p]) => { if (alive) setActive({ run, posts: p.posts }); })
      .catch(() => { if (alive) setActive(null); });
    return () => { alive = false; };
  }, [runs]);

  // keyboard shortcut: N → new simulation (outside inputs)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.metaKey || e.ctrlKey) return;
      if (e.key.toLowerCase() === "n") { e.preventDefault(); onNew(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNew]);

  const recentSims = runs?.slice(0, 5) ?? [];
  const recentDocs = docs?.slice(0, 4) ?? [];
  const model = String(settings?.llm_model ?? "") || null;
  const currentProvider = providers?.find((p) => p.name === provider) ?? null;
  const keyOk = provider === "mock" ? true : currentProvider ? currentProvider.has_key : null;
  const rpm = settings?.llm_rpm;
  const timeout = settings?.llm_timeout_seconds;
  const latestPost = active && active.posts.length > 0 ? active.posts[active.posts.length - 1] : null;
  const latestStance = latestPost ? postOverallStance(latestPost) : "neu";
  const activity = useMemo(
    () => (runs ?? []).slice(0, 5).map((r) => ({
      id: r.id, name: r.name, status: r.status, at: r.created_at,
      ticks: `${r.ticks_done}/${r.ticks_total || "—"}`,
    })), [runs]);

  const totalTicks = active?.run.config?.ticks ?? 1;
  const rawTick = active ? (active.run.current_tick || active.run.last_completed_tick || 0) : 0;
  const currentTick = active ? Math.min(Math.max(rawTick, 0), Math.max(1, totalTicks)) : 0;
  // Only a run that has actually entered a tick gets the in-progress marker.
  const rulerHighlight = active && rawTick > 0 && ["running", "seeding", "paused"].includes(active.run.status)
    ? currentTick
    : 0;
  const ruler = active ? buildRuler(active.posts, totalTicks, rulerHighlight) : [];

  const today = new Date().toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });

  return (
    <main>
      {/* page header */}
      <header className="flex flex-wrap items-center justify-between gap-4 pt-6" style={{ minHeight: 56 }}>
        <div className="flex items-center gap-2.5">
          <span className="t-h3">Home</span>
          <span className="t-meta">{today}</span>
        </div>
        <div className="flex items-center gap-2">
          <a className="btn" href="#/documents">
            <Upload size={14} /> Upload document
          </a>
          <button className="btn btn-primary" onClick={onNew}>
            <Plus size={15} strokeWidth={1.75} /> New simulation <span className="kbd">N</span>
          </button>
        </div>
      </header>

      <div className="flex flex-col gap-6 pb-4 pt-6">
        {/* intro */}
        <section className="flex flex-wrap items-end justify-between gap-x-12 gap-y-6">
          <div className="min-w-0 flex-[999_1_480px]">
            <span className="eyebrow">Simulation lab</span>
            <h1 className="t-display mt-2" style={{ maxWidth: 640, textWrap: "balance" }}>
              Simulate how people respond to a document — post by post, tick by tick.
            </h1>
            <p className="t-body fg-2 mt-2.5" style={{ maxWidth: 620 }}>
              Upload a source document, brief a population of agents and run it. Every generated
              post links back to the page and chunk it drew from.
            </p>
          </div>
          <ol aria-label="How a simulation is built"
              className="m-0 grid list-none grid-cols-2 p-0 sm:grid-cols-4"
              style={{ flex: "1 1 420px", border: "1px solid var(--line-1)", borderRadius: "var(--r-2)", background: "var(--bg-1)" }}>
            {HOW.map(([n, t, sub], i) => (
              <li key={n} className="flex flex-col gap-1 px-3.5 py-3"
                  style={{ borderRight: i < 3 ? "1px solid var(--line-1)" : undefined, borderTop: i >= 2 ? "1px solid var(--line-1)" : undefined }}>
                <span className="t-id">{n}</span>
                <span style={{ fontWeight: 500 }}>{t}</span>
                <span className="t-meta">{sub}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* active run */}
        {active && (
          <section className="panel" aria-labelledby="active-run-title">
            <div className="panel-head flex-wrap" style={{ minHeight: 56, padding: "10px 20px" }}>
              <div className="flex min-w-0 flex-wrap items-center gap-3">
                <StatusBadge status={active.run.status} />
                <button id="active-run-title" className="t-h2 row-link truncate" onClick={() => onOpen(active.run.id)}>
                  {active.run.name}
                </button>
                <span className="t-id">{active.run.id}</span>
              </div>
              <button className="btn" onClick={() => onOpen(active.run.id)}>
                Open live view
                <svg className="ic-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 3.5 10.5 8 6 12.5" /></svg>
              </button>
            </div>
            <div className="flex flex-wrap gap-x-10 gap-y-4 p-5">
              <div className="flex min-w-0 flex-[999_1_480px] flex-col gap-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-4">
                  <div className="flex items-baseline gap-2.5">
                    <span className="eyebrow">Tick</span>
                    <span className="stat-v" style={{ fontSize: 26, lineHeight: "30px" }}>
                      {String(currentTick).padStart(2, "0")}
                      <span className="of"> / {active.run.config?.ticks ?? "—"}</span>
                    </span>
                    <span className="t-meta">{active.run.status === "running" ? "in progress" : active.run.status}</span>
                  </div>
                  <div className="t-meta flex items-center gap-3.5">
                    <span className="inline-flex items-center gap-1.5"><span className="sg sg-pro" />PRO</span>
                    <span className="inline-flex items-center gap-1.5"><span className="sg sg-neu" />NEUTRAL</span>
                    <span className="inline-flex items-center gap-1.5"><span className="sg sg-con" />CON</span>
                  </div>
                </div>
                <div>
                  <div className="ruler" style={{ height: 36 }} role="img"
                       aria-label={`Posts per tick by stance, ${active.posts.length} posts so far`}>
                    {ruler.map((t) => (
                      <div key={t.n} className={t.cls} title={t.tip}>
                        {rulerSegs(t).map((s, i) => <i key={i} className={s.cls} style={{ height: `${s.h}%` }} />)}
                      </div>
                    ))}
                  </div>
                  <div className="ruler-axis" aria-hidden>
                    {ruler.map((t) => <span key={t.n} className={t.axCls}>{t.ax}</span>)}
                  </div>
                </div>
              </div>
              <dl className="m-0 grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4" style={{ flex: "1 1 280px" }}>
                <div className="stat"><dt className="eyebrow">Posts</dt><dd className="stat-v m-0">{active.run.posts}</dd></div>
                <div className="stat"><dt className="eyebrow">Agents</dt><dd className="stat-v m-0">{active.run.agents}</dd></div>
                <div className="stat"><dt className="eyebrow">LLM calls</dt><dd className="stat-v m-0">{active.run.llm_calls_used}</dd></div>
                <div className="stat"><dt className="eyebrow">Budget</dt><dd className="stat-v m-0">{active.run.max_llm_calls ?? "—"}</dd></div>
              </dl>
            </div>
            <div className="flex flex-wrap items-center gap-2.5 px-5 py-3" style={{ borderTop: "1px solid var(--line-1)" }}>
              <span className="eyebrow">Latest</span>
              {latestPost ? (
                <>
                  <span className={`av av-xs av-${latestStance}`} aria-hidden>{initials(latestPost.name, latestPost.handle)}</span>
                  <span style={{ fontWeight: 600 }}>{latestPost.name ?? latestPost.agent_id}</span>
                  <span className={`stance stance-${latestStance}`}>
                    <span className={`sg sg-${latestStance}`} />
                    {latestStance === "pro" ? "PRO" : latestStance === "con" ? "CON" : "NEUTRAL"}
                  </span>
                  <span className="t-body fg-2 ellipsis" style={{ flex: "1 1 280px", minWidth: 0 }}>
                    “{latestPost.text}”
                  </span>
                  <span className="post-time"><span className="tk-n">T{String(latestPost.tick).padStart(2, "0")}</span></span>
                </>
              ) : (
                <span className="t-meta">No posts yet — agents are seeding or waiting for the first tick.</span>
              )}
            </div>
          </section>
        )}

        {/* two columns */}
        <div className="flex flex-wrap items-start gap-6">
          <div className="flex min-w-0 flex-[999_1_600px] flex-col gap-6">
            <section className="panel" aria-labelledby="recent-sims">
              <div className="panel-head">
                <h2 id="recent-sims" className="t-h3">Recent simulations</h2>
                <a className="btn btn-ghost btn-sm" href="#/simulations">View all {runs?.length ?? 0}</a>
              </div>
              {runs === null ? (
                <div className="panel-body"><Spinner label="Loading runs…" /></div>
              ) : recentSims.length === 0 ? (
                <div className="empty" style={{ padding: "40px 24px" }}>
                  <span className="empty-ic"><Plus size={20} /></span>
                  <p className="t-h3">No simulations yet</p>
                  <p className="t-meta" style={{ maxWidth: 320 }}>Create your first simulation from a PDF — the wizard walks through source, brief, agents and run.</p>
                  <button className="btn btn-primary" onClick={onNew}><Plus size={14} /> New simulation</button>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Simulation</th>
                        <th>Status</th>
                        <th>Last run</th>
                        <th className="r">Ticks</th>
                        <th className="r">LLM calls</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentSims.map((s) => (
                        <tr key={s.id} onClick={() => onOpen(s.id)} style={{ cursor: "pointer" }}>
                          <td style={{ maxWidth: 320 }}>
                            <div className="flex min-w-0 flex-col gap-1">
                              <span className="row-link ellipsis">{s.name}</span>
                              <span className="t-meta ellipsis">{s.source ?? "no source document"}</span>
                            </div>
                          </td>
                          <td><StatusBadge status={s.status} /></td>
                          <td>
                            <div className="flex flex-col gap-0.5">
                              <span style={{ fontSize: 12.5 }}>{relTime(s.created_at)}</span>
                              <span className="t-id">{s.id}</span>
                            </div>
                          </td>
                          <td className="r mono num" style={{ fontSize: 12.5 }}>{s.ticks_done}/{s.ticks_total || "—"}</td>
                          <td className="r mono num" style={{ fontSize: 12.5 }}>{s.llm_calls_used}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

          </div>

          {/* right rail */}
          <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-6">
            <section className="panel" aria-labelledby="provider-h">
              <div className="panel-head">
                <h2 id="provider-h" className="t-h3">Provider</h2>
                {provider && (
                  <span className={`status ${provider === "mock" ? "status-paused" : keyOk === false ? "status-draft" : "status-queued"}`}>
                    <span className="dot" />
                    {provider === "mock" ? "Mock" : keyOk === false ? "No key" : "Configured"}
                  </span>
                )}
              </div>
              <div className="panel-body flex flex-col gap-3">
                <dl className="kv m-0" style={{ gridTemplateColumns: "76px minmax(0,1fr)" }}>
                  <dt>Provider</dt><dd>{provider ?? "checking…"}</dd>
                  <dt>Model</dt>
                  <dd className="mono" style={{ fontSize: 12.5 }}>
                    {provider === "mock" ? "not used by mock" : model ?? "—"}
                  </dd>
                  <dt>API key</dt>
                  <dd>{provider === "mock" ? "not required" : keyOk === null ? "checking…" : keyOk ? "set" : "missing"}</dd>
                  <dt>Rate</dt>
                  <dd className="mono">{rpm != null && rpm !== "" ? `${rpm}/min` : "provider default"}</dd>
                  <dt>Timeout</dt>
                  <dd className="mono">{timeout != null ? `${timeout}s` : "—"}</dd>
                </dl>
                <a className="btn btn-sm self-start" href="#/settings">Provider settings</a>
              </div>
            </section>

            <section className="panel" aria-labelledby="docs-h">
              <div className="panel-head">
                <h2 id="docs-h" className="t-h3">Documents</h2>
                <a className="btn btn-ghost btn-sm" href="#/documents">Library</a>
              </div>
              {docs === null ? null : recentDocs.length === 0 ? (
                <p className="t-meta panel-body">No documents yet — upload a source document to begin.</p>
              ) : (
                <div>
                  {recentDocs.map((d) => (
                    <a key={d.source_id} className="list-row" href="#/documents" style={{ alignItems: "flex-start" }}>
                      <svg className="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ color: "var(--fg-3)", marginTop: 2 }}>
                        <path d="M4 1.5h5.5L13 5v9.5H4z" /><path d="M9.5 1.5V5H13" />
                      </svg>
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="ellipsis" style={{ fontWeight: 500 }}>{d.filename}</span>
                        <span className="t-meta flex items-center gap-2">
                          <span
                            className={`badge ${sourceBadgeClass(sourceStatusMeta(d.status).tone)}`}
                            style={{ fontSize: 10 }}
                            title={`${sourceStatusMeta(d.status).detail} Backend status: ${d.status}`}
                          >
                            {sourceStatusMeta(d.status).label}
                          </span>
                          <span className="mono">
                            {d.pages} pp{d.chunks != null ? ` · ${d.chunks} chunks` : ""}
                          </span>
                        </span>
                      </span>
                    </a>
                  ))}
                </div>
              )}
            </section>

            <section className="panel" aria-labelledby="activity-h">
              <div className="panel-head">
                <h2 id="activity-h" className="t-h3">Latest activity</h2>
              </div>
              {activity.length === 0 ? (
                <p className="t-meta panel-body">Nothing yet — activity from your runs shows up here.</p>
              ) : (
                <ol className="m-0 list-none p-0 py-2">
                  {activity.map((a) => (
                    <li key={a.id} className="grid items-start px-4 py-2" style={{ gridTemplateColumns: "58px 14px minmax(0,1fr)", gap: 10 }}>
                      <span className="t-id" style={{ paddingTop: 2 }}>{relTime(a.at).replace(/^today /, "").replace(/^yesterday /, "yest. ")}</span>
                      <span className={`dot ${a.status === "completed" ? "dot-ok" : ["running", "seeding"].includes(a.status) ? "dot-run" : a.status === "failed" ? "dot-err" : "dot-idle"}`} style={{ marginTop: 6 }} />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <button className="ellipsis text-left" style={{ fontSize: 13, background: "none", border: 0, padding: 0, cursor: "pointer", color: "var(--fg-1)" }} onClick={() => onOpen(a.id)}>
                          {a.name}
                        </button>
                        <span className="t-meta">{a.status} · tick {a.ticks}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
