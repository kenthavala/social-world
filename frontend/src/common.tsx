import type { AppErrorShape } from "./types";
import { ApiError } from "./api";

export function ErrorBanner({ err, onDismiss }: { err: unknown; onDismiss?: () => void }) {
  if (!err) return null;
  let message: string;
  let hint: string | null = null;
  let stage = "";
  if (err instanceof ApiError) {
    message = err.message;
    hint = err.hint;
    stage = err.stage;
  } else if (err && typeof err === "object" && "error" in (err as AppErrorShape)) {
    const e = (err as AppErrorShape).error;
    message = e.message;
    hint = e.hint;
    stage = `${e.component}/${e.stage}`;
  } else {
    message = String(err);
  }
  return (
    <div className="mb-4 rounded-xl border border-red-900/60 bg-red-950/40 p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-red-300">{message}</p>
          {hint && <p className="mt-1 text-ink-300">{hint}</p>}
          {stage && <p className="mt-1 text-xs text-ink-500">at {stage}</p>}
        </div>
        {onDismiss && (
          <button onClick={onDismiss} className="text-ink-500 hover:text-ink-100" aria-label="dismiss">
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-ink-300">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-500 border-t-accent" />
      {label}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    running: "bg-sky-500/20 text-sky-300",
    completed: "bg-emerald-500/20 text-emerald-300",
    failed: "bg-red-500/20 text-red-300",
    interrupted: "bg-amber-500/20 text-amber-300",
    paused: "bg-amber-500/20 text-amber-300",
    draft: "bg-ink-700 text-ink-300",
    ready: "bg-violet-500/20 text-violet-300",
    seeding: "bg-violet-500/20 text-violet-300",
  };
  return <span className={`badge ${colors[status] ?? "bg-ink-700 text-ink-300"}`}>{status}</span>;
}
