"""Source upload + ingestion + world brief endpoints."""
from __future__ import annotations

import hashlib
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, Form, UploadFile
from pydantic import BaseModel

from app import db
from app.config import DATA_DIR, config
from app.errors import AppError
from app.ingest import extract as extract_mod
from app.ingest import chunk as chunk_mod
from app.ingest import clean as clean_mod
from app.ingest import index as index_mod
from app.ingest import brief as brief_mod

router = APIRouter(prefix="/api")

ALLOWED = {".pdf", ".txt", ".md", ".docx"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def extract_text_document(data: bytes, name: str) -> dict:
    """Shared ingest pipeline used by the upload endpoint and by tests.

    Source lifecycle (the only real states in the database):
      extracting -> extracted    success; text, chunks and page bounds exist
      extracting -> failed       extraction/cleaning/chunking failed; `error` explains
    A re-upload of the same sha reuses the existing row: an extracted document is
    deduplicated, a failed/interrupted one is re-ingested in place.
    """
    suffix = Path(name).suffix.lower()
    if suffix not in ALLOWED:
        raise AppError(f"unsupported file type '{suffix or '(none)'}' (use .pdf .txt .md .docx)",
                       component="api", stage="upload")
    if len(data) > config.max_upload_mb * 1024 * 1024:
        raise AppError(f"file exceeds the {config.max_upload_mb} MB limit",
                       component="api", stage="upload")
    sha = hashlib.sha256(data).hexdigest()
    existing = db.query_one("SELECT id, status FROM sources WHERE sha256=?", (sha,))
    if existing is not None and existing["status"] == "extracted":
        stats = _source_stats(existing["id"])
        stats["deduplicated"] = True
        return stats
    # Reuse the row that owns this sha (a previous attempt failed or was interrupted);
    # inserting again would trip the UNIQUE(sha256) constraint.
    return _ingest_new(data, name, sha, existing_id=existing["id"] if existing else None)


async def upload_source(
    file: Optional[UploadFile] = File(default=None),
    text: Optional[str] = Form(default=None),
    filename: Optional[str] = Form(default=None),
) -> dict:
    data = None
    name = ""
    if file is not None and hasattr(file, "read"):
        data = await file.read()
        name = getattr(file, "filename", None) or "upload.bin"
    elif text is not None:
        data = text.encode("utf-8")
        name = filename or "pasted.txt"
    else:
        raise AppError("provide a file or text", component="api", stage="upload")
    return extract_text_document(data, name)


def _ingest_new(data: bytes, name: str, sha: str, existing_id: Optional[str] = None) -> dict:
    suffix = Path(name).suffix.lower()
    source_id = existing_id or "src_" + uuid.uuid4().hex[:10]
    dest = DATA_DIR / "uploads" / source_id
    dest.mkdir(parents=True, exist_ok=True)
    (dest / f"original{suffix}").write_bytes(data)

    if existing_id:
        # Retry of a failed/interrupted attempt: clear the old extraction in place.
        db.execute("DELETE FROM chunks WHERE source_id=?", (source_id,))
        db.execute(
            "UPDATE sources SET filename=?, kind='file', pages=0, status='extracting',"
            " brief_json=NULL, error=NULL WHERE id=?",
            (name, source_id))
    else:
        db.execute(
            "INSERT INTO sources(id, filename, sha256, kind, pages, created_at, status, brief_json, error)"
            " VALUES(?,?,?,?,?,?,?,?,?)",
            (source_id, name, sha, "file", 0, _now(), "extracting", None, None))
    try:
        extracted = extract_mod.extract(data, name, max_pages=config.max_pages)
    except Exception as e:
        db.execute("UPDATE sources SET status='failed', error=? WHERE id=?",
                   (str(e)[:300], source_id))
        raise AppError(f"could not extract text: {str(e)[:200]}", component="ingest",
                       stage="extract", error_type="extract_failed")
    scanned_error = (extract_mod.scanned_check(extracted["pages"])
                     if suffix == ".pdf" else None)
    if scanned_error:
        db.execute("UPDATE sources SET status='failed', error=? WHERE id=?",
                   (scanned_error, source_id))
        raise AppError(scanned_error, component="ingest", stage="extract",
                       error_type="scanned_pdf")
    pages = clean_mod.clean_pages(extracted["pages"])
    if extracted["empty"]:
        db.execute("UPDATE sources SET status='failed', error=? WHERE id=?",
                   ("No readable text found.", source_id))
        raise AppError("No readable text found in this file.", component="ingest", stage="clean")
    chunks = chunk_mod.chunk_pages(pages, source_id)
    if not chunks:
        db.execute("UPDATE sources SET status='failed', error=? WHERE id=?",
                   ("Document produced no chunks.", source_id))
        raise AppError("Document produced no text chunks.", component="ingest", stage="chunk")
    with db.tx() as conn:
        conn.execute("DELETE FROM chunks WHERE source_id=?", (source_id,))
        for c in chunks:
            conn.execute(
                "INSERT INTO chunks(id, source_id, idx, text, page_start, page_end, heading, n_words)"
                " VALUES(?,?,?,?,?,?,?,?)",
                (c["id"], source_id, c["idx"], c["text"], c["page_start"], c["page_end"],
                 c["heading"], c["n_words"]))
        conn.execute("UPDATE sources SET status='extracted', pages=? WHERE id=?",
                     (len(pages), source_id))
    idx = index_mod.SourceIndex(source_id)
    idx.build([c["id"] for c in chunks], [c["text"] for c in chunks])
    index_mod.put_index(idx)
    stats = _source_stats(source_id)
    stats["truncated"] = extracted["truncated"]
    return stats


def _source_stats(source_id: str) -> dict:
    row = db.query_one("SELECT * FROM sources WHERE id=?", (source_id,))
    if row is None:
        raise AppError("source not found", component="api", stage="sources", status_code=404)
    n_chunks = db.scalar("SELECT COUNT(*) FROM chunks WHERE source_id=?", (source_id,)) or 0
    words = db.scalar("SELECT COALESCE(SUM(n_words),0) FROM chunks WHERE source_id=?",
                      (source_id,)) or 0
    return {"source_id": source_id, "filename": row["filename"], "kind": row["kind"],
            "pages": row["pages"], "chunks": n_chunks, "words": words,
            "status": row["status"], "error": row["error"],
            "has_brief": bool(row["brief_json"]),
            # the stored brief travels with the detail so the wizard can reuse it
            # instead of paying for a regeneration on every visit
            "brief": db.uj(row["brief_json"]) if row["brief_json"] else None}


@router.post("/sources")
async def upload(
    file: Optional[UploadFile] = File(default=None),
    text: Optional[str] = Form(default=None),
    filename: Optional[str] = Form(default=None),
) -> dict:
    return await upload_source(file, text, filename)


@router.get("/sources")
def list_sources() -> dict:
    rows = db.query(
        "SELECT s.id, s.filename, s.status, s.pages, s.created_at, s.brief_json,"
        " (SELECT COUNT(*) FROM chunks c WHERE c.source_id=s.id) AS chunks,"
        " (SELECT COALESCE(SUM(c.n_words),0) FROM chunks c WHERE c.source_id=s.id) AS words,"
        " (SELECT COUNT(*) FROM runs r WHERE r.source_id=s.id) AS used_by"
        " FROM sources s ORDER BY s.created_at DESC LIMIT 200")
    return {"sources": [{k: v for k, v in dict(r).items() if k != "brief_json"}
                        | {"has_brief": bool(r["brief_json"])} for r in rows]}


@router.get("/sources/{source_id}/evidence")
def source_evidence(source_id: str) -> dict:
    """An evidence profile for one document.

    Every relationship returned here is derived from stored rows: the brief that was
    generated for this source, the runs that used it, the posts that cited its chunks
    and the findings those runs produced. Where a relationship cannot be derived the
    field is empty and `notes` says so — nothing is invented for display.
    """
    src = db.query_one("SELECT * FROM sources WHERE id=?", (source_id,))
    if src is None:
        raise AppError("source not found", component="api", stage="evidence", status_code=404)

    brief = db.uj(src["brief_json"], {}) if src["brief_json"] else {}
    chunk_rows = db.query(
        "SELECT id, idx, page_start, page_end, heading, n_words, text FROM chunks"
        " WHERE source_id=? ORDER BY idx", (source_id,))
    chunk_ids = {c["id"] for c in chunk_rows}

    # Citation counts, restricted to this source's chunks.
    counts: dict[str, int] = {}
    posts_by_chunk: dict[str, list[str]] = {}
    for p in db.query(
            "SELECT id, run_id, tick, agent_id, cited_chunk_ids_json FROM posts"
            " WHERE cited_chunk_ids_json IS NOT NULL"):
        for cid in (db.uj(p["cited_chunk_ids_json"], []) or []):
            if cid not in chunk_ids:
                continue
            counts[cid] = counts.get(cid, 0) + 1
            posts_by_chunk.setdefault(cid, []).append(p["id"])

    runs = [dict(r) for r in db.query(
        "SELECT id, name, status, created_at, last_completed_tick, config_json"
        " FROM runs WHERE source_id=? ORDER BY created_at DESC LIMIT 50", (source_id,))]

    # Per-run usage: posts that cited this source and the agents they came from.
    usage = []
    total_posts_citing = 0
    for r in runs:
        run_posts = db.query(
            "SELECT id, agent_id, cited_chunk_ids_json FROM posts WHERE run_id=?",
            (r["id"],))
        citing = 0
        agents: set[str] = set()
        for p in run_posts:
            cited = db.uj(p["cited_chunk_ids_json"], []) or []
            if any(c in chunk_ids for c in cited):
                citing += 1
                agents.add(p["agent_id"])
        total_posts_citing += citing
        usage.append({
            "run_id": r["id"], "name": r["name"], "status": r["status"],
            "created_at": r["created_at"],
            "rounds": r["last_completed_tick"] or 0,
            "posts_citing": citing,
            "agents_citing": len(agents),
        })

    # Stakeholder groups: configured in the brief, with the agents actually seeded
    # for them across the runs that used this source.
    agents_by_group: dict[str, int] = {}
    for r in runs:
        for a in db.query(
                "SELECT stakeholder_group, COUNT(*) AS n FROM agents WHERE run_id=?"
                " GROUP BY stakeholder_group", (r["id"],)):
            key = a["stakeholder_group"] or "Unassigned"
            agents_by_group[key] = agents_by_group.get(key, 0) + a["n"]
    groups = []
    for g in (brief.get("stakeholder_groups") or []):
        name = g.get("name") or ""
        groups.append({
            "name": name,
            "description": g.get("description") or "",
            "size_hint": g.get("size_hint") or "medium",
            "influence": g.get("influence"),
            "agents": agents_by_group.get(name, 0),
            "concerns": g.get("concerns") or [],
        })
    for extra, n in agents_by_group.items():
        if extra not in {g["name"] for g in groups}:
            groups.append({"name": extra, "description": "", "size_hint": "medium",
                           "influence": None, "agents": n, "concerns": []})

    # Issues: configured in the brief, with the chunks each one points at.
    issues = []
    for i in (brief.get("issues") or []):
        cited_ids = [c for c in (i.get("evidence_chunk_ids") or []) if c in chunk_ids]
        issues.append({
            "id": i.get("id"), "name": i.get("name") or i.get("id"),
            "question": i.get("question") or "",
            "category": i.get("category"),
            "evidence_chunk_ids": cited_ids,
            "evidence_chunks_found": len(cited_ids),
            "evidence_chunks_declared": len(i.get("evidence_chunk_ids") or []),
        })

    # Findings that cite this source: taken from the most recent completed run.
    from app.analytics.findings import build_findings
    findings_out = []
    source_run = next((r for r in runs if r["status"] == "completed"), None)
    if source_run is not None:
        try:
            built = build_findings(source_run["id"]).get("findings", [])
        except Exception:  # noqa: BLE001 — a findings failure must not break the page
            built = []
        for f in built:
            rows = [row for row in f.get("rows", [])
                    if (row.get("chunk_id") in chunk_ids) or ("chunk_id" not in row)]
            if f["id"] in ("most_cited", "pages"):
                rows = [row for row in rows if row.get("chunk_id") in chunk_ids]
            if rows:
                findings_out.append({
                    "run_id": source_run["id"], "run_name": source_run["name"],
                    "finding_id": f["id"], "title": f["title"],
                    "denominator": f["denominator"], "unit": f["unit"],
                    "rows": len(rows),
                })

    cited_chunks = [c for c in chunk_rows if counts.get(c["id"], 0) > 0]
    top_chunks = sorted(chunk_rows, key=lambda c: (-counts.get(c["id"], 0), c["idx"]))[:12]

    notes = []
    if not brief:
        notes.append("No scenario brief has been generated for this document yet, so "
                     "issues and stakeholder groups cannot be listed.")
    if not runs:
        notes.append("No simulation has used this document yet.")
    if chunk_rows and not cited_chunks:
        notes.append("No recorded post cites this document, so evidence coverage is zero.")

    return {
        "source": {
            "id": src["id"], "filename": src["filename"], "kind": src["kind"],
            "status": src["status"], "pages": src["pages"],
            "created_at": src["created_at"], "error": src["error"],
            "sha256": (src["sha256"] or "")[:16],
        },
        "stats": {
            "chunks": len(chunk_rows),
            "words": sum((c["n_words"] or 0) for c in chunk_rows),
            "pages": src["pages"],
        },
        "coverage": {
            "chunks_total": len(chunk_rows),
            "chunks_cited": len(cited_chunks),
            "citation_total": sum(counts.values()),
            "posts_citing": total_posts_citing,
            "runs": len(runs),
            "pct_chunks_cited": (round(100 * len(cited_chunks) / len(chunk_rows))
                                 if chunk_rows else None),
        },
        "brief": {
            "summary": brief.get("summary") or "",
            "generated_by": brief.get("generated_by") or None,
        },
        "issues": issues,
        "stakeholder_groups": groups,
        "usage": usage,
        "findings": findings_out,
        "chunks": [{
            "id": c["id"], "idx": c["idx"],
            "page_start": c["page_start"], "page_end": c["page_end"],
            "heading": c["heading"], "n_words": c["n_words"],
            "citations": counts.get(c["id"], 0),
            "excerpt": (c["text"] or "")[:400],
            "post_ids": posts_by_chunk.get(c["id"], [])[:5],
        } for c in top_chunks],
        "notes": notes,
    }


@router.get("/sources/{source_id}")
def get_source(source_id: str) -> dict:
    return _source_stats(source_id)


@router.get("/sources/{source_id}/chunks")
def list_chunks(source_id: str, limit: int = 1000, offset: int = 0) -> dict:
    """All chunks of a source in order, each with real citation counts across all posts."""
    if db.query_one("SELECT id FROM sources WHERE id=?", (source_id,)) is None:
        raise AppError("source not found", component="api", stage="chunks", status_code=404)
    rows = db.query(
        "SELECT id, idx, text, page_start, page_end, heading, n_words FROM chunks"
        " WHERE source_id=? ORDER BY idx LIMIT ? OFFSET ?",
        (source_id, max(1, min(5000, limit)), max(0, offset)))
    counts: dict[str, int] = {}
    for (cid,) in db.query("SELECT cited_chunk_ids_json FROM posts WHERE cited_chunk_ids_json IS NOT NULL"):
        try:
            for c in db.uj(cid) or []:
                counts[c] = counts.get(c, 0) + 1
        except Exception:
            continue
    chunks = []
    for r in rows:
        chunks.append({
            "id": r["id"], "idx": r["idx"], "page_start": r["page_start"],
            "page_end": r["page_end"], "heading": r["heading"],
            "n_words": r["n_words"],
            "citations": counts.get(r["id"], 0),
        })
    return {"chunks": chunks, "count": len(chunks)}


class BriefIn(BaseModel):
    scenario: str = ""
    # Optional hints: the LLM is free to find more, but the deterministic fallback
    # honours these counts instead of silently collapsing to 1 issue / 3 groups.
    max_issues: int = 5
    max_groups: int = 6


@router.post("/sources/{source_id}/brief")
async def generate_brief(source_id: str, body: BriefIn) -> dict:
    row = db.query_one("SELECT * FROM sources WHERE id=?", (source_id,))
    if row is None:
        raise AppError("source not found", component="api", stage="brief", status_code=404)
    if not body.scenario.strip():
        raise AppError("scenario text is required to build the brief",
                       component="api", stage="brief")
    from app.llm.gateway import gateway
    brief = await brief_mod.build_brief(
        source_id, body.scenario, gateway,
        max_issues=max(1, min(50, body.max_issues)),
        max_groups=max(1, min(50, body.max_groups)),
    )
    db.execute("UPDATE sources SET brief_json=? WHERE id=?", (db.j(brief), source_id))
    return {"brief": brief}


@router.put("/sources/{source_id}/brief")
def update_brief(source_id: str, body: dict) -> dict:
    row = db.query_one("SELECT * FROM sources WHERE id=?", (source_id,))
    if row is None:
        raise AppError("source not found", component="api", stage="brief", status_code=404)
    brief = brief_mod._sanitize_brief(body.get("brief") if "brief" in body else body)
    db.execute("UPDATE sources SET brief_json=? WHERE id=?", (db.j(brief), source_id))
    return {"brief": brief}


@router.get("/sources/{source_id}/chunks/{chunk_id}")
def get_chunk(source_id: str, chunk_id: str) -> dict:
    row = db.query_one(
        "SELECT * FROM chunks WHERE id=? AND source_id=?", (chunk_id, source_id))
    if row is None:
        raise AppError("chunk not found", component="api", stage="chunks", status_code=404)
    return dict(row)
