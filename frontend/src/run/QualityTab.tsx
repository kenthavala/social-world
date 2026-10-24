// Quality: Simulation Quality panel showing the Realism Score with 17 dimensions.
// All scores are computed from stored rows. No invented data.
// Clearly distinguishes REALISM (configuration quality) from PREDICTIVE ACCURACY.
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Info, AlertCircle, CheckCircle, XCircle, MinusCircle, HelpCircle } from "lucide-react";
import type { RunDetail } from "../types";
import * as api from "../api";
import { Spinner } from "../common";

const DIMENSION_GROUPS = [
  { key: "Evidence", label: "Evidence", icon: "📄", color: "var(--accent)" },
  { key: "Population", label: "Population", icon: "👥", color: "var(--pro-fg)" },
  { key: "Behaviour", label: "Behaviour", icon: "🧠", color: "var(--neu-fg)" },
  { key: "Network", label: "Network", icon: "🔗", color: "var(--con-fg)" },
  { key: "Temporal", label: "Temporal", icon: "⏱", color: "var(--evt-fg)" },
  { key: "Configuration", label: "Configuration", icon: "⚙️", color: "var(--fg-2)" },
  { key: "Robustness", label: "Robustness", icon: "🔬", color: "var(--warn-fg)" },
  { key: "Validation", label: "Validation", icon: "📊", color: "var(--source)" },
] as const;

function statusBadge(status: string, score: number | null) {
  const labels: Record<string, { label: string; class: string }> = {
    assessed: { label: "Assessed", class: "status-assessed" },
    partial: { label: "Partial", class: "status-partial" },
    not_assessed: { label: "Not assessed", class: "status-not-assessed" },
    not_connected: { label: "Not connected", class: "status-not-connected" },
  };
  const s = labels[status] || { label: status, class: "status-unknown" };
  return (
    <span className={`status ${s.class}`}>
      <span className="dot" />
      {s.label}
      {score != null && <span className="score"> {score}</span>}
    </span>
  );
}

function StatusDot(status: string) {
  const cls = status === "assessed" ? "dot-ok" : status === "partial" ? "dot-warn" : "dot-idle";
  return <span className={`dot ${cls}`} />;
}

interface QualityTabProps {
  run: RunDetail;
  runId: string;
  onError: (e: unknown) => void;
}

interface RealismDimension {
  id: string;
  label: string;
  group: string;
  weight: number;
  status: string;
  score: number | null;
  explanation: string;
  evidence: Record<string, unknown>;
  recommendation?: string;
  requires?: string;
}

