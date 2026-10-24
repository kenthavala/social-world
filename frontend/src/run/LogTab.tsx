// Log: every recorded LLM call and run warning/error. Full transparency —
// successes, retries, parse failures and fallbacks all surface here.
import { useEffect, useMemo, useState } from "react";
import * as api from "../api";
import { Spinner } from "../common";

export default function LogTab({ runId, bumpKey, onError }: {
  runId: string;
  bumpKey: number;
  onError: (e: unknown) => void;
}) {
  const [calls, setCalls] = useState<Awaited<ReturnType<typeof api.getLLMCalls>>["calls"] | null>(null);
  const [errs, setErrs] = useState<Awaited<ReturnType<typeof api.getRunErrors>>["errors"] | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);

  useEffect(() => {
    api.getLLMCalls(runId).then((r) => setCalls(r.calls)).catch((e) => {
      setCalls([]);
      onError(e);
    });
    api.getRunErrors(runId).then((r) => setErrs(r.errors)).catch((e) => {
      setErrs([]);
      onError(e);
    });
  }, [runId, bumpKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    if (!calls) return [];
    return onlyProblems ? calls.filter((c) => c.status !== "ok") : calls;
  }, [calls, onlyProblems]);

  const problemCount = useMemo(() => (calls ?? []).filter((c) => c.status !== "ok").length, [calls]);

  if (calls === null) return <Spinner label="Loading log…" />;

  return (
    <div className="flex flex-col gap-4">
      {errs !== null && errs.length > 0 && (
        <section className="panel overflow-hidden">
          <div className="panel-head">
            <h2 className="t-h3" style={{ color: "var(--warn-fg)" }}>
              Warnings &amp; errors — {errs.length}
            </h2>
            <span className="t-meta">every run warning is kept, never swallowed</span>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {errs.map((e, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-xs"
                   style={i < errs.length - 1 ? { borderBottom: "1px solid var(--line-1)" } : undefined}>
                <span className={`badge ${e.kind === "error" ? "s-err" : "s-warn"}`}>{e.kind}</span>
                <span className="mono" style={{ color: "var(--fg-4)" }}>T{String(e.tick).padStart(2, "0")}</span>
                <span style={{ color: "var(--fg-2)" }}>
                  {String((e.payload as { message?: string }).message ?? "")}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="panel overflow-hidden">
        <div className="panel-head">
          <h2 className="t-h3">
            LLM calls — {calls.length}{calls.length >= 500 ? " (latest 500)" : ""}
          </h2>
          <div className="flex items-center gap-3">
            {problemCount > 0 && (
              <label className="t-meta flex cursor-pointer items-center gap-2">
                <span>Only problems ({problemCount})</span>
                <button
                  className="switch"
                  role="switch"
                  aria-checked={onlyProblems}
                  onClick={() => setOnlyProblems(!onlyProblems)}
                  aria-label="Show only failed or retried calls"
                />
              </label>
            )}
            <span className="t-meta">provider · model · latency · tokens</span>
          </div>
        </div>
        {shown.length === 0 ? (
          <div className="panel-body">
            <p className="t-meta">
              {calls.length === 0
                ? "No calls recorded yet — calls appear the moment the run starts."
                : "No problem calls — every recorded call succeeded."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto" tabIndex={0} role="group"
               aria-label="Recorded LLM calls — scrollable table">
            <table className="tbl" style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th style={{ width: 56 }}>#</th>
                  <th>Task</th>
                  <th>Status</th>
                  <th>Provider / model</th>
                  <th className="r">Latency</th>
                  <th className="r">Tokens in / out</th>
                  <th className="r">Time</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.id}>
                    <td className="mono" style={{ color: "var(--fg-4)" }}>{c.id}</td>
                    <td>
                      <span className="badge">{c.task}</span>
                      {c.error && <p className="mt-1 text-xs" style={{ color: "var(--err-fg)", maxWidth: 380 }}>{c.error}</p>}
                    </td>
                    <td>
                      <span className={`badge ${c.status === "ok" ? "s-ok" : c.status.includes("fallback") ? "s-warn" : "s-err"}`}>
                        {c.status}
                      </span>
                    </td>
                    <td className="mono" style={{ fontSize: 12, color: "var(--fg-2)" }}>
                      {c.provider}{c.model ? <span className="fg-3"> / {c.model}</span> : ""}
                    </td>
                    <td className="r mono" style={{ fontSize: 12 }}>{c.latency_ms} ms</td>
                    <td className="r mono" style={{ fontSize: 12 }}>
                      {c.tokens_in != null || c.tokens_out != null ? `${c.tokens_in ?? 0} / ${c.tokens_out ?? 0}` : "—"}
                    </td>
                    <td className="r mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>{c.created_at?.slice(11, 19)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
