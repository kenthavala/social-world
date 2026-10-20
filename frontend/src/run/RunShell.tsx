// Run room: sticky run header + 7 tabs. All state comes from the API/SSE.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, Clock, Gauge, MessageSquare, Pause, Play, Square, Users, Zap, Activity,
} from "lucide-react";
import type { Agent, Post, RunDetail } from "../types";
import * as api from "../api";
import { Spinner, StatusBadge } from "../common";
import { useRunStream, usePosts, useRunDetail } from "../hooks";
import { RUN_TABS, type RunTabKey } from "./helpers";
import FeedTab from "./FeedTab";
import EventsTab from "./EventsTab";
import InsightsTab from "./InsightsTab";
import LogTab from "./LogTab";
// Chart/graph-heavy tabs load on first use so the main bundle stays small:
// OverviewTab/AgentsTab carry recharts, NetworkTab carries react-force-graph-2d.
const OverviewTab = lazy(() => import("./OverviewTab"));
const AgentsTab = lazy(() => import("./AgentsTab"));
const NetworkTab = lazy(() => import("./NetworkTab"));

const TAB_STORE = "oasis-run-tab";

export default function RunPage({ runId, onBack, onError }: {
  runId: string;
  onBack: () => void;
  onError: (e: unknown) => void;
}) {
  const [tab, setTab] = useState<RunTabKey>(() => {
    try { return (sessionStorage.getItem(TAB_STORE) as RunTabKey) || "overview"; } catch { return "overview"; }
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

  const onEvent = useCallback((_e: { event: string; data: Record<string, unknown> }) => {
    bumpRef.current += 1;
    setBump(bumpRef.current);
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
    // Runs that never started have no elapsed time to show.
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

  if (!run) return <Spinner label="Loading run…" />;

  return (
    <div>
      {/* sticky run header */}
      <div
        className="sticky top-0 z-10 px-6 pt-4 pb-3"
        style={{ background: "var(--bg-0)", borderBottom: "1px solid var(--line-1)" }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <button className="btn-ghost btn-sm" onClick={onBack} title="All runs">
                <ArrowLeft size={13} />
              </button>
              <span className="mono text-xs" style={{ color: "var(--fg-3)" }}>{run.id}</span>
              <StatusBadge status={run.status} />
              {!connected && ["running", "seeding", "paused"].includes(run.status) && (
                <span className="badge s-warn">event stream reconnecting…</span>
              )}
            </div>
            <h1 className="t-h2 mt-1 truncate">{run.name}</h1>
            <div className="mono mt-0.5 text-[11px]" style={{ color: "var(--fg-4)" }}>
              {run.agents} agents · seed {run.seed}
              {run.max_llm_calls ? ` · budget ${run.llm_calls_used}/${run.max_llm_calls}` : ` · ${run.llm_calls_used} calls`}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {["draft", "ready"].includes(run.status) && (
              <button className="btn-primary" disabled={busy} onClick={() => action("start")}>
                <Play size={14} /> Start
              </button>
            )}
            {run.status === "running" && (
              <button className="btn-ghost" disabled={busy} onClick={() => action("pause")}>
                <Pause size={14} /> Pause
              </button>
            )}
            {["paused", "interrupted"].includes(run.status) && (
              <button className="btn-primary" disabled={busy} onClick={() => action("resume")}>
                <Play size={14} /> Resume
              </button>
            )}
            {["running", "paused", "seeding"].includes(run.status) && (
              <button className="btn-danger" disabled={busy} onClick={() => action("stop")}>
                <Square size={14} /> Stop
              </button>
            )}
          </div>
        </div>

        {/* KPI strip */}
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs" style={{ color: "var(--fg-3)" }}>
          {[
            { icon: Activity, label: "TICK", val: `${run.last_completed_tick} / ${run.config.ticks}` },
            { icon: MessageSquare, label: "POSTS", val: String(run.posts) },
            { icon: Users, label: "AGENTS", val: String(run.agents) },
            { icon: Zap, label: "LLM CALLS", val: String(run.llm_calls_used) },
            { icon: Clock, label: "ELAPSED", val: elapsed },
            { icon: Gauge, label: "HEALTH", val: run.error ? "error" : connected ? "streaming" : run.status },
          ].map(({ icon: Icon, label, val }) => (
            <span key={label} className="flex items-center gap-1.5">
              <Icon size={12} />
              <span className="eyebrow">{label}</span>
              <span className="num" style={{ color: "var(--fg-2)" }}>{val}</span>
            </span>
          ))}
        </div>

        {/* tab rail */}
        <div className="mt-3 flex gap-1 overflow-x-auto">
          {RUN_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => changeTab(t.key)}
              className="nav-item"
              style={{
                width: "auto",
                padding: "4px 10px",
                fontSize: 12,
                ...(tab === t.key
                  ? { background: "var(--bg-2)", borderColor: "var(--line-2)", color: "var(--fg-1)" }
                  : { color: "var(--fg-3)" }),
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <Suspense fallback={<div className="px-6 py-4"><Spinner label="Loading view…" /></div>}>
        <div className="px-6 py-4">
          {tab === "overview" && <OverviewTab run={run} posts={posts} runId={runId} onError={onError} bumpKey={bump} />}
          {tab === "feed" && <FeedTab posts={posts} run={run} />}
          {tab === "agents" && <AgentsTab runId={runId} runSourceId={run.source_id} bumpKey={bump} onError={onError} />}
          {tab === "network" && <NetworkTab runId={runId} ticks={run.last_completed_tick} bumpKey={bump} onError={onError} />}
          {tab === "events" && <EventsTab runId={runId} bumpKey={bump} onError={onError} />}
          {tab === "insights" && <InsightsTab runId={runId} bumpKey={bump} onError={onError} />}
          {tab === "log" && <LogTab runId={runId} bumpKey={bump} onError={onError} />}
        </div>
      </Suspense>
    </div>
  );
}

export type { RunDetail, Agent, Post };
