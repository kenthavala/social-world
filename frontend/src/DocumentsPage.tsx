// Sources: an evidence library. Each document shows what was extracted, what it is
// linked to (issues, stakeholder groups, findings, runs) and how much of it the
// simulations actually cited. Every relationship here is read from the database;
// where one cannot be derived the page says so instead of implying it exists.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ChevronRight, FileText, Plus, Search, Upload,
} from "lucide-react";
import * as api from "./api";
import { navigate } from "./router";
import { EmptyState, Spinner } from "./common";
import { sourceStatusMeta, sourceStatusPill } from "./status";
import type { SourceEvidence } from "./types";

interface Doc {
  id?: string;
  source_id?: string;
  filename: string;
  status: string;
  pages?: number | null;
  chunks?: number | null;
  words?: number | null;
  has_brief?: boolean;
  used_by?: number;
  created_at?: string;
  error?: string | null;
}

const idOf = (d: Doc) => (d.id ?? d.source_id ?? "") as string;

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

type Tab = "overview" | "issues" | "stakeholders" | "findings" | "evidence";

export default function DocumentsPage({ onError, initialSource }: {
  onError: (e: unknown) => void;
  initialSource?: string;
}) {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [sel, setSel] = useState<string | null>(initialSource ?? null);
  const [evidence, setEvidence] = useState<SourceEvidence | null>(null);
  const [evBusy, setEvBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [openChunk, setOpenChunk] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    api.listSources().then((r) => {
      if (!alive) return;
      const sources = ((r.sources || []) as unknown) as Doc[];
      setDocs(sources);
      const ids = new Set(sources.map(idOf));
      const preferred = initialSource && ids.has(initialSource)
        ? initialSource
        : (sources[0] ? idOf(sources[0]) : null);
      setSel((cur) => (cur && ids.has(cur) ? cur : preferred));
    }).catch((e) => {
      if (!alive) return;
      setDocs([]);
      onError(e);
    });
    return () => { alive = false; };
  }, [onError, initialSource]);

  useEffect(() => {
    if (!sel) { setEvidence(null); return; }
    let alive = true;
    setEvBusy(true);
    setOpenChunk(null);
    api.getSourceEvidence(sel)
      .then((r) => { if (alive) setEvidence(r); })
      .catch((e) => { if (alive) { setEvidence(null); onError(e); } })
      .finally(() => { if (alive) setEvBusy(false); });
    return () => { alive = false; };
  }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps

  async function upload(file: File | null) {
    if (!file) return;
    setBusy(true);
    onError(null);
    try {
      const stats = await api.uploadSource(file);
      const r = await api.listSources();
      setDocs(((r.sources || []) as unknown) as Doc[]);
      setSel(stats.source_id);
      setTab("overview");
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return docs ?? [];
    return (docs ?? []).filter((d) => d.filename.toLowerCase().includes(q));
  }, [docs, query]);

  const selDoc = useMemo(
    () => (docs ?? []).find((d) => idOf(d) === sel) ?? null,
    [docs, sel]);
  const selMeta = selDoc ? sourceStatusMeta(selDoc.status) : null;

  if (!docs) return <div className="pt-8"><Spinner label="Loading the evidence library…" /></div>;

  return (
    <div className="pt-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="t-h1">Evidence library</h1>
          <p className="t-body fg-2 mt-1" style={{ maxWidth: 640 }}>
            The documents your agents read. Each one shows what was extracted, which
            issues and groups it informs, and how much of it the simulations actually cited.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.docx" className="hidden"
                 onChange={(e) => upload(e.target.files?.[0] ?? null)} aria-label="Upload document" />
          <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
            <Upload size={14} /> {busy ? "Extracting…" : "Upload"}
          </button>
          <button className="btn btn-primary" onClick={() => navigate({ name: "wizard" })}>
            <Plus size={14} /> New simulation
          </button>
        </div>
      </header>

      {docs.length === 0 ? (
        <EmptyState
          title="No documents yet"
          body="Upload a PDF, Markdown, text or DOCX file with a text layer. It is extracted into page-bounded chunks that agents can cite."
        />
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          {/* ---------------- document list ---------------- */}
          <aside className="panel">
            <div className="panel-head">
              <h2 className="t-h3">Documents ({docs.length})</h2>
            </div>
            <div className="p-2">
              <span className="input-wrap mb-2 block">
                <Search className="ic" aria-hidden />
                <input className="input" placeholder="Search documents…" value={query}
                       onChange={(e) => setQuery(e.target.value)}
                       aria-label="Search documents" />
              </span>
              <div className="flex max-h-[62vh] flex-col gap-1 overflow-y-auto">
                {filtered.length === 0 && (
                  <p className="t-meta p-2">No document matches “{query}”.</p>
                )}
                {filtered.map((d) => {
                  const id = idOf(d);
                  const meta = sourceStatusMeta(d.status);
                  const active = id === sel;
                  return (
                    <button key={id} onClick={() => { setSel(id); setTab("overview"); }}
                            className={`list-row ${active ? "is-selected" : ""}`}
                            aria-current={active ? "true" : undefined}
                            style={{ padding: "8px 9px", alignItems: "flex-start" }}>
                      <FileText size={14} style={{ marginTop: 2, color: "var(--fg-3)", flex: "0 0 auto" }} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate" style={{ fontWeight: active ? 600 : 500 }}>
                          {d.filename}
                        </span>
                        <span className="t-meta block">
                          {d.pages ?? 0} pp · {d.chunks ?? 0} chunks
                          {d.used_by ? ` · ${d.used_by} run${d.used_by === 1 ? "" : "s"}` : ""}
                        </span>
                        <span className={`status ${sourceStatusPill(meta.tone)} mt-1`}>
                          <span className={`dot${meta.live ? " dot-pulse" : ""}`} />
                          {meta.label}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>

          {/* ---------------- detail ---------------- */}
          <section className="panel" aria-live="polite">
            {!selDoc ? (
              <div className="panel-body">
                <p className="t-meta">Select a document to inspect its evidence.</p>
              </div>
            ) : (
              <>
                <div className="panel-head flex-wrap">
                  <div className="min-w-0">
                    <h2 className="t-h2 truncate">{selDoc.filename}</h2>
                    <p className="t-meta">
                      Uploaded {fmtDate(selDoc.created_at)} · {selDoc.pages ?? 0} pages ·{" "}
                      {selDoc.chunks ?? 0} chunks · {(selDoc.words ?? 0).toLocaleString()} words
                    </p>
                  </div>
                  <span className={`status ${selMeta ? sourceStatusPill(selMeta.tone) : ""}`}>
                    <span className="dot" />
                    {selMeta?.label ?? selDoc.status}
                  </span>
                </div>

                <div className="flex flex-wrap gap-2 px-4 pt-3">
                  {([
                    ["overview", "Overview"],
                    ["issues", `Issues${evidence ? ` (${evidence.issues.length})` : ""}`],
                    ["stakeholders", `Stakeholders${evidence ? ` (${evidence.stakeholder_groups.length})` : ""}`],
                    ["findings", `Findings${evidence ? ` (${evidence.findings.length})` : ""}`],
                    ["evidence", `Passages${evidence ? ` (${evidence.chunks.length})` : ""}`],
                  ] as const).map(([key, label]) => (
                    <button key={key} className="chip"
                            aria-pressed={tab === key} onClick={() => setTab(key)}>
                      {label}
                    </button>
                  ))}
                </div>

                <div className="panel-body">
                  {evBusy && !evidence ? (
                    <Spinner label="Reading the evidence profile…" />
                  ) : !evidence ? (
                    <p className="t-meta">Could not load this document's evidence profile.</p>
                  ) : (
                    <>
                      {evidence.notes.length > 0 && (
                        <div className="banner banner-warn mb-3" role="status">
                          <AlertTriangle size={14} style={{ flex: "0 0 auto", marginTop: 2 }} />
                          <span>{evidence.notes.join(" ")}</span>
                        </div>
                      )}

                      {tab === "overview" && <Overview ev={evidence} onTab={setTab} />}
                      {tab === "issues" && <Issues ev={evidence} />}
                      {tab === "stakeholders" && <Stakeholders ev={evidence} />}
                      {tab === "findings" && <FindingsRows ev={evidence} />}
                      {tab === "evidence" && (
                        <Passages ev={evidence} openChunk={openChunk} setOpenChunk={setOpenChunk} />
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Overview({ ev, onTab }: { ev: SourceEvidence; onTab: (t: Tab) => void }) {
  const c = ev.coverage;
  if (!c.chunks_total) {
    return <p className="t-meta">No chunks were extracted from this document.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      <dl className="m-0 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Pages" value={String(ev.stats.pages || 0)} />
        <Stat label="Chunks" value={String(ev.stats.chunks)} />
        <Stat label="Passages cited" value={`${c.chunks_cited} / ${c.chunks_total}`} />
        <Stat label="Citations" value={String(c.citation_total)} />
      </dl>

      <div>
        <div className="eyebrow mb-1">Evidence coverage</div>
        <div className="h-2 w-full overflow-hidden" style={{ borderRadius: 99, background: "var(--bg-0)" }}>
          <span style={{ display: "block", height: "100%", width: `${c.pct_chunks_cited ?? 0}%`, background: "var(--accent)" }} />
        </div>
        <p className="t-meta mt-1">
          {c.pct_chunks_cited == null
            ? "Not enough recorded evidence to compute coverage."
            : `${c.pct_chunks_cited}% of this document's passages were cited at least once across `
              + `${c.runs} simulation${c.runs === 1 ? "" : "s"} (${c.posts_citing} posts).`}
        </p>
      </div>

      {ev.brief.summary && (
        <div className="panel-2 p-3.5">
          <div className="eyebrow">Scenario brief</div>
          <p className="t-body fg-2 mt-1">{ev.brief.summary}</p>
          {ev.brief.generated_by?.provider && (
            <p className="t-meta mt-1">
              Drafted with {ev.brief.generated_by.provider}
              {ev.brief.generated_by.model ? ` / ${ev.brief.generated_by.model}` : ""}.
            </p>
          )}
        </div>
      )}

      <div>
        <div className="eyebrow mb-1">Simulations using this document</div>
        {ev.usage.length === 0 ? (
          <p className="t-meta">No simulation has used this document yet.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {ev.usage.map((u) => (
              <button key={u.run_id} className="list-row" style={{ padding: "7px 9px" }}
                      onClick={() => navigate({ name: "run", runId: u.run_id })}>
                <span className="min-w-0 flex-1 truncate">{u.name}</span>
                <span className="t-meta">{u.rounds} rounds</span>
                <span className="t-meta">{u.posts_citing} citing</span>
                <span className="badge">{u.status}</span>
                <ChevronRight size={13} />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button className="btn btn-ghost btn-sm" onClick={() => onTab("issues")}>
          {ev.issues.length} issue{ev.issues.length === 1 ? "" : "s"}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => onTab("stakeholders")}>
          {ev.stakeholder_groups.length} stakeholder group{ev.stakeholder_groups.length === 1 ? "" : "s"}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => onTab("findings")}>
          {ev.findings.length} finding{ev.findings.length === 1 ? "" : "s"}
        </button>
      </div>
    </div>
  );
}

function Issues({ ev }: { ev: SourceEvidence }) {
  if (ev.issues.length === 0) {
    return (
      <p className="t-meta">
        No issues are recorded for this document. Generate a brief from the Wizard to derive them.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {ev.issues.map((i) => (
        <div key={i.id ?? i.name} className="panel-2 p-3.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="t-h4">{i.name}</span>
            <span className="badge">{i.evidence_chunks_found} passage{i.evidence_chunks_found === 1 ? "" : "s"} linked</span>
          </div>
          {i.question && <p className="t-body fg-2 mt-1">{i.question}</p>}
          <p className="t-meta mt-1">
            {i.evidence_chunks_declared === 0
              ? "This issue does not point at a specific passage; the whole document is its context."
              : i.evidence_chunks_found === 0
                ? "The brief points at passages that are no longer present in this document."
                : "Linked passages: " + i.evidence_chunk_ids.join(", ")}
          </p>
        </div>
      ))}
    </div>
  );
}

function Stakeholders({ ev }: { ev: SourceEvidence }) {
  if (ev.stakeholder_groups.length === 0) {
    return (
      <p className="t-meta">
        No stakeholder groups are recorded for this document. Generate a brief from the Wizard
        to derive them.
      </p>
    );
  }
  return (
    <div className="grid gap-2 md:grid-cols-2">
      {ev.stakeholder_groups.map((g) => (
        <div key={g.name} className="panel-2 p-3.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="t-h4">{g.name}</span>
            <span className="badge">{g.agents} agent{g.agents === 1 ? "" : "s"} seeded</span>
          </div>
          {g.description && <p className="t-body fg-2 mt-1">{g.description}</p>}
          <p className="t-meta mt-1">
            Size hint: {g.size_hint}
            {g.influence != null ? ` · influence ${g.influence}` : ""}
            {g.agents === 0 ? " · no agent has represented this group yet" : ""}
          </p>
          {g.concerns.length > 0 && (
            <p className="t-meta mt-1">Concerns: {g.concerns.join(" · ")}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function FindingsRows({ ev }: { ev: SourceEvidence }) {
  if (ev.findings.length === 0) {
    return (
      <p className="t-meta">
        Not enough recorded evidence: no finding from a completed run cites this document yet.
      </p>
    );
  }
  const runName = ev.findings[0]?.run_name;
  return (
    <div className="flex flex-col gap-2">
      <p className="t-meta">
        Findings from the most recent completed run that used this document ({runName}) which
        reference it. Findings are per-run; open the run to see the full briefing.
      </p>
      {ev.findings.map((f) => (
        <button key={`${f.run_id}-${f.finding_id}`} className="list-row"
                style={{ padding: "8px 10px" }}
                onClick={() => navigate({ name: "run", runId: f.run_id })}>
          <span className="min-w-0 flex-1">
            <span className="block">{f.title}</span>
            <span className="t-meta block">{f.rows} row(s) · denominator {f.denominator} {f.unit}</span>
          </span>
          <ChevronRight size={13} />
        </button>
      ))}
    </div>
  );
}

function Passages({ ev, openChunk, setOpenChunk }: {
  ev: SourceEvidence;
  openChunk: string | null;
  setOpenChunk: (id: string | null) => void;
}) {
  if (ev.chunks.length === 0) {
    return <p className="t-meta">No passages were extracted from this document.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="t-meta">
        The most-cited passages first. A passage with zero citations exists in the document
        but was not used by any recorded post.
      </p>
      {ev.chunks.map((c) => {
        const open = openChunk === c.id;
        return (
          <div key={c.id} className="panel-2 p-3">
            <button className="flex w-full flex-wrap items-baseline gap-2 text-left"
                    onClick={() => setOpenChunk(open ? null : c.id)}
                    aria-expanded={open}>
              <span className="t-id">{c.id}</span>
              <span className="cite-p">
                p. {c.page_start ?? "—"}
                {c.page_end != null && c.page_end !== c.page_start ? `–${c.page_end}` : ""}
              </span>
              {c.heading && <span className="t-meta truncate">{c.heading}</span>}
              <span className="badge ml-auto">
                {c.citations} citation{c.citations === 1 ? "" : "s"}
              </span>
            </button>
            <p className="t-meta mt-1">{c.excerpt}…</p>
            {open && (
              <p className="t-meta mt-1">
                {c.n_words ?? 0} words · cited by {c.post_ids.length} of {c.citations} posts
                {c.post_ids.length < c.citations ? " (first few shown)" : ""}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel-2 p-2.5">
      <dt className="t-meta">{label}</dt>
      <dd className="mono m-0 mt-0.5" style={{ fontSize: 16, color: "var(--fg-1)" }}>{value}</dd>
    </div>
  );
}
