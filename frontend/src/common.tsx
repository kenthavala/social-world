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
    <div className="banner banner-err mb-4" role="alert" style={{ alignItems: "flex-start" }}>
      <svg className="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden style={{ color: "var(--err)", marginTop: 1 }}>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 5v3.5M8 11v.01" />
      </svg>
      <div className="min-w-0 flex-1">
        <p style={{ fontWeight: 500, color: "var(--fg-1)" }}>{message}</p>
        {hint && <p className="t-meta mt-1">{hint}</p>}
        {stage && <p className="t-id mt-1">at {stage}</p>}
      </div>
      {onDismiss && (
        <button onClick={onDismiss} className="btn btn-ghost btn-sm btn-icon" aria-label="Dismiss error">
          <svg className="ic-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      )}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 t-meta" style={{ color: "var(--fg-3)" }}>
      <span className="spin" style={{ color: "var(--accent)" }} />
      {label}
    </span>
  );
}

// Design status vocabulary: label + dot/icon, never color alone.
const STATUS_MAP: Record<string, { cls: string; label: string }> = {
  running: { cls: "status-running", label: "Running" },
  seeding: { cls: "status-running", label: "Seeding" },
  paused: { cls: "status-paused", label: "Paused" },
  interrupted: { cls: "status-paused", label: "Interrupted" },
  completed: { cls: "status-completed", label: "Completed" },
  failed: { cls: "status-failed", label: "Failed" },
  error: { cls: "status-failed", label: "Failed" },
  stopped: { cls: "status-queued", label: "Stopped" },
  draft: { cls: "status-draft", label: "Draft" },
  ready: { cls: "status-ready", label: "Ready" },
  queued: { cls: "status-queued", label: "Queued" },
  ingesting: { cls: "status-ingesting", label: "Ingesting" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS_MAP[status] ?? { cls: "status-queued", label: status };
  const isLive = ["running", "seeding", "ingesting"].includes(status);
  const isDone = ["completed", "ready"].includes(status);
  const isFailed = ["failed", "error"].includes(status);
  return (
    <span className={`status ${s.cls}`}>
      {isLive ? (
        <span className="dot dot-pulse" style={{ marginLeft: -1 }} />
      ) : isDone ? (
        <svg className="ic-xs" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 8.5 6.5 12 13 4.5" />
        </svg>
      ) : isFailed ? (
        <svg className="ic-xs" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      ) : (
        <span className="dot" />
      )}
      {s.label}
    </span>
  );
}
