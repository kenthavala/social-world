// Simulations: the landing page. The sample world comes first, then any live
// run, then the local library. Everything here is counted from the API.
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, FlaskConical, Plus, Search, Trash2 } from "lucide-react";
import type { Post, Provider, RunDetail, RunListItem, SampleInfo } from "./types";
import * as api from "./api";
import { EmptyState, Spinner, StatusBadge } from "./common";
import { Mark } from "./Brand";
import { buildRuler, rulerSegs } from "./run/helpers";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "running", label: "Active" },
  { key: "completed", label: "Completed" },
  { key: "interrupted", label: "Interrupted" },
  { key: "failed", label: "Failed" },
] as const;

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function SimulationsPage({ onOpen, onNew, onError, settingsVersion }: {
  onOpen: (runId: string) => void;
  onNew: () => void;
  onError: (e: unknown) => void;
  settingsVersion: number;
}) {
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [sample, setSample] = useState<SampleInfo | null>(null);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [q, setQ] = useState("");
  const [provider, setProvider] = useState<string | null>(null);
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [active, setActive] = useState<{ run: RunDetail; posts: Post[] } | null>(null);

  useEffect(() => {
    api.listRuns().then((r) => setRuns(r.runs)).catch((e) => {
      setRuns([]);
      onError(e);
    });
    api.getSample().then(setSample).catch(() => setSample(null));
    api.getHealth().then((h) => setProvider(h.provider)).catch(() => setProvider(null));
    api.listProviders().then((r) => setProviders(r.providers)).catch(() => setProviders(null));
    api.getSettings().then((r) => setSettings(r.settings)).catch(() => setSettings(null));
  }, [onError, settingsVersion]);

  const liveId = runs?.find((r) => ["running", "seeding", "paused"].includes(r.status))?.id ?? null;
  useEffect(() => {
    if (!liveId) { setActive(null); return; }
    let alive = true;
    const load = () => {
      Promise.all([api.getRun(liveId), api.listPosts(liveId, { limit: 2000, newest: true })])
        .then(([run, p]) => { if (alive) setActive({ run, posts: p.posts }); })
        .catch(() => { if (alive) setActive(null); });
    };
    load();
    const t = window.setInterval(() => {
      load();
      api.listRuns().then((r) => setRuns(r.runs)).catch(() => undefined);
    }, 4000);
    return () => { alive = false; window.clearInterval(t); };
  }, [liveId]);

  async function openSample() {
    if (!sample) return;
    setSampleBusy(true);
    onError(null);
    try {
      const info = sample.imported ? sample : await api.loadSample();
      setSample(info);
      if (info.run_id) onOpen(info.run_id);
    } catch (e) {
      onError(e);
    } finally {
      setSampleBusy(false);
    }
  }

  const shown = useMemo(() => {
    if (!runs) return [];
    let out = runs;
    if (filter === "running") out = out.filter((r) => ["running", "seeding", "paused"].includes(r.status));
    else if (filter !== "all") out = out.filter((r) => r.status === filter);
    if (q.trim()) {
      const needle = q.toLowerCase();
      out = out.filter((r) =>
        r.name.toLowerCase().includes(needle) || r.id.toLowerCase().includes(needle) ||
        (r.source || "").toLowerCase().includes(needle));
    }
    return out;
  }, [runs, filter, q]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: runs?.length ?? 0 };
    for (const f of FILTERS.slice(1)) {
      c[f.key] = (runs ?? []).filter((r) => f.key === "running"
        ? ["running", "seeding", "paused"].includes(r.status)
        : r.status === f.key).length;
    }
    return c;
  }, [runs]);

  async function remove(r: RunListItem) {
    try {
      await api.deleteRun(r.id);
      setRuns((cur) => (cur ?? []).filter((x) => x.id !== r.id));
    } catch (e) {
      onError(e);
    }
  }

  const currentProvider = providers?.find((p) => p.name === provider) ?? null;
  const keyOk = provider === "mock" ? true : currentProvider ? currentProvider.has_key : null;
  const model = String(settings?.llm_model ?? "");

  const totalTicks = active?.run.config?.ticks ?? 1;
  const rawTick = active ? (active.run.current_tick || active.run.last_completed_tick || 0) : 0;
  const currentTick = active ? Math.min(Math.max(rawTick, 0), Math.max(1, totalTicks)) : 0;
  const rulerHighlight = active && rawTick > 0 && ["running", "seeding", "paused"].includes(active.run.status)
    ? currentTick : 0;
  const ruler = active ? buildRuler(active.posts, totalTicks, rulerHighlight) : [];

  return (
    <div className="pt-6 md:pt-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <span className="eyebrow">An AI social simulation lab</span>
          <h1 className="t-display mt-1.5">Simulations</h1>
          <p className="t-body fg-2 mt-2" style={{ maxWidth: 650 }}>
            See how a population argues about a document. Every argument links to the source
            passage it drew from.
          </p>
          <p className="t-meta mt-1.5">
            Agents are AI-generated. This is a simulation, not a forecast of real opinion.
          </p>
          <div className="t-meta mt-3 flex flex-wrap items-center gap-2">
            <span className={`dot ${provider === "mock" ? "dot-warn" : keyOk === false ? "dot-warn" : "dot-ok"}`} />
            <span className="mono">{provider ?? "checking…"}</span>
            {provider !== "mock" && model && <span>· {model}</span>}
            <span>· {provider === "mock" ? "mock provider" : keyOk === false ? "no key" : "configured"}</span>
            <a className="kbd-link" href="#/settings">Change</a>
          </div>
        </div>
        <span className="t-meta hidden md:inline">Create a new simulation from the sidebar.</span>
      </div>

      {sample === null ? null : sample.available ? (
        <section className="panel sample-card mb-6" aria-labelledby="sample-h"
                 style={{ borderColor: "var(--source-line)", background: "var(--source-soft)" }}>
          <div className="flex flex-wrap items-center gap-4 p-4 md:p-5">
            <div className="hidden sm:block"><Mark size={44} /></div>
            <div className="sample-text min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="eyebrow">Sample world</span>
                {sample.mock && <span className="badge s-warn">Mock run — synthetic posts</span>}
              </div>
              <h2 id="sample-h" className="t-h2 mt-1">
                {sample.label ?? "Harbour City congestion charge"}
              </h2>
              <p className="t-body fg-2 mt-1" style={{ maxWidth: 720 }}>
                {sample.description ?? "A fictional council consultation, with a finished run and real page citations."}
                {" "}Opens with no API key.
              </p>
            </div>
            <button className="btn btn-primary w-full sm:w-auto" onClick={openSample} disabled={sampleBusy}>
              {sampleBusy ? <Spinner /> : <FlaskConical size={14} />}
              {sample.imported ? "Open the sample world" : "Load the sample world"}
              <ArrowRight size={14} />
            </button>
          </div>
        </section>
      ) : null}

      {active && (
        <section className="panel mb-6" aria-labelledby="active-h">
          <div className="panel-head flex-wrap" style={{ minHeight: 54, padding: "9px 18px" }}>
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <StatusBadge status={active.run.status} />
              <button id="active-h" className="t-h2 row-link truncate" onClick={() => onOpen(active.run.id)}>
                {active.run.name}
              </button>
              <span className="t-id">{active.run.id}</span>
            </div>
            <button className="btn" onClick={() => onOpen(active.run.id)}>
              {active.run.status === "paused" ? "Open run" : "Open live view"}
              <ArrowRight size={14} />
            </button>
          </div>
          <div className="flex flex-wrap gap-6 p-4">
            <div className="min-w-0 flex-[999_1_440px]">
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="eyebrow">Round</span>
                <span className="stat-v">{String(currentTick).padStart(2, "0")}
                  <span className="of"> / {totalTicks}</span></span>
                <span className="t-meta">{active.run.posts} posts · {active.run.agents} agents</span>
              </div>
              <div className="mt-2">
                <div className="ruler" style={{ height: 30 }} role="img"
                     aria-label={`Posts per round, ${active.posts.length} recorded so far`}>
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
            <dl className="m-0 grid grid-cols-2 gap-4 sm:grid-cols-4" style={{ flex: "1 1 300px" }}>
              {[["Posts", active.run.posts], ["Agents", active.run.agents],
                ["LLM calls", active.run.llm_calls_used],
                ["Budget", active.run.max_llm_calls ?? "—"]].map(([k, v]) => (
                <div key={String(k)} className="stat">
                  <dt className="eyebrow">{k}</dt>
                  <dd className="stat-v m-0">{String(v)}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      )}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="t-h2">Your simulations</h2>
        <span className="t-meta">{runs?.length ?? 0} recorded locally</span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="input-wrap min-w-52 flex-1" style={{ maxWidth: 360 }}>
          <Search className="ic" aria-hidden />
          <input className="input" placeholder="Search by name, source or run ID"
                 value={q} onChange={(e) => setQ(e.target.value)} />
        </span>
        {FILTERS.map((f) => (
          <button key={f.key} className="chip" aria-pressed={filter === f.key}
                  onClick={() => setFilter(f.key)}>
            {f.label} <span className="chip-n">{counts[f.key] ?? 0}</span>
          </button>
        ))}
      </div>

      {runs === null ? (
        <div className="panel panel-body"><Spinner label="Loading simulations…" /></div>
      ) : shown.length === 0 ? (
        <EmptyState
          title={filter === "all" && !q ? "No simulations yet" : "Nothing matches"}
          body={filter === "all" && !q
            ? "Open the sample world above, or create a simulation from a document. The wizard walks through source, scenario, agents and run."
            : "Try a different filter or clear the search."}
          action={filter === "all" && !q
            ? <button className="btn btn-primary" onClick={onNew}><Plus size={14} /> New simulation</button>
            : undefined}
          sampleHref={undefined}
        />
      ) : (
        <>
        <div className="flex flex-col gap-2 lg:hidden">
          {shown.map((r) => (
            <div key={r.id} className="panel p-3">
              <div className="flex items-start justify-between gap-2">
                <button className="min-w-0 text-left" onClick={() => onOpen(r.id)}>
                  <span className="row-link ellipsis block" style={{ fontWeight: 600 }}>{r.name}</span>
                  <span className="t-meta ellipsis block">{r.source ?? "no source document"}</span>
                </button>
                <StatusBadge status={r.status} />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3 t-meta">
                <span className="mono">{r.id}</span>
                <span>{r.ticks_done}/{r.ticks_total || "—"} rounds</span>
                <span>{r.llm_calls_used} calls</span>
                <span className="ml-auto">{relTime(r.created_at)}</span>
                <button className="btn btn-ghost btn-sm btn-icon" aria-label={`Delete ${r.name}`}
                        disabled={["running", "seeding", "paused"].includes(r.status)}
                        onClick={() => remove(r)}>
                  <Trash2 size={14} style={{ color: "var(--fg-4)" }} />
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="panel hidden overflow-hidden lg:block">
          <div className="overflow-x-auto">
            <table className="tbl" style={{ minWidth: 780 }}>
              <thead>
                <tr>
                  <th>Simulation</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th className="r">Rounds</th>
                  <th className="r">LLM calls</th>
                  <th style={{ width: 48 }} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} onClick={() => onOpen(r.id)} style={{ cursor: "pointer" }}>
                    <td style={{ maxWidth: 380 }}>
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="row-link ellipsis">{r.name}</span>
                        <span className="t-meta ellipsis">
                          {r.source ?? "no source document"} · <span className="mono">{r.id}</span>
                          {r.parent_run_id && <span className="badge ml-2">intervention re-run</span>}
                        </span>
                      </div>
                    </td>
                    <td><StatusBadge status={r.status} /></td>
                    <td style={{ fontSize: 12.5 }}>{relTime(r.created_at)}</td>
                    <td className="r mono num" style={{ fontSize: 12.5 }}>{r.ticks_done}/{r.ticks_total || "—"}</td>
                    <td className="r mono num" style={{ fontSize: 12.5 }}>{r.llm_calls_used}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button className="btn btn-ghost btn-sm btn-icon"
                              title={["running", "seeding", "paused"].includes(r.status)
                                ? "Stop the run before deleting it"
                                : "Delete run and all its data"}
                              disabled={["running", "seeding", "paused"].includes(r.status)}
                              onClick={() => remove(r)}
                              aria-label={`Delete ${r.name}`}>
                        <Trash2 size={14} style={{ color: "var(--fg-4)" }} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        </>
      )}
    </div>
  );
}
