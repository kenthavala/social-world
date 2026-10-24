// Run room: run header (actions, provenance, ruler), four tabs (Feed, Agents,
// Connections, Findings), intervention composer and run-details drawers.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpCircle, ChevronLeft, ChevronRight, Download, Info, Pause, Play, Square, X, Zap,
} from "lucide-react";
import type { Agent, Post, RunDetail } from "../types";
import * as api from "../api";
import { MockStripe, Spinner, StatusBadge, useFocusTrap } from "../common";
import { useRunStream, usePosts, useRunDetail } from "../hooks";
import { useIsMobile } from "../shell";
import { navigate } from "../router";
import {
  RUN_TABS, buildRuler, normalizeTab, prefetchChunks, rulerSegs, type RunTabKey,
} from "./helpers";
import LiveTab from "./LiveTab";
import EventsTab from "./EventsTab";
import RunDetails from "./RunDetails";
// Chart/graph-heavy tabs load on first use so the main bundle stays small.
const AgentsTab = lazy(() => import("./AgentsTab"));
const NetworkTab = lazy(() => import("./NetworkTab"));
const AnalysisTab = lazy(() => import("./AnalysisTab"));
const QualityTab = lazy(() => import("./QualityTab"));

const TAB_STORE = "tsw-run-tab";

