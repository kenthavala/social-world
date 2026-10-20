// Analysis: what happened, what changed, what patterns appeared — all counted
// from recorded rows. The ONE generated element (the LLM executive summary)
// renders only inside its clearly-labeled draft card.
import { useEffect, useMemo, useState } from "react";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { Download, FileJson, FileText, FolderArchive, Sparkles } from "lucide-react";
import type { Post, RunDetail } from "../types";
import * as api from "../api";
import { Spinner } from "../common";
import { chunkInfo, deriveStats, initials, postOverallStance, subscribeChunks } from "./helpers";
import type { EssaySummary } from "../api";

const ESSAY_LABELS: [string, string][] = [
  ["executive_summary", "Headline"],
  ["opinion_shifts", "Where opinion moved"],
  ["emerging_narratives", "Narrative threads"],
  ["influential_agents", "Influential voices"],
  ["communities", "Communities"],
  ["key_events", "Events"],
  ["contradictions", "Contradictions"],
  ["unexpected_outcomes", "Unexpected"],
  ["limitations", "Limits"],
];

type ReactLike = React.ReactNode;

function inline(s: string, keyBase: string): ReactLike {
  const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith("**") && p.endsWith("**") && p.length > 4)
          return <strong key={`${keyBase}-${i}`} style={{ color: "var(--fg-1)" }}>{p.slice(2, -2)}</strong>;
        if (p.startsWith("`") && p.endsWith("`") && p.length > 2)
          return <code key={`${keyBase}-${i}`} className="mono" style={{ fontSize: "0.9em" }}>{p.slice(1, -1)}</code>;
        return <span key={`${keyBase}-${i}`}>{p}</span>;
      })}
    </>
  );
}

function MiniMd({ text }: { text: string }) {
  return (
    <div className="t-body">
      {text.split("\n").map((ln, i) => {
        if (ln.startsWith("### ")) return <h3 key={i} className="t-h3 mt-3">{inline(ln.slice(4), `h${i}`)}</h3>;
        if (ln.startsWith("## ")) return <h3 key={i} className="t-h2 mt-4">{inline(ln.slice(3), `h${i}`)}</h3>;
        if (ln.startsWith("# ")) return <h3 key={i} className="t-h1">{inline(ln.slice(2), `h${i}`)}</h3>;
        if (ln === "---" || ln === "") return <div key={i} style={{ height: 8 }} />;
        if (ln.startsWith("- "))
          return (
            <div key={i} className="flex gap-2 pl-1">
              <span aria-hidden style={{ color: "var(--fg-4)" }}>–</span>
              <span style={{ color: "var(--fg-2)" }}>{inline(ln.slice(2), `b${i}`)}</span>
            </div>
          );
        return <p key={i} style={{ color: "var(--fg-2)" }}>{inline(ln, `p${i}`)}</p>;
      })}
    </div>
  );
}

function ExportLinks({ runId }: { runId: string }) {
  const items: Array<{ fmt: string; label: string; icon: typeof Download }> = [
    { fmt: "json", label: "JSON", icon: FileJson },
    { fmt: "md", label: "Markdown", icon: FileText },
    { fmt: "csv", label: "CSV zip", icon: FolderArchive },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(({ fmt, label, icon: Icon }) => (
        <a key={fmt} className="btn btn-ghost btn-sm" href={api.exportUrl(runId, fmt)} download>
          <Icon size={13} /> <Download size={11} style={{ opacity: 0.7 }} /> {label}
        </a>
      ))}
    </div>
  );
}

