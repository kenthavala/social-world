// Run details: configuration, manifest, counted call outcomes and the full call log.
import { useEffect, useRef, useState } from "react";
import { Download, X } from "lucide-react";
import type { RunDetail } from "../types";
import * as api from "../api";
import { MockStripe, Spinner, useFocusTrap } from "../common";
import LogTab from "./LogTab";

export default function RunDetails({ run, onClose, onError, bumpKey }: {
  run: RunDetail;
  onClose: () => void;
  onError: (e: unknown) => void;
  bumpKey: number;
}) {
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(ref, onClose);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.getRunStats>> | null>(null);
  useEffect(() => {
    api.getRunStats(run.id).then(setStats).catch(() => setStats(null));
  }, [run.id, bumpKey]);

  const manifest = run.manifest ?? {};
  const provider = run.provider ?? {};
  const cfg = run.config ?? {};
  const rows: [string, string][] = [
    ["Run ID", run.id],
    ["Status", run.status],
    ["Provider", String(provider.name ?? "not recorded")],
    ["Model", String(provider.model ?? "not recorded")],
    ["Seed", String(run.seed)],
    ["Agents", String(run.agents)],
    ["Rounds", `${run.last_completed_tick}/${cfg.ticks ?? "Not recorded"}`],
    ["Writes/round", String(cfg.writes_per_tick ?? "not recorded")],
    ["LLM calls", `${run.llm_calls_used}/${run.max_llm_calls ?? "—"}`],
    ["Prompt version", String(manifest.prompt_version ?? "not recorded")],
    ["App version", String(manifest.app_version ?? "not recorded")],
    ["Source SHA-256", String(manifest.source_sha256 ?? "not recorded")],
    ["Parent run", String(run.parent_run_id ?? "Not recorded")],
  ];
  const statusRows = Object.entries(stats?.by_status ?? {}).sort((a, b) => b[1] - a[1]);
  const taskRows = Object.entries(stats?.by_task ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <>
      <button className="scrim" onClick={onClose} aria-label="Close run details" />
      <aside className="drawer" ref={ref} tabIndex={-1} role="dialog" aria-modal="true"
             aria-labelledby="rd-title">
        <div className="drawer-head">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="eyebrow">Configuration and provenance</span>
            <h2 id="rd-title" className="t-h2">Run details</h2>
            <span className="t-id">{run.id}</span>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close run details">
            <X size={15} />
          </button>
        </div>
        <div className="drawer-body">
          {String(provider.name) === "mock" && <MockStripe />}
          <dl className="kv m-0" style={{ gridTemplateColumns: "132px minmax(0,1fr)", gap: "7px 14px", fontSize: 12.5 }}>
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt>{k}</dt>
                <dd className="mono" title={v}
                    style={k === "Source SHA-256"
                      ? { wordBreak: "break-all" }
                      : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>

          <div className="flex flex-col gap-2">
            <span className="eyebrow">Recorded call outcomes</span>
            {stats === null ? <Spinner label="Loading call outcomes…" /> : (
              <div className="panel-2 p-3.5">
                <p className="t-meta">
                  {stats.calls} calls · {stats.repaired} repaired · {stats.rejected} rejected ·
                  {" "}{stats.fallback_posts} posts on a fallback model · {stats.template_posts} template posts
                  {stats.avg_latency_ms != null ? ` · average ${stats.avg_latency_ms} ms` : ""}
                </p>
                <p className="t-meta mt-2">
                  Recorded calls include setup/persona and reflection calls; the run budget counts
                  successful in-run calls, so this table can be larger than the header counter.
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {statusRows.map(([k, n]) => <span key={k} className="badge">{k} {n}</span>)}
                  {taskRows.map(([k, n]) => <span key={k} className="badge">{k} {n}</span>)}
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {(["pdf", "md", "json", "csv"] as const).map((fmt) => (
              <a key={fmt} className="btn btn-ghost btn-sm" href={api.exportUrl(run.id, fmt)} download>
                <Download size={12} /> {fmt.toUpperCase()}
              </a>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <span className="eyebrow">Every recorded call</span>
            <LogTab runId={run.id} bumpKey={bumpKey} onError={onError} />
          </div>
        </div>
      </aside>
    </>
  );
}
