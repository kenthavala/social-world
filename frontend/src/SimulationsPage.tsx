import { useEffect, useMemo, useState } from "react";
import { FlaskConical, Plus, Search, Trash2 } from "lucide-react";
import type { RunListItem } from "./types";
import * as api from "./api";
import { Spinner, StatusBadge } from "./common";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "running", label: "Running" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
  { key: "interrupted", label: "Interrupted" },
] as const;

export default function SimulationsPage({ onOpen, onNew, onError }: {
  onOpen: (runId: string) => void;
  onNew: () => void;
  onError: (e: unknown) => void;
}) {
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [q, setQ] = useState("");

  useEffect(() => {
    api.listRuns().then((r) => setRuns(r.runs)).catch((e) => {
      setRuns([]);
      onError(e);
    });
  }, [onError]);

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
      c[f.key] = (runs ?? [])
        .filter((r) => f.key === "running"
          ? ["running", "seeding", "paused"].includes(r.status)
          : r.status === f.key).length;
    }
    return c;
  }, [runs]);

  return (
    <div className="pt-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="t-h1">Simulations</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--fg-2)" }}>
            Every run is persisted — pause, resume and inspect it later.
          </p>
        </div>
        <button className="btn-accent" onClick={onNew}>
          <Plus size={15} /> New simulation
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-52">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2"
            style={{ color: "var(--fg-4)" }} />
          <input
            className="input pl-8"
            placeholder="Search by name, document or run ID"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className="chip cursor-pointer"
            onClick={() => setFilter(f.key)}
            style={filter === f.key
              ? { borderColor: "var(--ac-line)", color: "var(--ac-fg)", background: "var(--ac-soft)" }
              : undefined}
          >
            {f.label} {counts[f.key] ?? 0}
          </button>
        ))}
      </div>

      {runs === null ? (
        <Spinner label="Loading runs" />
      ) : shown.length === 0 ? (
        <div className="panel p-10 text-center" style={{ color: "var(--fg-3)" }}>
          <FlaskConical size={22} className="mx-auto mb-3" />
          {filter === "all" && !q
            ? "No simulations yet. Create your first one."
            : "Nothing matches this filter."}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {shown.map((r) => (
            <button
              key={r.id}
              onClick={() => onOpen(r.id)}
              className="panel group flex items-start justify-between gap-4 p-4 text-left
                transition-colors hover:cursor-pointer"
              style={{ transitionProperty: "border-color, background" }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--line-3)")}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--line-2)")}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="t-h3">{r.name}</span>
                  <StatusBadge status={r.status} />
                </div>
                <div className="mt-1 text-xs" style={{ color: "var(--fg-3)" }}>
                  <span className="mono">{r.id}</span>
                  <span className="mx-1.5" aria-hidden>·</span>
                  {r.source || "no source"}
                  <span className="mx-1.5" aria-hidden>·</span>
                  tick {r.ticks_done}/{r.ticks_total || "?"}
                  <span className="mx-1.5" aria-hidden>·</span>
                  {r.llm_calls_used} LLM calls
                  <span className="mx-1.5" aria-hidden>·</span>
                  {new Date(r.created_at).toLocaleString()}
                </div>
              </div>
              <span title="Open the run to delete it">
                <Trash2
                  size={15}
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                  style={{ color: "var(--fg-4)" }}
                />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
