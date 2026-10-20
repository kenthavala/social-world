import { useEffect, useMemo, useState } from "react";
import { FlaskConical, Plus, Search, Trash2 } from "lucide-react";
import type { RunListItem } from "./types";
import * as api from "./api";
import { Spinner, StatusBadge } from "./common";

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

  async function remove(r: RunListItem) {
    try {
      await api.deleteRun(r.id);
      setRuns((cur) => (cur ?? []).filter((x) => x.id !== r.id));
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div className="pt-6 md:pt-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="t-h1">Simulations</h1>
          <p className="t-body fg-2 mt-1">
            Every run is persisted locally — pause, resume and inspect it later.
          </p>
        </div>
        <button className="btn btn-primary" onClick={onNew}>
          <Plus size={15} /> New simulation
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="input-wrap min-w-52 flex-1" style={{ maxWidth: 360 }}>
          <Search className="ic-sm" aria-hidden />
          <input
            className="input"
            placeholder="Search by name, document or run ID"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </span>
        {FILTERS.map((f) => (
          <button key={f.key} className="chip" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label} <span className="chip-n">{counts[f.key] ?? 0}</span>
          </button>
        ))}
      </div>

      {runs === null ? (
        <div className="panel panel-body"><Spinner label="Loading runs…" /></div>
      ) : shown.length === 0 ? (
        <div className="empty panel">
          <span className="empty-ic"><FlaskConical size={20} /></span>
          <p className="t-h3">{filter === "all" && !q ? "No simulations yet" : "Nothing matches"}</p>
          <p className="t-meta" style={{ maxWidth: 320 }}>
            {filter === "all" && !q
              ? "Create your first simulation from a document — the wizard walks through source, brief, agents and run."
              : "Try a different filter or clear the search."}
          </p>
          {filter === "all" && !q && (
            <button className="btn btn-primary" onClick={onNew}><Plus size={14} /> New simulation</button>
          )}
        </div>
      ) : (
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="tbl" style={{ minWidth: 760 }}>
              <thead>
                <tr>
                  <th>Simulation</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th className="r">Ticks</th>
                  <th className="r">LLM calls</th>
                  <th style={{ width: 48 }} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} onClick={() => onOpen(r.id)} style={{ cursor: "pointer" }}>
                    <td style={{ maxWidth: 340 }}>
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="row-link ellipsis">{r.name}</span>
                        <span className="t-meta ellipsis">{r.source ?? "no source document"} · <span className="mono">{r.id}</span></span>
                      </div>
                    </td>
                    <td><StatusBadge status={r.status} /></td>
                    <td style={{ fontSize: 12.5 }}>{relTime(r.created_at)}</td>
                    <td className="r mono num" style={{ fontSize: 12.5 }}>{r.ticks_done}/{r.ticks_total || "—"}</td>
                    <td className="r mono num" style={{ fontSize: 12.5 }}>{r.llm_calls_used}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button
                        className="btn btn-ghost btn-sm btn-icon"
                        title={["running", "seeding"].includes(r.status) ? "Stop the run before deleting it" : "Delete run and all its data"}
                        onClick={() => remove(r)}
                        aria-label={`Delete ${r.name}`}
                      >
                        <Trash2 size={14} style={{ color: "var(--fg-4)" }} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
