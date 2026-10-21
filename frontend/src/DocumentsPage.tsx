import { useEffect, useMemo, useState } from "react";
import { ChevronDown, FileText, Plus } from "lucide-react";
import * as api from "./api";
import { navigate } from "./router";
import { Spinner } from "./common";
import {
  sourceBadgeClass, sourceStatusMeta, sourceStatusPill,
} from "./status";

interface Doc {
  id?: string;
  source_id?: string;
  filename: string;
  status: string;
  pages?: number | null;
  chunks?: number | null;
  words?: number | null;
  has_brief?: boolean;
  created_at?: string;
  error?: string | null;
}

interface ChunkLite {
  id: string;
  idx: number;
  page_start: number | null;
  page_end: number | null;
  heading?: string | null;
  n_words?: number | null;
  citations: number;
}

export default function DocumentsPage({ onError, initialSource }: {
  onError: (e: unknown) => void;
  initialSource?: string;
}) {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [sel, setSel] = useState<string | null>(initialSource ?? null);
  const [openChunk, setOpenChunk] = useState<string | null>(null);
  const [chunks, setChunks] = useState<ChunkLite[] | null>(null);

  useEffect(() => {
    let alive = true;
    api.listSources().then((r) => {
      if (!alive) return;
      const sources = ((r.sources || []) as unknown) as Doc[];
      setDocs(sources);
      const ids = new Set(sources.map((d) => d.id ?? d.source_id));
      const preferred = initialSource && ids.has(initialSource)
        ? initialSource
        : (sources[0] ? (sources[0].id ?? sources[0].source_id ?? null) : null);
      setSel(preferred);
    }).catch((e) => {
      if (!alive) return;
      setDocs([]);
      onError(e);
    });
    return () => { alive = false; };
  }, [onError, initialSource]);

  useEffect(() => {
    setOpenChunk(null);
    if (!sel) { setChunks(null); return; }
    api.listChunks(sel).then((r) => setChunks(r.chunks)).catch(() => setChunks([]));
  }, [sel]);

  const selDoc = useMemo(() => docs?.find((d) => (d.id ?? d.source_id) === sel) ?? null, [docs, sel]);
  const selMeta = selDoc ? sourceStatusMeta(selDoc.status) : null;

  return (
    <div className="pt-6 md:pt-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="t-h1">Documents</h1>
          <p className="t-body fg-2 mt-1">
            Every chunk agents can cite, with its real page range and citation count.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => navigate({ name: "wizard" })}>
          <Plus size={14} /> New simulation
        </button>
      </div>

      {docs === null ? (
        <div className="panel panel-body"><Spinner label="Loading documents…" /></div>
      ) : docs.length === 0 ? (
        <div className="empty panel">
          <span className="empty-ic"><FileText size={20} /></span>
          <p className="t-h3">No documents yet</p>
          <p className="t-meta" style={{ maxWidth: 340 }}>
            Upload a source document to begin — ingestion extracts text, cleans boilerplate and
            chunks it so agents can cite exact pages.
          </p>
          <button className="btn btn-primary" onClick={() => navigate({ name: "wizard" })}>
            <Plus size={14} /> Upload in the wizard
          </button>
        </div>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          <div className="panel overflow-hidden">
            {docs.map((d, i) => {
              const id = d.id ?? d.source_id ?? "";
              const active = id === sel;
              const meta = sourceStatusMeta(d.status);
              return (
                <button
                  key={id}
                  onClick={() => setSel(id)}
                  className={`list-row ${active ? "is-selected" : ""}`}
                  style={{ borderBottom: i < docs.length - 1 ? "1px solid var(--line-1)" : 0, alignItems: "flex-start" }}
                >
                  <FileText size={14} style={{ color: "var(--fg-3)", marginTop: 3 }} />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="t-h3 ellipsis" title={d.filename}>{d.filename}</span>
                    <span className="t-meta flex flex-wrap items-center gap-2">
                      <span className={`badge ${sourceBadgeClass(meta.tone)}`} style={{ fontSize: 10 }}
                            title={`${meta.detail} Backend status: ${d.status}`}>
                        {meta.label}
                      </span>
                      {d.pages != null && <span className="mono">{d.pages} pp</span>}
                      {d.chunks != null && <span className="mono">{d.chunks} chunks</span>}
                      <span>{d.has_brief ? "brief generated" : "no brief"}</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="min-w-0 flex flex-col gap-4">
            {selDoc && (
              <div className="panel">
                <div className="panel-head flex-wrap" style={{ minHeight: 56, padding: "10px 16px" }}>
                  <div className="min-w-0">
                    <h2 className="t-h2 ellipsis" title={selDoc.filename}>{selDoc.filename}</h2>
                    <p className="t-meta mono mt-0.5">
                      {selDoc.id ?? selDoc.source_id}
                    </p>
                  </div>
                  <button
                    className="btn btn-accent btn-sm"
                    disabled={!selMeta?.usable}
                    title={selMeta?.usable
                      ? "Start a new simulation with this document preselected"
                      : "This document is not ready for a run"}
                    onClick={() => sel && navigate({ name: "wizard", sourceId: sel })}
                  >
                    <Plus size={13} /> New simulation from this document
                  </button>
                </div>
                <dl className="kv panel-body" style={{ gridTemplateColumns: "120px minmax(0,1fr)", gap: "8px 16px", fontSize: 12.5 }}>
                  <dt>Status</dt>
                  <dd className="flex flex-wrap items-center gap-2">
                    <span className={`badge ${selMeta ? sourceBadgeClass(selMeta.tone) : ""}`}>
                      {selMeta?.label ?? selDoc.status}
                    </span>
                    <span className="t-id" title="Raw backend status">{selDoc.status}</span>
                    {selMeta && <span className="t-meta">{selMeta.detail}</span>}
                  </dd>
                  <dt>Pages</dt><dd className="mono">{selDoc.pages ?? "?"}</dd>
                  <dt>Source chunks</dt><dd className="mono">{selDoc.chunks ?? chunks?.length ?? "…"}</dd>
                  <dt>Words</dt><dd className="mono">{(selDoc.words ?? 0).toLocaleString()}</dd>
                  <dt>Brief</dt><dd>{selDoc.has_brief ? "generated" : "not generated yet"}</dd>
                  <dt>Created</dt>
                  <dd className="mono">{selDoc.created_at ? selDoc.created_at.slice(0, 19).replace("T", " ") + " UTC" : "—"}</dd>
                  <dt>Citation counts</dt><dd>per chunk, counted across all runs</dd>
                </dl>
                {selDoc.error && (
                  <div className="banner banner-err mx-4 mb-4" role="status">
                    <span>{selDoc.error}</span>
                  </div>
                )}
              </div>
            )}

            {chunks === null ? null : chunks.length === 0 ? (
              <div className="panel panel-body">
                <p className="t-meta">No chunks recorded for this document.</p>
              </div>
            ) : (
              <div className="panel flex max-h-[70vh] flex-col overflow-hidden">
                <div className="panel-head">
                  <span className="eyebrow">Chunks — {chunks.length}</span>
                  <span className="t-meta">click a row to read the extracted text</span>
                </div>
                <div className="overflow-y-auto">
                  {chunks.map((c) => {
                    const open = openChunk === c.id;
                    return (
                      <div key={c.id} style={{ borderBottom: "1px solid var(--line-1)" }}>
                        <button
                          className="list-row"
                          onClick={() => setOpenChunk(open ? null : c.id)}
                          aria-expanded={open}
                          style={{ gap: 10, paddingTop: 10, paddingBottom: 10 }}
                        >
                          <ChevronDown size={13} className="flex-none"
                                       style={{ transform: open ? "none" : "rotate(-90deg)", color: "var(--fg-4)" }} />
                          <span className="mono" style={{ fontSize: 12 }}>{c.id}</span>
                          {c.page_start != null && (
                            <span className="mono t-meta">
                              p. {c.page_start}{c.page_end != null && c.page_end !== c.page_start ? `–${c.page_end}` : ""}
                            </span>
                          )}
                          {c.n_words != null && <span className="mono t-meta">{c.n_words} words</span>}
                          <span className={`badge ml-auto ${c.citations > 0 ? "s-run" : ""}`} style={{ fontSize: 10 }}>
                            {c.citations > 0 ? `${c.citations} citation${c.citations === 1 ? "" : "s"}` : "uncited"}
                          </span>
                        </button>
                        {open && <ChunkDetail sourceId={sel} chunk={c} />}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ChunkDetail({ sourceId, chunk }: { sourceId: string | null; chunk: ChunkLite }) {
  const [full, setFull] = useState<{ text: string; heading?: string | null } | null>(null);

  useEffect(() => {
    if (!sourceId) return;
    api.getChunk(sourceId, chunk.id).then(setFull).catch(() => setFull({ text: "(chunk text unavailable)" }));
  }, [sourceId, chunk.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="pb-3.5 pl-11 pr-4">
      <p className="eyebrow mb-1.5">{chunk.heading || full?.heading || ""}</p>
      <div className="inset p-3.5" style={{ fontSize: 13.5, lineHeight: 1.7, whiteSpace: "pre-wrap", color: "var(--fg-1)" }}>
        {full?.text ?? "loading…"}
      </div>
    </div>
  );
}
