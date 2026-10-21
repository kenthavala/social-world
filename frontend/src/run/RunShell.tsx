// Run room: sticky run header (breadcrumb · status · actions), stat strip with the
// tick ruler, and the simulation tabs (Live / Agents / Network / Events / Analysis / Log).
// Every value comes from the API/SSE — the ruler is derived from the run's real posts.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, Clock, Gauge, MessageSquare, Pause, Play, Square, Users, Zap,
} from "lucide-react";
import type { Agent, Post, RunDetail } from "../types";
import * as api from "../api";
import { Spinner, StatusBadge } from "../common";
import { useRunStream, usePosts, useRunDetail } from "../hooks";
import { useIsMobile } from "../shell";
import { RUN_TABS, buildRuler, normalizeTab, prefetchChunks, rulerSegs, type RunTabKey } from "./helpers";
import LiveTab from "./LiveTab";
import EventsTab from "./EventsTab";
import LogTab from "./LogTab";
// Chart/graph-heavy tabs load on first use so the main bundle stays small.
const AgentsTab = lazy(() => import("./AgentsTab"));
const NetworkTab = lazy(() => import("./NetworkTab"));
const AnalysisTab = lazy(() => import("./AnalysisTab"));

const TAB_STORE = "oasis-run-tab";

export default function RunPage({ runId, onBack, onError }: {
  runId: string;
  onBack: () => void;
  onError: (e: unknown) => void;
}) {
  const [tab, setTab] = useState<RunTabKey>(() => {
    try { return normalizeTab(sessionStorage.getItem(TAB_STORE)); } catch { return "live"; }
  });
  const [busy, setBusy] = useState(false);
  const [bump, setBump] = useState(0);
  const bumpRef = useRef(0);

  const changeTab = (t: RunTabKey) => {
    setTab(t);
    try { sessionStorage.setItem(TAB_STORE, t); } catch { /* ignore */ }
  };

  const { run, reload: reloadRun } = useRunDetail(runId, bump);
  const { posts, reload: reloadPosts } = usePosts(runId, bump);

  // measure the sticky header so the tab area can fill the remaining viewport
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
  const onEvent = useCallback((_e: { event: string; data: Record<string, unknown> }) => {
    // Coalesce SSE bursts (post_created + llm_call + tick_completed) into one refetch.
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
    // honour launch intent from the wizard: start the run on arrival (non-blocking)
    try {
      if (sessionStorage.getItem("oasis-autostart") === runId) {
        sessionStorage.removeItem("oasis-autostart");
        void api.startRun(runId).catch((e) => onError(e));
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const elapsed = useMemo(() => {
    // Honest elapsed: from the recorded first-start to last update / terminal time.
    if (!run || !run.started_at) return "—";
    const from = new Date(run.started_at).getTime();
    const to = run.finished_at ? new Date(run.finished_at).getTime()
      : ["running", "seeding", "paused"].includes(run.status) ? Date.now() : null;
    if (!from) return "—";
    const end = to ?? Date.now();
    const s = Math.max(0, Math.round((end - from) / 1000));
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, [run, connected]);

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

  // resolve chunk pages/text once for the whole run room (feed + analysis share the cache)
  useEffect(() => {
    if (run?.source_id && posts.length) prefetchChunks(run.source_id, posts);
  }, [run?.source_id, posts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalTicks = run?.config?.ticks ?? 0;
  const isActive = !!run && ["running", "seeding", "paused"].includes(run.status);
  const clampTick = (t: number) => Math.min(Math.max(t || 0, 1), Math.max(1, totalTicks));
  const displayTick = run && (isActive || (run.last_completed_tick || 0) > 0)
    ? clampTick(run.current_tick || run.last_completed_tick)
    : 0;
  const highlightTick = isActive ? displayTick : 0; // only a live run has an in-progress tick
  const ruler = useMemo(
    () => buildRuler(posts, totalTicks, highlightTick),
    [posts, totalTicks, highlightTick]);

  if (!run) return <div className="px-8 py-6"><Spinner label="Loading run…" /></div>;

  const agentCount = run.agents;
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
  const healthSub = run.error ? "see Log tab"
    : run.status === "completed" ? "run finished"
    : run.status === "paused" ? "resumes from here"
    : null;
  const tickNote = run.status === "running"
    ? "in progress"
    : run.status === "completed" ? "complete"
    : run.status === "paused" ? "paused — calls in flight finish first"
    : ["interrupted", "failed"].includes(run.status) ? `stopped at tick ${String(run.last_completed_tick).padStart(2, "0")}`
    : run.status;

  return (
    <div>
      {/* sticky run header */}
      <div
        ref={headerRef}
        className="sticky top-0 z-20"
        style={{ background: "var(--bg-0)", borderBottom: "1px solid var(--line-1)" }}
      >
        <div className="flex flex-col gap-3.5 px-4 pt-3.5 md:px-7">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              <nav aria-label="Breadcrumb" className="t-meta flex items-center gap-1.5">
                <button className="fg-3 btn-ghost" onClick={onBack} style={{ padding: 0, height: "auto", background: "none", border: 0, cursor: "pointer" }}>
                  Simulations
                </button>
                <svg className="ic-xs" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ color: "var(--fg-4)" }}>
                  <path d="M6 3.5 10.5 8 6 12.5" />
                </svg>
                <span className="mono">{run.id}</span>
              </nav>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="t-h1 truncate">{run.name}</h1>
                <StatusBadge status={run.status} />
                {!connected && ["running", "seeding", "paused"].includes(run.status) && (
                  <span className="badge s-warn">event stream reconnecting…</span>
                )}
              </div>
              <div className="t-meta flex flex-wrap items-center gap-2">
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

            <div className="flex items-center gap-2">
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
              {["running", "paused", "seeding"].includes(run.status) && (
                <button className="btn btn-danger" disabled={busy} onClick={() => action("stop")}>
                  <Square size={14} /> Stop
                </button>
              )}
            </div>
          </div>

          {/* stat strip: tick ruler + counters */}
          <div className="panel flex flex-wrap items-stretch">
            <div className="min-w-0 flex-[999_1_420px] px-4 py-3" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div className="flex items-baseline gap-2.5">
                  <span className="eyebrow">Tick</span>
                  <span className="stat-v">{String(displayTick).padStart(2, "0")}<span className="of"> / {totalTicks}</span></span>
                  <span className="t-meta">{tickNote}</span>
                </div>
                <span className="t-meta flex gap-3">
                  <span className="inline-flex items-center gap-1.5"><span className="sg sg-pro" />PRO</span>
                  <span className="inline-flex items-center gap-1.5"><span className="sg sg-neu" />NEUTRAL</span>
                  <span className="inline-flex items-center gap-1.5"><span className="sg sg-con" />CON</span>
                </span>
              </div>
              <div>
                <div className="ruler" style={{ height: 26 }} role="img"
                     aria-label={`Posts per tick by stance, ${posts.length} posts across ${run.last_completed_tick} completed ticks`}>
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
            <dl className="m-0 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
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

          {/* simulation tabs */}
          <nav className="tabs -mx-4 px-2 md:-mx-7 md:px-4" aria-label="Simulation views">
            {RUN_TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => changeTab(t.key)}
                className={`tab ${tab === t.key ? "is-selected" : ""}`}
                aria-current={tab === t.key ? "page" : undefined}
              >
                {t.label}
                {t.key === "agents" && agentCount > 0 && <span className="count">{agentCount}</span>}
              </button>
            ))}
          </nav>
        </div>
      </div>

      <div
        className={isMobile ? "" : "overflow-hidden"}
        style={isMobile ? undefined : { height: `calc(100vh - ${headerH}px)` }}
      >
      <Suspense fallback={<div className="px-4 py-5 md:px-7"><Spinner label="Loading view…" /></div>}>
        {tab === "live" && (
          <LiveTab run={run} posts={posts} runId={runId} connected={connected} onError={onError} bumpKey={bump} />
        )}
        {tab === "agents" && (
          <div className="h-full overflow-y-auto px-4 py-4 md:px-7">
            <AgentsTab runId={runId} runSourceId={run.source_id} posts={posts} bumpKey={bump} onError={onError} />
          </div>
        )}
        {tab === "network" && (
          <div className="h-full overflow-y-auto px-4 py-4 md:px-7">
            <NetworkTab runId={runId} ticks={run.last_completed_tick} bumpKey={bump} onError={onError} />
          </div>
        )}
        {tab === "events" && (
          <div className="h-full overflow-y-auto px-4 py-4 md:px-7">
            <EventsTab runId={runId} run={run} bumpKey={bump} onError={onError} />
          </div>
        )}
        {tab === "analysis" && (
          <div className="h-full overflow-y-auto px-4 py-4 md:px-7">
            <AnalysisTab run={run} posts={posts} runId={runId} bumpKey={bump} onError={onError} />
          </div>
        )}
        {tab === "log" && (
          <div className="h-full overflow-y-auto px-4 py-4 md:px-7">
            <LogTab runId={runId} bumpKey={bump} onError={onError} />
          </div>
        )}
      </Suspense>
      </div>
    </div>
  );
}

export type { RunDetail, Agent, Post };
