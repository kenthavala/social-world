import { useEffect, useMemo, useState } from "react";
import { ChevronDown, FileText, Plus } from "lucide-react";
import * as api from "./api";
import { navigate } from "./router";
import { Spinner } from "./common";

interface Doc {
  id?: string;
  source_id?: string;
  filename: string;
  status: string;
  pages?: number | null;
  chunks?: number | null;
  has_brief?: boolean;
  created_at?: string;
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

export default function DocumentsPage({ onError }: { onError: (e: unknown) => void }) {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [openChunk, setOpenChunk] = useState<string | null>(null);
  const [chunks, setChunks] = useState<ChunkLite[] | null>(null);

  useEffect(() => {
    api.listSources().then((r) => {
      const sources = ((r.sources || []) as unknown) as Doc[];
      setDocs(sources);
      if (sources.length) setSel(sources[0].id ?? sources[0].source_id ?? null);
    }).catch((e) => {
      setDocs([]);
      onError(e);
    });
  }, [onError]);

  useEffect(() => {
    setOpenChunk(null);
    if (!sel) { setChunks(null); return; }
    api.listChunks(sel).then((r) => setChunks(r.chunks)).catch(() => setChunks([]));
  }, [sel]);

  const selDoc = useMemo(() => docs?.find((d) => (d.id ?? d.source_id) === sel) ?? null, [docs, sel]);

  return (
    <div className="pt-8">
      <div className="mb-6">
        <h1 className="t-h1">Documents</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--fg-2)" }}>
          Every chunk agents can cite, with its real page range and citation count.
        </p>
      </div>

      {docs === null ? (
        <Spinner label="Loading documents" />
      ) : docs.length === 0 ? (
        <div className="panel p-10 text-center" style={{ color: "var(--fg-3)" }}>
          <FileText size={22} className="mx-auto mb-3" />
          No documents yet. Upload one from the new-simulation wizard.
        </div>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(260px, 340px) 1fr" }}>
          <div className="flex flex-col gap-2">
            {docs.map((d) => {
              const id = d.id ?? d.source_id ?? "";
              const active = id === sel;
              return (
                <button
                  key={id}
                  onClick={() => setSel(id)}
                  className="panel p-3 text-left"
                  style={active ? { borderColor: "var(--ac-line)", cursor: "pointer" } : { cursor: "pointer" }}
                >
                  <div className="flex items-center gap-2">
                    <FileText size={14} style={{ color: "var(--fg-3)" }} />
                    <span className="truncate t-h3" title={d.filename}>
                      {d.filename}
                    </span>
                  </div>
                  <div className="mono mt-1 flex items-center gap-2 text-[11px]" style={{ color: "var(--fg-3)" }}>
                    <span
                      className="badge"
                      style={
                        d.status === "ready"
                          ? { color: "var(--ok-fg)", background: "var(--ok-soft)", borderColor: "var(--ok-line)" }
                          : d.status === "failed"
                            ? { color: "var(--err-fg)", background: "var(--err-soft)", borderColor: "var(--err-line)" }
                            : undefined
                      }
                    >
                      {d.status === "ready" ? "READY" : d.status.toUpperCase()}
                    </span>
                    {d.pages != null && <span>{d.pages} pp</span>}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="min-w-0">
            {selDoc && (
              <div className="panel mb-4 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="t-h2">{selDoc.filename}</h2>
                  <button className="btn-accent btn-sm" onClick={() => navigate({ name: "wizard" })}>
                    <Plus size={13} /> New simulation from this document
                  </button>
                </div>
                <div className="mono mt-2 text-[11px]" style={{ color: "var(--fg-3)" }}>
                  <span className="mono">{selDoc.id ?? selDoc.source_id}</span>
                  <span className="mx-1.5" aria-hidden>·</span>
                  {selDoc.pages ?? "?"} pages
                  <span className="mx-1.5" aria-hidden>·</span>
                  {chunks?.length ?? "…"} chunks
                  <span className="mx-1.5" aria-hidden>·</span>
                  {selDoc.has_brief ? "brief generated" : "no brief"}
                </div>
              </div>
            )}

            {chunks === null ? null : chunks.length === 0 ? (
              <div className="panel p-6 text-center text-xs" style={{ color: "var(--fg-3)" }}>
                No chunks recorded for this document.
              </div>
            ) : (
              <div
                className="panel flex max-h-[70vh] flex-col overflow-hidden"
              >
                <div
                  className="flex-none px-4 py-2.5"
                  style={{ borderBottom: "1px solid var(--line-1)" }}
                >
                  <span className="eyebrow">Chunks</span>
                </div>
                <div className="overflow-y-auto">
                  {chunks.map((c) => {
                    const open = openChunk === c.id;
                    return (
                      <div key={c.id} style={{ borderBottom: "1px solid var(--line-1)" }}>
                        <button
                          className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs"
                          style={{ color: "var(--fg-3)" }}
                          onClick={() => setOpenChunk(open ? null : c.id)}
                          aria-expanded={open}
                        >
                          <ChevronDown size={12} className="flex-none"
                                       style={{ transform: open ? "none" : "rotate(-90deg)", color: "var(--fg-4)" }} />
                          <span className="mono">{c.id}</span>
                          {c.page_start != null && (
                            <span className="mono">
                              p. {c.page_start}{c.page_end != null && c.page_end !== c.page_start ? `–${c.page_end}` : ""}
                            </span>
                          )}
                          {c.n_words != null && <span className="mono">{c.n_words} words</span>}
                          <span className="mono ml-auto">
                            {c.citations > 0 ? `${c.citations} citation${c.citations === 1 ? "" : "s"}` : "uncited"}
                          </span>
                        </button>
                        {open && (
                          <ChunkDetail sourceId={sel} chunk={c} />
                        )}
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
    <div className="px-4 pb-3 pl-10">
      <p className="eyebrow mb-1">{chunk.heading || full?.heading || ""}</p>
      <div className="rounded p-3 text-sm leading-relaxed whitespace-pre-wrap"
           style={{ background: "var(--bg-2)", border: "1px solid var(--line-1)", color: "var(--fg-1)" }}>
        {full?.text ?? "loading…"}
      </div>
    </div>
  );
}
