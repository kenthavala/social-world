import { useEffect } from "react";
import type { AppErrorShape } from "./types";
import { ApiError } from "./api";
import { LoadingMark, Mark } from "./Brand";

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

export function EmptyState({ title, body, action, sampleHref, className = "" }: {
  title: string;
  body: React.ReactNode;
  action?: React.ReactNode;
  sampleHref?: string;
  className?: string;
}) {
  return (
    <div className={`empty panel ${className}`}>
      <div style={{ opacity: 0.45 }} aria-hidden><Mark size={40} /></div>
      <p className="t-h3">{title}</p>
      <p className="t-meta" style={{ maxWidth: 380 }}>{body}</p>
      {action}
      {sampleHref && (
        <a className="btn btn-ghost btn-sm" href={sampleHref}>Open the sample world</a>
      )}
    </div>
  );
}

export function MockStripe({ className = "" }: { className?: string }) {
  return (
    <div className={`mock-stripe ${className}`} role="note"
         style={{ padding: "9px 14px", borderRadius: "var(--r-2)", fontSize: 12.5 }}>
      <strong>Mock provider</strong> — agent posts are synthetic template text, not model
      output. Exports carry a mock watermark.
    </div>
  );
}

export function GeneratedTag({ title }: { title?: string }) {
  return <span className="generated-tag" title={title}>Generated</span>;
}

/** Trap focus in a drawer/dialog, close on Escape and restore the trigger's focus. */
export function useFocusTrap(ref: React.RefObject<HTMLElement>,
                              onClose?: () => void) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const previous = document.activeElement as HTMLElement | null;
    const selector = "a[href], button:not([disabled]), textarea:not([disabled])," +
      " input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>(selector))
      .filter((x) => x.offsetParent !== null);
    (focusables()[0] ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose?.();
        return;
      }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (f.length === 0) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [ref, onClose]);
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 t-meta" style={{ color: "var(--fg-3)" }}>
      <span className="inline-flex" aria-hidden><LoadingMark size={16} /></span>
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