export default function RunPage({ runId, onBack, onError, sourceId, postId }: {
  runId: string;
  onBack: () => void;
  onError: (e: unknown) => void;
  sourceId?: string;
  postId?: string;
}) {
  const [tab, setTab] = useState<RunTabKey>(() => {
    try { return normalizeTab(sessionStorage.getItem(TAB_STORE)); } catch { return "live"; }
  });
  const [busy, setBusy] = useState(false);
  const [bump, setBump] = useState(0);
  const [selectedRound, setSelectedRound] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [interveneOpen, setInterveneOpen] = useState(false);
  const bumpRef = useRef(0);

  const changeTab = (t: RunTabKey) => {
    setTab(t);
    try { sessionStorage.setItem(TAB_STORE, t); } catch { /* ignore */ }
  };

  const { run, reload: reloadRun } = useRunDetail(runId, bump);
  const { posts, reload: reloadPosts } = usePosts(runId, bump);

  const headerRef = useRef<HTMLDivElement>(null);
  const [headerH, setHeaderH] = useState(0);
  const isMobile = useIsMobile();
  useEffect(() => {
    const el = headerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setHeaderH(el.offsetHeight));
    ro.observe(el);
    setHeaderH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  const pendingBump = useRef<number | null>(null);
  const onEvent = useCallback(() => {
    if (pendingBump.current != null) return;
    pendingBump.current = window.setTimeout(() => {
      pendingBump.current = null;
      bumpRef.current += 1;
      setBump(bumpRef.current);
    }, 350);
  }, []);
  useEffect(() => () => {
    if (pendingBump.current != null) window.clearTimeout(pendingBump.current);
  }, []);
  const { connected } = useRunStream(runId, onEvent);

  useEffect(() => {
    void reloadRun();
    void reloadPosts();
    try {
      if (sessionStorage.getItem("tsw-autostart") === runId) {
        sessionStorage.removeItem("tsw-autostart");
        void api.startRun(runId).catch((e) => onError(e));
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useEffect(() => {
    setSelectedRound(null);
    setPlaying(false);
  }, [runId]);

  const elapsed = useMemo(() => {
    if (!run || !run.started_at) return "Not recorded";
    const from = new Date(run.started_at).getTime();
    const to = run.finished_at ? new Date(run.finished_at).getTime()
      : ["running", "seeding", "paused"].includes(run.status) ? Date.now() : null;
    if (!from) return "—";
    const end = to ?? Date.now();
    const s = Math.max(0, Math.round((end - from) / 1000));
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, [run, connected]);

  async function raiseBudget() {
    setBusy(true);
    onError(null);
    try {
      await api.raiseBudget(runId, (run?.max_llm_calls ?? 0) + 25);
      await reloadRun();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function action(kind: "start" | "pause" | "resume" | "stop") {
    setBusy(true);
    onError(null);
    try {
      if (kind === "start") await api.startRun(runId);
      if (kind === "pause") await api.pauseRun(runId);
      if (kind === "resume") await api.resumeRun(runId);
      if (kind === "stop") await api.stopRun(runId);
      await reloadRun();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (run?.source_id && posts.length) prefetchChunks(run.source_id, posts);
  }, [run?.source_id, posts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalTicks = run?.config?.ticks ?? 0;
  const isActive = !!run && ["running", "seeding", "paused"].includes(run.status);
  const clampTick = (t: number) => Math.min(Math.max(t || 0, 1), Math.max(1, totalTicks));
  const displayTick = run && (isActive || (run.last_completed_tick || 0) > 0)
    ? clampTick(run.current_tick || run.last_completed_tick) : 0;
  const highlightTick = isActive ? displayTick : 0;
  const scrubbable = Math.min(totalTicks, Math.max(run?.last_completed_tick || 0,
    !isActive && run?.status === "completed" ? totalTicks : 0));
  const ruler = useMemo(
    () => buildRuler(posts, totalTicks, highlightTick, selectedRound),
    [posts, totalTicks, highlightTick, selectedRound]);

  useEffect(() => {
    if (!playing) return;
    if (scrubbable < 1) { setPlaying(false); return; }
    const t = window.setInterval(() => {
      setSelectedRound((prev) => {
        const cur = prev ?? 0;
        if (cur >= scrubbable) {
          setPlaying(false);
          return prev;
        }
        return cur + 1;
      });
    }, 900);
    return () => window.clearInterval(t);
  }, [playing, scrubbable]);

  if (!run) return <div className="px-8 py-6"><Spinner label="Loading run…" /></div>;

  const agentCount = run.agents;
  const canControl = ["draft", "ready", "running", "seeding", "paused", "interrupted"].includes(run.status);
  const canIntervene = canControl || ["completed", "failed"].includes(run.status);
  const budgetPaused = run.status === "paused" && /budget/i.test(run.error?.message ?? "");
  const healthVal = run.error ? "error"
    : run.status === "paused" ? "paused"
    : isActive ? (connected ? "live" : "retry")
    : run.status === "completed" ? "done"
    : run.status === "interrupted" ? "stopped"
    : "idle";
  const healthDot = run.error ? "dot-err"
    : run.status === "paused" ? "dot-warn"
    : isActive ? (connected ? "dot-run" : "dot-warn")
    : run.status === "completed" ? "dot-ok"
    : run.status === "interrupted" ? "dot-warn"
    : "dot-idle";
  const healthSub = run.error ? "see Run details"
    : run.status === "completed" ? "run finished"
    : run.status === "paused" ? "resumes from here"
    : null;
  const shownRound = selectedRound ?? displayTick;
  const tickNote = selectedRound != null
    ? `viewing round ${String(selectedRound).padStart(2, "0")}`
    : run.status === "running" ? "in progress"
    : run.status === "completed" ? "complete"
    : run.status === "paused" ? "paused — calls in flight finish first"
    : ["interrupted", "failed"].includes(run.status) ? `stopped at round ${String(run.last_completed_tick).padStart(2, "0")}`
    : run.status;

  const compare = run.parent_run_id
    ? { href: `#/compare?a=${encodeURIComponent(run.parent_run_id)}&b=${encodeURIComponent(run.id)}`, label: "Compare with original" }
    : run.children && run.children.length > 0
      ? { href: `#/compare?a=${encodeURIComponent(run.id)}&b=${encodeURIComponent(run.children[0].id)}`, label: "Compare intervention" }
      : null;

  return (
    <div>
      <div ref={headerRef} className="sticky top-0 z-20"
           style={{ background: "var(--bg-0)", borderBottom: "1px solid var(--line-1)" }}>
        <div className="run-header-inner flex flex-col gap-3 px-4 pt-3.5 md:px-7">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              <nav aria-label="Breadcrumb" className="run-breadcrumb t-meta flex items-center gap-1.5">
                <button className="fg-3 btn-ghost" onClick={onBack}
                        style={{ padding: 0, height: "auto", background: "none", border: 0, cursor: "pointer" }}>
                  Simulations
                </button>
                <svg className="ic-xs" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                     strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden
                     style={{ color: "var(--fg-4)" }}><path d="M6 3.5 10.5 8 6 12.5" /></svg>
                <span className="mono">{run.id}</span>
              </nav>
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="run-title t-h1 truncate">{run.name}</h1>
                <StatusBadge status={run.status} />
                <span className="badge" title="Agents are AI-generated; this is not a forecast of real opinion">
                  Simulated
                </span>
                {!connected && ["running", "seeding", "paused"].includes(run.status) && (
                  <span className="badge s-warn">event stream reconnecting…</span>
                )}
              </div>
              <div className="run-meta t-meta flex flex-wrap items-center gap-2">
                <span className="mono fg-2">{run.id}</span>
                {run.provider?.name && (
                  <>
                    <span className="fg-4">·</span>
                    <span>{run.provider.name}</span>
                    {run.provider.name === "mock"
                      ? <span className="mono">deterministic</span>
                      : run.provider.model && <span className="mono">{run.provider.model}</span>}
                  </>
                )}
                <span className="fg-4">·</span>
                <span>seed <span className="mono">{run.seed}</span></span>
                {run.max_llm_calls != null && (
                  <>
                    <span className="fg-4">·</span>
                    <span>budget <span className="mono">{run.llm_calls_used}/{run.max_llm_calls}</span></span>
                  </>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              {["draft", "ready"].includes(run.status) && (
                <button className="btn btn-primary" disabled={busy} onClick={() => action("start")}>
                  <Play size={14} /> Start
                </button>
              )}
              {run.status === "running" && (
                <button className="btn" disabled={busy} onClick={() => action("pause")}>
                  <Pause size={14} /> Pause
                </button>
              )}
              {["paused", "interrupted"].includes(run.status) && (
                <button className="btn btn-primary" disabled={busy} onClick={() => action("resume")}>
                  <Play size={14} /> Resume
                </button>
              )}
              {budgetPaused && (
                <button className="btn" disabled={busy} onClick={raiseBudget}
                        title="Add 25 calls to this run's budget, then Resume">
                  <ArrowUpCircle size={14} /> Raise budget
                </button>
              )}
              {["running", "paused", "seeding"].includes(run.status) && (
                <button className="btn btn-danger" disabled={busy} onClick={() => action("stop")}>
                  <Square size={14} /> Stop
                </button>
              )}
              {canIntervene && (
                <button className="btn" onClick={() => setInterveneOpen(true)}
                        style={{ color: "var(--evt-fg)", borderColor: "var(--evt-line)" }}>
                  <Zap size={14} /> Intervene
                </button>
              )}
              {compare && (
                <a className="btn btn-ghost btn-sm" href={compare.href}>{compare.label}</a>
              )}
              <a className="btn" href={api.exportUrl(runId, "pdf")} download>
                <Download size={14} /> Export report
              </a>
              <button className="btn btn-ghost btn-icon" onClick={() => setDetailsOpen(true)}
                      aria-label="Run details">
                <Info size={15} />
              </button>
            </div>
          </div>

          <div className="run-mobile-summary t-meta lg:hidden">
            <span className="mono fg-1">{run.posts}</span> posts ·{" "}
            <span className="mono fg-1">{run.agents}</span> agents ·{" "}
            <span className="mono fg-1">{run.llm_calls_used}{run.max_llm_calls != null ? `/${run.max_llm_calls}` : ""}</span> calls ·{" "}
            {healthVal}
          </div>

          {run.provider?.name === "mock" && <MockStripe />}

          <div className="panel flex flex-wrap items-stretch">
            <div className="min-w-0 flex-[999_1_420px] px-4 py-3"
                 style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div className="flex items-baseline gap-2.5">
                  <span className="eyebrow">Round</span>
                  <span className="stat-v">{String(shownRound).padStart(2, "0")}
                    <span className="of"> / {totalTicks}</span></span>
                  <span className="t-meta">{tickNote}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="t-meta flex items-center gap-3.5">
                    <span className="inline-flex items-center gap-1.5"><span className="sg sg-pro" />Supports</span>
                    <span className="inline-flex items-center gap-1.5"><span className="sg sg-neu" />Undecided</span>
                    <span className="inline-flex items-center gap-1.5"><span className="sg sg-con" />Opposes</span>
                  </div>
                  <div className="flex items-center gap-0.5">
                    <button className="btn btn-ghost btn-sm btn-icon" aria-label="Previous round"
                            onClick={() => { setPlaying(false); setSelectedRound((r) => Math.max(1, (r ?? 1) - 1)); }}>
                      <ChevronLeft size={14} />
                    </button>
                    <button className="btn btn-ghost btn-sm btn-icon"
                            aria-label={playing ? "Pause round playback" : "Play rounds"}
                            disabled={scrubbable < 1}
                            onClick={() => {
                              if (playing) { setPlaying(false); return; }
                              setSelectedRound((r) => (r == null || r >= scrubbable ? 1 : r));
                              setPlaying(true);
                            }}>
                      {playing ? <Pause size={14} /> : <Play size={14} />}
                    </button>
                    <button className="btn btn-ghost btn-sm btn-icon" aria-label="Next round"
                            onClick={() => { setPlaying(false); setSelectedRound((r) => Math.min(Math.max(1, scrubbable || totalTicks), (r ?? 0) + 1)); }}>
                      <ChevronRight size={14} />
                    </button>
                    {selectedRound != null && (
                      <button className="btn btn-ghost btn-sm" onClick={() => { setSelectedRound(null); setPlaying(false); }}>
                        All rounds
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div>
                <div className="ruler" style={{ height: 26 }} role="group"
                     aria-label={`Posts per round by stance, ${posts.length} posts across ${run.last_completed_tick} completed rounds`}>
                  {ruler.map((t) => (
                    <button key={t.n} type="button" className={t.cls} title={t.tip}
                            aria-label={`Show round ${t.n}`}
                            aria-pressed={selectedRound === t.n}
                            onClick={() => setSelectedRound(selectedRound === t.n ? null : t.n)}>
                      {rulerSegs(t).map((s, i) => <i key={i} className={s.cls} style={{ height: `${s.h}%` }} />)}
                    </button>
                  ))}
                </div>
                <div className="ruler-axis" aria-hidden>
                  {ruler.map((t) => <span key={t.n} className={t.axCls}>{t.ax}</span>)}
                </div>
              </div>
            </div>
            <dl className="run-stats m-0 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
                style={{ flex: "1 1 480px", borderLeft: "1px solid var(--line-1)" }}>
              {[
                { label: "Posts", val: String(run.posts), sub: null as string | null },
                { label: "Agents", val: String(agentCount), sub: null },
                { label: "LLM calls", val: String(run.llm_calls_used), sub: run.max_llm_calls != null ? `budget ${run.max_llm_calls}` : null },
                { label: "Elapsed", val: elapsed, sub: null },
                { label: "Health", val: healthVal, sub: healthSub },
              ].map(({ label, val, sub }, i) => (
                <div key={label} className="stat px-4 py-3"
                     style={{ borderRight: i < 4 ? "1px solid var(--line-1)" : undefined, borderTop: "1px solid var(--line-1)" }}>
                  <dt className="eyebrow">{label}</dt>
                  <dd className="m-0 flex items-center gap-2" style={{ height: 24, fontWeight: 500 }}>
                    {label === "Health" && <span className={`dot ${healthDot}`} />}
                    <span className="num mono" style={{ fontSize: 20 }}>{val}</span>
                  </dd>
                  {sub && <dd className="t-meta m-0">{sub}</dd>}
                </div>
              ))}
            </dl>
          </div>

          <nav className="run-tabs tabs -mx-4 px-2 md:-mx-7 md:px-4" aria-label="Run views">
            {RUN_TABS.map((t) => (
              <button key={t.key} onClick={() => changeTab(t.key)}
                      className={`tab ${tab === t.key ? "is-selected" : ""}`}
                      aria-current={tab === t.key ? "page" : undefined}>
                {t.key === "live" && isActive ? "Live" : t.label}
                {t.key === "agents" && agentCount > 0 && <span className="count">{agentCount}</span>}
              </button>
            ))}
          </nav>
        </div>
      </div>

      <div className={isMobile ? "" : "overflow-hidden"}
           style={isMobile ? { paddingBottom: 64 } : { height: `calc(100vh - ${headerH}px)` }}>
        <Suspense fallback={<div className="px-4 py-5 md:px-7"><Spinner label="Loading view…" /></div>}>
          {tab === "live" && (
            <LiveTab run={run} posts={posts} runId={runId} connected={connected}
                     onError={onError} bumpKey={bump}
                     selectedTick={selectedRound}
                     onSelectRound={setSelectedRound}
                     initialChunkId={sourceId}
                     initialPostId={postId}
                     onCiteRoute={(chunk, post) => navigate({
                       name: "run", runId,
                       sourceId: chunk ?? undefined,
                       postId: post ?? undefined,
                     })} />
          )}
          {tab === "agents" && (
            <div className="h-full overflow-y-auto px-4 py-4 md:px-7">
              <AgentsTab runId={runId} runSourceId={run.source_id} posts={posts}
                         bumpKey={bump} onError={onError} roundFilter={selectedRound} />
            </div>
          )}
          {tab === "network" && (
            <div className="h-full overflow-y-auto px-4 py-4 md:px-7">
              <NetworkTab runId={runId} ticks={run.last_completed_tick} bumpKey={bump}
                          onError={onError} roundFilter={selectedRound} />
            </div>
          )}
          {tab === "analysis" && (
            <div className="h-full overflow-y-auto px-4 py-4 md:px-7">
              <AnalysisTab run={run} posts={posts} runId={runId} bumpKey={bump}
                           onError={onError} />
            </div>
          )}
          {tab === "quality" && (
            <div className="h-full overflow-y-auto px-4 py-4 md:px-7">
              <QualityTab run={run} runId={runId} onError={onError} />
            </div>
          )}
        </Suspense>
      </div>

      {isMobile && (
        <nav aria-label="Run sections" className="fixed bottom-0 left-0 right-0 z-30 grid border-t"
             style={{ gridTemplateColumns: `0.9fr repeat(${RUN_TABS.length}, 1fr)`,
                      background: "var(--bg-0)", borderColor: "var(--line-1)" }}>
          <button className="flex flex-col items-center justify-center gap-1"
                  style={{ height: 56, fontSize: 10, color: "var(--fg-3)", minWidth: 0 }} onClick={onBack}>
            <ChevronLeft size={16} /> <span className="truncate">Back</span>
          </button>
          {RUN_TABS.map((t) => (
            <button key={t.key} onClick={() => changeTab(t.key)}
                    className="flex flex-col items-center justify-center gap-1"
                    style={{ height: 56, fontSize: 10, fontWeight: 500, minWidth: 0,
                             color: tab === t.key ? "var(--fg-1)" : "var(--fg-3)" }}
                    aria-current={tab === t.key ? "page" : undefined}>
              <span className="truncate" style={{ maxWidth: "100%" }}>
                {t.key === "live" && isActive ? "Live" : t.label}
              </span>
            </button>
          ))}
        </nav>
      )}

      {detailsOpen && (
        <RunDetails run={run} onClose={() => setDetailsOpen(false)}
                    onError={onError} bumpKey={bump} />
      )}
      {interveneOpen && (
        <InterveneDrawer runId={runId} run={run} bumpKey={bump}
                         onClose={() => setInterveneOpen(false)} onError={onError} />
      )}
    </div>
  );
}

function InterveneDrawer({ runId, run, bumpKey, onClose, onError }: {
  runId: string;
  run: RunDetail;
  bumpKey: number;
  onClose: () => void;
  onError: (e: unknown) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(ref, onClose);
  return (
    <>
      <button className="scrim" onClick={onClose} aria-label="Close interventions" />
      <aside className="drawer" ref={ref} tabIndex={-1} role="dialog" aria-modal="true"
             aria-labelledby="iv-title" style={{ width: "min(680px, 100%)" }}>
        <div className="drawer-head">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="eyebrow">Controlled change</span>
            <h2 id="iv-title" className="t-h2">Intervene in this world</h2>
            <span className="t-meta">A public broadcast or a private group briefing at a chosen round.</span>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close interventions">
            <X size={15} />
          </button>
        </div>
        <div className="drawer-body">
          <EventsTab runId={runId} run={run} bumpKey={bumpKey} onError={onError} embedded
                     onBranched={(id) => navigate({ name: "run", runId: id })} />
        </div>
      </aside>
    </>
  );
}

export type { RunDetail, Agent, Post };
