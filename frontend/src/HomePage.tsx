import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { RunListItem } from "./types";
import * as api from "./api";
import { Spinner, StatusBadge } from "./common";

export default function HomePage({ onNew, onOpen, onError, settingsVersion }: {
  onNew: () => void;
  onOpen: (runId: string) => void;
  onError: (e: unknown) => void;
  settingsVersion: number;
}) {
  const [runs, setRuns] = useState<RunListItem[] | null>(null);

  useEffect(() => {
    api.listRuns().then((r) => setRuns(r.runs)).catch((e) => {
      setRuns([]);
      onError(e);
    });
  }, [onError, settingsVersion]);

  return (
    <main>
      <section className="mb-10">
        <h1 className="mb-2 text-3xl font-bold">Simulate your document</h1>
        <p className="max-w-2xl text-sm text-ink-300">
          Upload a PDF/TXT/DOCX, describe the scenario, and watch seeded agents debate its issues —
          every tick is persisted locally in SQLite so you can pause, crash-test and resume runs.
        </p>
        <button className="btn-primary mt-4" onClick={onNew}>
          <Plus size={16} /> New simulation
        </button>
      </section>

      <section>
        <h2 className="label">Previous runs</h2>
        {runs === null ? (
          <Spinner label="Loading runs…" />
        ) : runs.length === 0 ? (
          <div className="card text-sm text-ink-500">No runs yet. Start your first simulation above.</div>
        ) : (
          <div className="grid gap-3">
            {runs.map((r) => (
              <div key={r.id} className="card flex items-center justify-between gap-4">
                <button className="min-w-0 flex-1 text-left" onClick={() => onOpen(r.id)}>
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{r.name}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="mt-1 truncate text-xs text-ink-500">
                    {r.source ? `${r.source} · ` : ""}
                    tick {r.ticks_done}/{r.ticks_total} · {r.llm_calls_used} LLM calls ·{" "}
                    {r.created_at && !isNaN(new Date(r.created_at).getTime())
                      ? new Date(r.created_at).toLocaleString()
                      : "—"}
                  </div>
                </button>
                <button
                  className="text-ink-500 hover:text-red-400"
                  title="Delete run"
                  onClick={async () => {
                    try {
                      await api.deleteRun(r.id);
                      setRuns(runs.filter((x) => x.id !== r.id));
                    } catch (e) {
                      onError(e);
                    }
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
