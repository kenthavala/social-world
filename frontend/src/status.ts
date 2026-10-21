// Single source of truth for document/source status in the UI.
//
// The backend lifecycle (app/api/sources.py) has exactly three states:
//   extracting -> extracted   success; text, chunks and page bounds exist
//   extracting -> failed      extraction failed; `error` explains why
// There is no backend "ready" state: "ready" is a presentation label here
// meaning "extracted and usable for a brief or a run". The raw backend status
// is always kept on the object so detail views can show it verbatim.

export type StatusTone = "ok" | "warn" | "err" | "run" | "idle";

export interface SourceStatusMeta {
  status: string;
  label: string;
  tone: StatusTone;
  live: boolean;
  usable: boolean;
  detail: string;
}

const STATUSES: Record<string, SourceStatusMeta> = {
  extracted: {
    status: "extracted",
    label: "Ready",
    tone: "ok",
    live: false,
    usable: true,
    detail: "Text extracted, cleaned and chunked with page bounds — citations can resolve.",
  },
  extracting: {
    status: "extracting",
    label: "Extracting",
    tone: "run",
    live: true,
    usable: false,
    detail: "Text, chunks and the BM25 index are being built.",
  },
  failed: {
    status: "failed",
    label: "Failed",
    tone: "err",
    live: false,
    usable: false,
    detail: "Extraction failed — the document cannot be used until it is re-uploaded.",
  },
};

export function sourceStatusMeta(status: string | null | undefined): SourceStatusMeta {
  const key = (status || "").toLowerCase();
  return STATUSES[key] ?? {
    status: key || "unknown",
    label: status || "Unknown",
    tone: "idle",
    live: false,
    usable: false,
    detail: "Unrecognised source status.",
  };
}

// Badge classes from the design system (index.css).
export function sourceBadgeClass(tone: StatusTone): string {
  switch (tone) {
    case "ok": return "s-ok";
    case "err": return "s-err";
    case "run": return "s-run";
    case "warn": return "s-warn";
    default: return "";
  }
}

// Status pill classes (the larger .status component).
export function sourceStatusPill(tone: StatusTone): string {
  switch (tone) {
    case "ok": return "status-ready";
    case "err": return "status-failed";
    case "run": return "status-ingesting";
    default: return "status-queued";
  }
}
