// Insights: auto-generated report + counted-from-the-DB analytics. No model-generated counts.
// The executive-summary essay is the ONE generated element — rendered only inside its
// clearly-labeled "LLM draft" card; every other number on this page is counted.
import { useEffect, useState } from "react";
import { Bot, Download, FileJson, FileText, FolderArchive, FlaskConical, Sparkles } from "lucide-react";
import * as api from "../api";
import { Spinner } from "../common";
import type { EssaySummary } from "../api";

const ESSAY_LABELS: [string, string][] = [
  ["executive_summary", "Headline"],
  ["opinion_shifts", "Where opinion moved"],
  ["emerging_narratives", "Narrative threads"],
  ["influential_agents", "Influential voices"],
  ["communities", "Communities"],
  ["key_events", "Events"],
  ["contradictions", "Contradictions"],
  ["unexpected_outcomes", "Unexpected"],
  ["limitations", "Limits"],
];

// Tiny markdown-lite renderer: #/##/### headers, "- " bullets, **bold**, `code`, "---" rules.
type ReactLike = React.ReactNode;

function inline(s: string, keyBase: string): ReactLike {
  const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith("**") && p.endsWith("**") && p.length > 4)
          return <strong key={`${keyBase}-${i}`} style={{ color: "var(--fg-1)" }}>{p.slice(2, -2)}</strong>;
        if (p.startsWith("`") && p.endsWith("`") && p.length > 2)
          return <code key={`${keyBase}-${i}`} className="mono" style={{ fontSize: "0.9em" }}>{p.slice(1, -1)}</code>;
        return <span key={`${keyBase}-${i}`}>{p}</span>;
      })}
    </>
  );
}

// Raw-data downloads: real endpoints, generated straight from the DB rows.
function ExportLinks({ runId }: { runId: string }) {
  const items: Array<{ fmt: string; label: string; icon: typeof Download }> = [
    { fmt: "json", label: "JSON", icon: FileJson },
    { fmt: "md", label: "Markdown", icon: FileText },
    { fmt: "csv", label: "CSV zip", icon: FolderArchive },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(({ fmt, label, icon: Icon }) => (
        <a
          key={fmt}
          className="btn-ghost btn-sm"
          href={api.exportUrl(runId, fmt)}
          download
          style={{ textDecoration: "none" }}
        >
          <Icon size={13} /> <Download size={11} style={{ opacity: 0.7 }} /> {label}
        </a>
      ))}
    </div>
  );
}

function MiniMd({ text }: { text: string }) {
  return (
    <div className="mt-2 text-sm">
      {text.split("\n").map((ln, i) => {
        if (ln.startsWith("### ")) return <h3 key={i} className="t-h3 mt-3">{inline(ln.slice(4), `h${i}`)}</h3>;
        if (ln.startsWith("## ")) return <h3 key={i} className="t-h2 mt-4">{inline(ln.slice(3), `h${i}`)}</h3>;
        if (ln.startsWith("# ")) return <h3 key={i} className="t-h1">{inline(ln.slice(2), `h${i}`)}</h3>;
        if (ln === "---" || ln === "") return <div key={i} style={{ height: 8 }} />;
        if (ln.startsWith("- "))
          return (
            <div key={i} className="flex gap-2 pl-1">
              <span aria-hidden style={{ color: "var(--fg-4)" }}>–</span>
              <span style={{ color: "var(--fg-2)" }}>{inline(ln.slice(2), `b${i}`)}</span>
            </div>
          );
        return <p key={i} style={{ color: "var(--fg-2)" }}>{inline(ln, `p${i}`)}</p>;
      })}
    </div>
  );
}