export default function QualityTab({ run, runId, onError }: QualityTabProps) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getRealism>> | null>(null);
  const [busy, setBusy] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setBusy(true);
      try {
        const r = await api.getRealism(runId);
        if (!cancelled) setData(r);
      } catch (e) {
        if (!cancelled) onError(e);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [runId, onError]);

  // Every hook must run on every render: the loading and empty states return
  // further down, AFTER this memo. Returning before a hook was what produced
  // "rendered more hooks than during the previous render" on first load.
  const grouped = useMemo(() => {
    const m = new Map<string, RealismDimension[]>();
    for (const d of data?.dimensions ?? []) {
      if (!m.has(d.group)) m.set(d.group, []);
      m.get(d.group)!.push(d);
    }
    return m;
  }, [data]);

  if (busy) return <div className="flex items-center justify-center h-64"><Spinner label="Loading quality assessment…" /></div>;
  if (!data) return <div className="panel p-6"><p className="t-meta">Unable to load quality data.</p></div>;

  const overall = data.overall;
  const dimensions = data.dimensions;
  const accuracy = data.predictive_accuracy;
  const validation = data.validation;
  const summary = data.summary;

  const toggleGroup = (group: string) => {
    setExpanded((prev) => ({ ...prev, [group]: !prev[group] }));
  };

  return (
    <div className="flex flex-col gap-6">
      {/* --- Overall Score Card --- */}
      <section className="panel" aria-labelledby="overall-h">
        <div className="panel-head">
          <h2 id="overall-h" className="t-h2 flex items-center gap-2">
            <span style={{ fontSize: 20 }}>📋</span>
            Simulation Quality Score
          </h2>
          <span className="t-meta">Configuration quality — NOT predictive accuracy</span>
        </div>
        <div className="panel-body grid gap-4 md:grid-cols-[1fr_320px]">
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-4 p-4" style={{ background: "var(--bg-1)", borderRadius: "var(--r-2)" }}>
              <div className="flex flex-col items-center" style={{ minWidth: 80 }}>
                <span className="stat-v mono" style={{ fontSize: 40, fontWeight: 700, color: overall.label === "Strong configuration" ? "var(--pro-fg)" : overall.label === "Moderate configuration" ? "var(--accent)" : overall.label === "Limited configuration" ? "var(--warn-fg)" : overall.label === "Exploratory configuration" ? "var(--con-fg)" : "var(--fg-3)" }}>
                  {overall.score ?? "—"}
                </span>
                <span className="t-meta" style={{ fontSize: 11 }}>/100</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="t-h3" style={{ color: overall.label === "Strong configuration" ? "var(--pro-fg)" : overall.label === "Moderate configuration" ? "var(--accent)" : overall.label === "Limited configuration" ? "var(--warn-fg)" : overall.label === "Exploratory configuration" ? "var(--con-fg)" : "var(--fg-3)" }}>
                  {overall.label}
                </p>
                <p className="t-body fg-2 mt-1">{overall.method}</p>
                <p className="t-meta mt-2">
                  {overall.assessed_dimensions} of {overall.total_dimensions} dimensions assessed · Weighted average of assessed only
                </p>
              </div>
            </div>

            {/* Predictive Accuracy */}
            <div className="panel-2 p-4 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span style={{ fontSize: 18 }}>🎯</span>
                <span className="t-h3">Predictive Accuracy</span>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <span className={`status ${accuracy.status === "data_connected" ? "status-assessed" : "status-not-connected"}`}>
                  <span className="dot" />
                  {accuracy.label}
                </span>
                {accuracy.observations > 0 && (
                  <span className="t-meta">{accuracy.observations} observation(s) connected</span>
                )}
              </div>
              <p className="t-meta" style={{ color: "var(--fg-3)" }}>{accuracy.message}</p>
            </div>

            {/* Validation Status */}
            <div className="panel-2 p-4 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span style={{ fontSize: 18 }}>📊</span>
                <span className="t-h3">Validation Data</span>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <span className={`status ${validation.connected ? "status-assessed" : "status-not-connected"}`}>
                  <span className="dot" />
                  {validation.connected ? "Connected" : "Not connected"}
                </span>
                <span className="t-meta">{validation.datasets} dataset(s), {validation.observations} observation(s)</span>
              </div>
              <p className="t-meta" style={{ color: "var(--fg-3)" }}>{validation.message}</p>
            </div>
          </div>

          {/* Legend — single column: this card is ~320px wide, so a multi-column
              grid forced the labels outside the panel. */}
          <div className="panel-2 p-4">
            <h3 className="eyebrow mb-3">Status legend</h3>
            <div className="flex flex-col gap-2">
              <LegendItem status="assessed" />
              <LegendItem status="partial" />
              <LegendItem status="not_assessed" />
              <LegendItem status="not_connected" />
            </div>
          </div>
        </div>
      </section>

      {/* --- Diagnostic summary + how to improve --- */}
      <section className="panel" aria-labelledby="improve-h">
        <div className="panel-head">
          <h2 id="improve-h" className="t-h2">How can I improve this simulation?</h2>
          <span className="t-meta">Ordered by how much each gap affects the score</span>
        </div>
        <div className="panel-body flex flex-col gap-4">
          <p className="t-body" style={{ maxWidth: 760 }}>{summary.headline}</p>

          <div className="grid gap-3 lg:grid-cols-3">
            <div className="panel-2 p-3.5">
              <div className="eyebrow" style={{ color: "var(--pro-fg)" }}>What is strong</div>
              {summary.strong.length === 0 ? (
                <p className="t-meta mt-1">No dimension scored 75 or above.</p>
              ) : (
                <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
                  {summary.strong.map((s) => (
                    <li key={s.id} className="t-body fg-2 flex items-baseline justify-between gap-3">
                      <span>{s.label}</span>
                      <span className="mono" style={{ color: "var(--pro-fg)" }}>{s.score}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="panel-2 p-3.5">
              <div className="eyebrow" style={{ color: "var(--warn-fg)" }}>What needs attention</div>
              {summary.attention.length === 0 ? (
                <p className="t-meta mt-1">Nothing scored below 60.</p>
              ) : (
                <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
                  {summary.attention.map((s) => (
                    <li key={s.id} className="t-body fg-2 flex items-baseline justify-between gap-3">
                      <span>{s.label}</span>
                      <span className="mono" style={{ color: "var(--warn-fg)" }}>{s.score}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="panel-2 p-3.5">
              <div className="eyebrow">What could not be assessed</div>
              {summary.not_assessed.length === 0 ? (
                <p className="t-meta mt-1">Every dimension had enough data.</p>
              ) : (
                <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
                  {summary.not_assessed.slice(0, 6).map((s) => (
                    <li key={s.id} className="t-meta" title={s.requires}>
                      {s.label} — <span className="fg-3">{s.status.replace("_", " ")}</span>
                    </li>
                  ))}
                  {summary.not_assessed.length > 6 && (
                    <li className="t-meta">+{summary.not_assessed.length - 6} more below</li>
                  )}
                </ul>
              )}
            </div>
          </div>

          {summary.actions.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="eyebrow">Recommended actions</div>
              {summary.actions.map((a) => (
                <div key={a.dimension} className="panel-2 p-3.5"
                     style={{ borderLeft: "3px solid var(--warn-fg)" }}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="t-h4">{a.label}</span>
                    <span className="badge">{a.group} · {a.score ?? "—"}/100</span>
                  </div>
                  <p className="t-body mt-1">{a.recommendation}</p>
                  {a.requires && (
                    <p className="t-meta mt-1">Would make measurable: {a.requires}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          <p className="t-meta">
            None of these actions change what this run already recorded. They describe how a
            future run could be configured better. Improving the score does not create
            real-world predictive accuracy.
          </p>
        </div>
      </section>

      {/* --- Dimension Details --- */}
      {DIMENSION_GROUPS.map((group) => {
        const dims = grouped.get(group.key) ?? [];
        if (dims.length === 0) return null;
        const isOpen = expanded[group.key] ?? true;
        return (
          <section key={group.key} className="panel" aria-labelledby={`group-${group.key}-h`}>
            <div className="panel-head" onClick={() => toggleGroup(group.key)} style={{ cursor: "pointer" }}>
              <h3 id={`group-${group.key}-h`} className="t-h3 flex items-center gap-2">
                <span style={{ fontSize: 18 }}>{group.icon}</span>
                {group.label}
                <span className="mono fg-3 ml-auto">{dims.filter((d: RealismDimension) => d.score != null).length}/{dims.length} assessed</span>
                <span className="mono" style={{ transform: isOpen ? "rotate(180deg)" : "rotate(0)", transition: "transform 150ms" }}>
                  ▼
                </span>
              </h3>
            </div>
            {isOpen && (
              <div className="panel-body flex flex-col gap-3">
                {dims.map((dim: RealismDimension) => (
                  <DimensionCard key={dim.id} dim={dim} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function LegendItem({ status }: { status: string }) {
  const labels: Record<string, string> = {
    assessed: "Assessed — scored from recorded data",
    partial: "Partial — some data, limited scoring",
    not_assessed: "Not assessed — no data or not implemented",
    not_connected: "Not connected — validation data required",
  };
  return (
    <div className="flex items-start gap-2 p-2" style={{ background: "var(--bg-1)", borderRadius: "var(--r-2)" }}>
      <span className={`status ${status === "assessed" ? "status-assessed" : status === "partial" ? "status-partial" : status === "not_connected" ? "status-not-connected" : "status-not-assessed"}`} style={{ fontSize: 11, flex: "0 0 auto" }}>
        <span className="dot" />
        {status.replace("_", " ")}
      </span>
      <span className="t-meta" style={{ fontSize: 11, minWidth: 0 }}>{labels[status]}</span>
    </div>
  );
}

function DimensionCard({ dim }: { dim: RealismDimension }) {
  const score = dim.score;
  const status = dim.status;
  const showScore = score != null;
  const scoreColor = showScore
    ? score >= 80 ? "var(--pro-fg)"
    : score >= 60 ? "var(--accent)"
    : score >= 40 ? "var(--warn-fg)"
    : "var(--con-fg)"
    : "var(--fg-4)";

  return (
    <div className="panel-2 p-4 flex flex-col gap-2" style={{ borderLeft: `4px solid ${showScore ? scoreColor : "var(--fg-4)"}` }}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2 flex-1 min-w-0">
          <span className="t-h4 truncate">{dim.label}</span>
          <span className="t-meta">{dim.group}</span>
        </div>
        <div className="flex items-center gap-2">
          {showScore && <span className="stat-v mono" style={{ fontSize: 20, fontWeight: 600, color: scoreColor }}>{score}</span>}
          {statusBadge(status, score)}
        </div>
      </div>
      <p className="t-body fg-2" style={{ fontSize: 13 }}>{dim.explanation}</p>
      {dim.recommendation && (
        <div className="panel-2 p-2.5" style={{ background: "var(--bg-0)" }}>
          <div className="eyebrow">How to improve</div>
          <p className="t-body fg-2 mt-1" style={{ fontSize: 12.5 }}>{dim.recommendation}</p>
          {dim.requires && (
            <p className="t-meta mt-1">Becomes measurable when: {dim.requires}</p>
          )}
        </div>
      )}
      {dim.evidence && Object.keys(dim.evidence).length > 0 && (
        <details className="mt-2">
          <summary className="t-meta cursor-pointer select-none">Evidence</summary>
          <pre className="mt-2 p-3 mono" style={{ fontSize: 11, background: "var(--bg-0)", borderRadius: "var(--r-1)", overflow: "auto", color: "var(--fg-2)" }}>
            {JSON.stringify(dim.evidence, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

export type { QualityTabProps };