export default function AnalysisTab({ run, posts, runId, bumpKey, onError }: {
  run: RunDetail;
  posts: Post[];
  runId: string;
  bumpKey: number;
  onError: (e: unknown) => void;
}) {
  const [metrics, setMetrics] = useState<Awaited<ReturnType<typeof api.getMetrics>> | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<Record<string, unknown> | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [essay, setEssay] = useState<EssaySummary | null>(null);
  const [essayBusy, setEssayBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, force] = useState(0);

  useEffect(() => subscribeChunks(() => force((x) => x + 1)), []);

  useEffect(() => {
    api.getMetrics(runId).then(setMetrics as never).catch(() => setMetrics(null));
  }, [runId, bumpKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.getReport(runId).then((r) => {
      setReport(r.report_md);
      setAvailable(r.available);
      setAnalytics((r.analytics as Record<string, unknown>) ?? null);
      setGeneratedAt(r.created_at ?? null);
      setEssay(r.essay ?? null);
    }).catch((e) => {
      setAvailable(false);
      onError(e);
    });
  }, [runId, bumpKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function regenerate() {
    setBusy(true);
    onError(null);
    try {
      const r = await api.generateReport(runId);
      setReport(r.report_md);
      setAnalytics((r.analytics as Record<string, unknown>) ?? null);
      setGeneratedAt(r.created_at ?? null);
      setAvailable(true);
      setEssay(null);   // the regenerated snapshot invalidates the old summary
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function summarize() {
    setEssayBusy(true);
    onError(null);
    try {
      const r = await api.generateEssay(runId);
      setEssay(r.essay);
    } catch (e) {
      onError(e);
    } finally {
      setEssayBusy(false);
    }
  }

  const stats = useMemo(() => deriveStats(posts), [posts]);

  const pageCounts = useMemo(() => {
    const byPage = new Map<number, { posts: number; chunks: Set<string> }>();
    for (const p of posts) {
      for (const c of p.cited_chunk_ids) {
        const info = chunkInfo(c);
        if (info?.page == null) continue;
        const e = byPage.get(info.page) ?? { posts: 0, chunks: new Set<string>() };
        e.posts += 1;
        e.chunks.add(c);
        byPage.set(info.page, e);
      }
    }
    return [...byPage.entries()]
      .map(([page, v]) => ({ page, posts: v.posts, chunks: [...v.chunks] }))
      .sort((a, b) => b.posts - a.posts)
      .slice(0, 6);
  }, [posts]);

  const stanceSeries = useMemo(() => mergeStanceSeries(metrics?.stance_by_issue ?? {}), [metrics]);
  const engSeries = useMemo(
    () => (metrics?.metrics ?? []).map((m) => ({ tick: m.tick, engagement: m.engagement ?? 0 })),
    [metrics]);

  const maxTickCount = Math.max(1, ...stats.postsByTick.map((t) => t.total));
  const maxAgentPosts = Math.max(1, ...stats.postsByAgent.map((a) => a.n));
  const asOf = run.updated_at ? run.updated_at.slice(0, 19).replace("T", " ") : "";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h2 className="t-h1">Run summary</h2>
          <p className="t-meta">
            Counted from the {posts.length} post{posts.length === 1 ? "" : "s"} in this run so far.
            Nothing on this page is model-generated — the one exception is the executive-summary
            draft, clearly labeled where it appears.
          </p>
        </div>
        <span className="t-id">as of {asOf} UTC</span>
      </div>

      {/* posts per tick, by stance */}
      <section className="panel" aria-labelledby="ppt-h">
        <div className="panel-head">
          <h3 id="ppt-h" className="t-h3">Posts per tick, by stance</h3>
          <span className="t-meta flex gap-3">
            <span className="inline-flex items-center gap-1.5"><span className="sg sg-pro" />PRO {stats.stanceMix.pro}</span>
            <span className="inline-flex items-center gap-1.5"><span className="sg sg-neu" />NEUTRAL {stats.stanceMix.neu}</span>
            <span className="inline-flex items-center gap-1.5"><span className="sg sg-con" />CON {stats.stanceMix.con}</span>
          </span>
        </div>
        <div className="panel-body">
          {stats.postsByTick.length === 0 ? (
            <p className="t-meta">No posts yet — the chart is drawn only from recorded posts.</p>
          ) : (
            <div className="grid" style={{ gridTemplateColumns: "28px minmax(0,1fr)", gap: 8 }}>
              <div className="mono flex flex-col justify-between" style={{ height: 168, fontSize: 10, color: "var(--fg-3)", textAlign: "right" }} aria-hidden>
                <span>{maxTickCount}</span><span>{Math.round(maxTickCount * 0.66)}</span><span>{Math.round(maxTickCount * 0.33)}</span><span>0</span>
              </div>
              <div style={{ position: "relative", height: 168 }}>
                <div className="absolute inset-0 flex flex-col justify-between" aria-hidden>
                  <span style={{ borderTop: "1px solid var(--line-1)" }} />
                  <span style={{ borderTop: "1px solid var(--line-1)" }} />
                  <span style={{ borderTop: "1px solid var(--line-1)" }} />
                  <span style={{ borderTop: "1px solid var(--line-2)" }} />
                </div>
                <div className="ruler relative" style={{ height: "100%", gap: 6 }} role="img"
                     aria-label={stats.postsByTick.map((t) => `T${t.tick}: ${t.total}`).join(", ")}>
                  {stats.postsByTick.map((t) => (
                    <div key={t.tick} className="tk" title={`Tick ${t.tick} · ${t.total} posts — PRO ${t.pro} · NEU ${t.neu} · CON ${t.con}`}
                         style={{ background: "transparent", overflow: "visible", gap: 2, justifyContent: "flex-end" }}>
                      <span className="mono fg-2" style={{ fontSize: 10, textAlign: "center", marginBottom: 2 }}>{t.total}</span>
                      {t.con > 0 && <i className="s-con" style={{ height: `${(t.con / maxTickCount) * 100}%`, borderRadius: 1.5 }} />}
                      {t.neu > 0 && <i className="s-neu" style={{ height: `${(t.neu / maxTickCount) * 100}%`, borderRadius: 1.5 }} />}
                      {t.pro > 0 && <i className="s-pro" style={{ height: `${(t.pro / maxTickCount) * 100}%`, borderRadius: 1.5 }} />}
                    </div>
                  ))}
                </div>
              </div>
              <span />
              <div className="ruler-axis" style={{ gap: 6 }}>
                {stats.postsByTick.map((t) => <span key={t.tick} style={{ textAlign: "center" }}>{String(t.tick).padStart(2, "0")}</span>)}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* stance over time + engagement (counted series from metrics) */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel" aria-labelledby="stance-h">
          <div className="panel-head">
            <h3 id="stance-h" className="t-h3">Mean stance per issue over time</h3>
            <span className="t-meta">−1 oppose … +1 support</span>
          </div>
          <div className="panel-body">
            {stanceSeries.length > 1 ? (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={stanceSeries}>
                  <CartesianGrid stroke="var(--line-1)" strokeDasharray="3 3" />
                  <XAxis dataKey="tick" stroke="var(--fg-3)" fontSize={11} />
                  <YAxis domain={[-1, 1]} stroke="var(--fg-3)" fontSize={11} ticks={[-1, -0.5, 0, 0.5, 1]} />
                  <Tooltip contentStyle={{ background: "var(--bg-1)", border: "1px solid var(--line-2)", borderRadius: 6, fontSize: 12 }} />
                  {Object.keys(metrics?.stance_by_issue ?? {}).map((issue, i) => (
                    <Area key={issue} type="monotone" dataKey={issue}
                          stroke={i === 0 ? "var(--accent)" : i === 1 ? "var(--evt)" : "var(--neu)"}
                          fill={i === 0 ? "var(--accent)" : i === 1 ? "var(--evt)" : "var(--neu)"}
                          fillOpacity={0.12} strokeWidth={2} />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <p className="t-meta">No stance history yet — the series is drawn only from recorded stance ticks.</p>
            )}
          </div>
        </section>

        <section className="panel" aria-labelledby="eng-h">
          <div className="panel-head">
            <h3 id="eng-h" className="t-h3">Engagement per tick</h3>
            <span className="t-meta">likes + reposts + follows recorded</span>
          </div>
          <div className="panel-body">
            {engSeries.length > 1 ? (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={engSeries}>
                  <CartesianGrid stroke="var(--line-1)" strokeDasharray="3 3" />
                  <XAxis dataKey="tick" stroke="var(--fg-3)" fontSize={11} />
                  <Tooltip contentStyle={{ background: "var(--bg-1)", border: "1px solid var(--line-2)", borderRadius: 6, fontSize: 12 }} />
                  <Area type="monotone" dataKey="engagement" stroke="var(--evt)" fill="var(--evt)" fillOpacity={0.12} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <p className="t-meta">No engagement metrics recorded yet.</p>
            )}
          </div>
        </section>
      </div>

      {/* evidence distribution */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel" aria-labelledby="pages-h">
          <div className="panel-head">
            <h3 id="pages-h" className="t-h3">Most-cited pages</h3>
            <span className="t-meta">posts citing</span>
          </div>
          <div className="panel-body flex flex-col gap-2.5">
            {pageCounts.length === 0 ? (
              <p className="t-meta">No citations resolved yet. Page numbers come from the source's recorded chunks.</p>
            ) : (
              pageCounts.map((p) => (
                <div key={p.page} className="grid items-center" style={{ gridTemplateColumns: "44px minmax(0,1fr) 28px", gap: 10 }}>
                  <span className="mono" style={{ fontSize: 12 }}>p. {p.page}</span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="ellipsis fg-2 mono" style={{ fontSize: 11.5 }}>{p.chunks.slice(0, 2).join(" · ")}{p.chunks.length > 2 ? ` +${p.chunks.length - 2}` : ""}</span>
                    <span className="bar mute"><i style={{ width: `${(p.posts / pageCounts[0].posts) * 100}%` }} /></span>
                  </span>
                  <span className="mono" style={{ fontSize: 12, textAlign: "right" }}>{p.posts}</span>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="panel" aria-labelledby="agenth-h">
          <div className="panel-head">
            <h3 id="agenth-h" className="t-h3">Posts by agent</h3>
            <span className="t-meta">{stats.postsByAgent.length} speaking</span>
          </div>
          <div className="panel-body flex flex-col gap-2">
            {stats.postsByAgent.length === 0 ? (
              <p className="t-meta">No posts yet.</p>
            ) : (
              stats.postsByAgent.slice(0, 12).map((a) => {
                const dom = a.pro >= a.neu && a.pro >= a.con ? "pro" : a.con >= a.neu ? "con" : "neu";
                return (
                  <div key={a.agentId} className="grid items-center" style={{ gridTemplateColumns: "10px minmax(0,1fr) 90px 18px", gap: 10, fontSize: 12.5 }}>
                    <span className={`sg sg-${dom}`} />
                    <span className="ellipsis">{a.name}</span>
                    <span className="bar"><i style={{ width: `${(a.n / maxAgentPosts) * 100}%`, background: `var(--${dom})` }} /></span>
                    <span className="mono" style={{ textAlign: "right" }}>{a.n}</span>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>

      {/* scenario + counted snapshot */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel" aria-labelledby="scen-h">
          <div className="panel-head">
            <h3 id="scen-h" className="t-h3">Scenario</h3>
          </div>
          <div className="panel-body">
            <p className="t-body fg-2">{run.scenario.question || "—"}</p>
          </div>
        </section>
        <section className="panel" aria-labelledby="snap-h">
          <div className="panel-head">
            <h3 id="snap-h" className="t-h3">Counted snapshot</h3>
            <button className="btn btn-ghost btn-sm" onClick={regenerate} disabled={busy}>
              {busy ? "Regenerating…" : "Regenerate report"}
            </button>
          </div>
          <div className="panel-body">
            {analytics ? (
              <>
                <dl className="m-0 flex flex-wrap gap-x-6 gap-y-2">
                  {Object.entries(analytics).map(([k, v]) => (
                    <div key={k}>
                      <dt className="eyebrow" style={{ fontSize: 10 }}>{k.replace(/_/g, " ")}</dt>
                      <dd className="num mono m-0" style={{ color: "var(--fg-2)" }}>{String(v)}</dd>
                    </div>
                  ))}
                </dl>
                {generatedAt && (
                  <p className="t-id mt-2">
                    snapshot {generatedAt.slice(0, 19).replace("T", " ")} UTC
                  </p>
                )}
              </>
            ) : (
              <p className="t-meta">
                No report generated yet. It is built deterministically from this run's recorded
                rows — no AI writes it. Generate one at any time.
              </p>
            )}
          </div>
        </section>
      </div>

      {/* report */}
      {available === null ? (
        <Spinner label="Loading report…" />
      ) : !report ? (
        <section className="panel">
          <div className="empty">
            <span className="empty-ic"><FileText size={20} /></span>
            <p className="t-h3">No report yet</p>
            <p className="t-meta" style={{ maxWidth: 420 }}>
              The report counts stance landings, turning points, conversation clusters, cited
              sources and top posts straight from the database. Generate it now or wait for run
              completion (it is created automatically then).
            </p>
            <button className="btn btn-primary" onClick={regenerate} disabled={busy}>
              <FileText size={14} /> Generate report
            </button>
            <p className="eyebrow mt-4">Export raw run data</p>
            <ExportLinks runId={runId} />
          </div>
        </section>
      ) : (
        <section className="panel" aria-labelledby="rep-h">
          <div className="panel-head flex-wrap" style={{ paddingTop: 8, paddingBottom: 8, minHeight: 52 }}>
            <h3 id="rep-h" className="t-h3">Report — counted from recorded data only</h3>
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="btn btn-ghost btn-sm"
                onClick={summarize}
                disabled={essayBusy || busy}
                title="Writes an executive summary with the current provider — one real LLM call, recorded in the call log. Regenerating the report removes the summary."
              >
                <Sparkles size={13} /> {essay ? "Rewrite summary" : "Summarize with LLM"}
              </button>
              <ExportLinks runId={runId} />
            </div>
          </div>
          <div className="panel-body">
            <MiniMd text={report} />
          </div>
        </section>
      )}

      {essayBusy && (
        <section className="panel panel-body">
          <Spinner label="Asking the provider to write the summary (one real LLM call, recorded in the Log tab)…" />
        </section>
      )}
      {essay && !essayBusy && (
        <section className="panel" aria-labelledby="essay-h">
          <div className="panel-head">
            <h2 id="essay-h" className="t-h3 flex items-center gap-2">
              <Sparkles size={14} style={{ color: "var(--evt-fg)" }} />
              Executive summary — LLM DRAFT (generated, not counted data)
            </h2>
          </div>
          <div className="panel-body">
            <p className="t-id">
              {essay.meta.provider || "?"}/{essay.meta.model || "?"} · written{" "}
              {essay.meta.created_at.slice(0, 19).replace("T", " ")} UTC ·{" "}
              {essay.meta.from_cache ? "cache hit — no new call" : "1 new LLM call, logged"} · pinned to
              counting snapshot {essay.meta.report_created_at.slice(0, 19).replace("T", " ")} UTC
            </p>
            <div className="mt-3 flex flex-col gap-2.5">
              {ESSAY_LABELS.map(([key, label]) => {
                const v = (essay.sections[key] || "").trim();
                if (!v) return null;
                return (
                  <p key={key} className="t-body" style={{ color: "var(--fg-2)" }}>
                    <span className="eyebrow" style={{ fontSize: 10 }}>{label} — </span>
                    {v}
                  </p>
                );
              })}
            </div>
            <p className="t-meta mt-3" style={{ color: "var(--fg-4)" }}>
              This prose was model-generated and may paraphrase. The counted numbers above
              come only from this run's recorded rows — the essay changes nothing in them.
            </p>
          </div>
        </section>
      )}
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