export default function InsightsTab({ runId, bumpKey, onError }: {
  runId: string;
  bumpKey: number;
  onError: (e: unknown) => void;
}) {
  const [report, setReport] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<Record<string, unknown> | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [essay, setEssay] = useState<EssaySummary | null>(null);
  const [essayBusy, setEssayBusy] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getReport(runId).then((r) => {
      setReport(r.report_md);
      setAvailable(r.available);
      setAnalytics((r.analytics as Record<string, unknown>) ?? null);
      setGeneratedAt(r.created_at ?? null);
      setEssay(r.essay ?? null);
    }).catch((e) => {
      setAvailable(false);
      onError(e);
    });
  }, [runId, bumpKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function regenerate() {
    setBusy(true);
    onError(null);
    try {
      const r = await api.generateReport(runId);
      setReport(r.report_md);
      setAnalytics((r.analytics as Record<string, unknown>) ?? null);
      setGeneratedAt(r.created_at ?? null);
      setAvailable(true);
      setEssay(null);   // the regenerated snapshot invalidates the old summary
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function summarize() {
    setEssayBusy(true);
    onError(null);
    try {
      const r = await api.generateEssay(runId);
      setEssay(r.essay);
    } catch (e) {
      onError(e);
    } finally {
      setEssayBusy(false);
    }
  }

  if (available === null) return <Spinner label="Loading insights" />;

  if (!report) {
    return (
      <div className="panel p-10 text-center text-sm" style={{ color: "var(--fg-3)" }}>
        <FlaskConical size={20} className="mx-auto mb-2" />
        <p className="mb-3">No report generated yet. It is built deterministically from this run's
          recorded rows — no AI writes it. You can generate one at any time.</p>
        <button className="btn-primary" onClick={regenerate} disabled={busy}>
          <FlaskConical size={14} /> Generate report
        </button>
        {busy && <div className="mt-2"><Spinner label="Counting…" /></div>}
        <p className="eyebrow mt-6" style={{ fontSize: 11 }}>Export raw run data</p>
        <div className="mt-2 flex justify-center"><ExportLinks runId={runId} /></div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {analytics && (
        <div className="panel p-4">
          <div className="flex flex-wrap items-center">
            <span className="eyebrow">Run summary — counted from recorded data only</span>
            <button className="btn-ghost btn-sm ml-auto" onClick={regenerate} disabled={busy}>
              {busy ? "Regenerating…" : "Regenerate report"}
            </button>
          </div>
          {generatedAt && (
            <p className="mono mt-0.5 text-[10px]" style={{ color: "var(--fg-4)" }}>
              snapshot {generatedAt.slice(0, 19).replace("T", " ")} UTC
            </p>
          )}
          <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-xs">
            {Object.entries(analytics as Record<string, unknown>).map(([k, v]) => (
              <div key={k}>
                <dt className="eyebrow" style={{ fontSize: 10 }}>{k.replace(/_/g, " ")}</dt>
                <dd className="num" style={{ color: "var(--fg-2)" }}>{String(v)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <div className="panel p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="eyebrow">Report</span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {report && (
              <button
                className={essay ? "btn-ghost btn-sm" : "btn-ghost btn-sm"}
                onClick={summarize}
                disabled={essayBusy || busy}
                title="Writes an executive summary with the current provider — one real LLM call, recorded in the call log. Regenerating the report removes the summary."
              >
                <Sparkles size={13} /> {essay ? "Rewrite summary" : "Summarize with LLM"}
              </button>
            )}
            <div><ExportLinks runId={runId} /></div>
          </div>
        </div>
        <div className="max-h-[70vh] overflow-auto">
          <MiniMd text={report} />
        </div>
      </div>
      {essayBusy && (
        <div className="panel p-4">
          <Spinner label="Asking the provider to write the summary (one real LLM call)…" />
        </div>
      )}
      {essay && !essayBusy && (
        <div className="panel p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Bot size={14} style={{ color: "var(--fg-3)" }} />
            <span className="eyebrow">Executive summary — LLM DRAFT (generated, not counted data)</span>
          </div>
          <p className="mono mt-1 text-[10px]" style={{ color: "var(--fg-4)" }}>
            {essay.meta.provider || "?"}/{essay.meta.model || "?"} · written{" "}
            {essay.meta.created_at.slice(0, 19).replace("T", " ")} UTC ·{" "}
            {essay.meta.from_cache ? "cache hit — no new call" : "1 new LLM call, logged"} · pinned to
            counting snapshot {essay.meta.report_created_at.slice(0, 19).replace("T", " ")} UTC
          </p>
          <div className="mt-3 flex flex-col gap-2.5">
            {ESSAY_LABELS.map(([key, label]) => {
              const v = (essay.sections[key] || "").trim();
              if (!v) return null;
              return (
                <p key={key} className="text-sm" style={{ color: "var(--fg-2)" }}>
                  <span className="eyebrow" style={{ fontSize: 10 }}>{label} — </span>
                  {v}
                </p>
              );
            })}
          </div>
          <p className="mt-3 text-[11px]" style={{ color: "var(--fg-4)" }}>
            This prose was model-generated and may paraphrase. The counted numbers above
            come only from this run's recorded rows — the essay changes nothing in them.
          </p>
        </div>
      )}
    </div>
  );
}
