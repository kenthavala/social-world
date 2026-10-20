// Log: every recorded LLM call and run warning/error. Full transparency.
import { useEffect, useState } from "react";
import * as api from "../api";
import { Spinner } from "../common";

export default function LogTab({ runId, bumpKey, onError }: {
  runId: string;
  bumpKey: number;
  onError: (e: unknown) => void;
}) {
  const [calls, setCalls] = useState<Awaited<ReturnType<typeof api.getLLMCalls>>["calls"] | null>(null);
  const [errs, setErrs] = useState<Awaited<ReturnType<typeof api.getRunErrors>>["errors"] | null>(null);

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

  if (calls === null) return <Spinner label="Loading log" />;

  return (
    <div className="flex flex-col gap-4">
      {errs !== null && errs.length > 0 && (
        <div className="panel overflow-hidden">
          <div className="px-4 py-2.5" style={{ borderBottom: "1px solid var(--line-1)" }}>
            <span className="eyebrow s-warn" style={{ color: "var(--warn-fg)" }}>
              Warnings &amp; errors — {errs.length}
            </span>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {errs.map((e, i) => (
              <div key={i} className="px-4 py-2.5 text-xs"
                   style={i < errs.length - 1 ? { borderBottom: "1px solid var(--line-1)" } : undefined}>
                <span className="badge" style={
                  e.kind === "error"
                    ? { color: "var(--err-fg)", background: "var(--err-soft)", borderColor: "var(--err-line)" }
                    : { color: "var(--warn-fg)", background: "var(--warn-soft)", borderColor: "var(--warn-line)" }
                }>
                  {e.kind}
                </span>
                <span className="mono ml-2" style={{ color: "var(--fg-4)" }}>T{e.tick}</span>
                <span className="ml-2" style={{ color: "var(--fg-2)" }}>
                  {String((e.payload as { message?: string }).message ?? "")}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="panel overflow-hidden">
        <div className="px-4 py-2.5 flex items-center" style={{ borderBottom: "1px solid var(--line-1)" }}>
          <span className="eyebrow">LLM calls — {calls.length}</span>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {calls.length === 0 ? (
            <p className="p-4 text-sm" style={{ color: "var(--fg-3)" }}>No calls recorded yet.</p>
          ) : (
            calls.map((c) => (
              <div key={c.id} className="px-4 py-2 text-xs"
                   style={{ borderBottom: "1px solid var(--line-1)" }}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mono" style={{ color: "var(--fg-4)" }}>#{c.id}</span>
                  <span className="chip">{c.task}</span>
                  <span
                    className="badge"
                    style={
                      c.status === "ok"
                        ? { color: "var(--ok-fg)", background: "var(--ok-soft)", borderColor: "var(--ok-line)" }
                        : { color: "var(--err-fg)", background: "var(--err-soft)", borderColor: "var(--err-line)" }
                    }
                  >
                    {c.status}
                  </span>
                  <span className="mono" style={{ color: "var(--fg-3)" }}>{c.provider}{c.model ? `/${c.model}` : ""}</span>
                  <span className="mono ml-auto" style={{ color: "var(--fg-4)" }}>
                    {c.latency_ms} ms{c.tokens_in != null || c.tokens_out != null
                      ? ` · in ${c.tokens_in ?? 0} / out ${c.tokens_out ?? 0}` : ""}
                    {" · "}{c.created_at?.slice(11, 19)}
                  </span>
                </div>
                {c.error && (
                  <p className="mt-1" style={{ color: "var(--err-fg)" }}>{c.error}</p>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
