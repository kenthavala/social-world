"""Bundled sample world: import a recorded run once, without inventing any rows.

The JSON is produced by tools/make_sample_run.py from a real (or clearly labelled
mock) run and includes the source, chunks, agents, posts, stance history, report
and call metadata. Import is idempotent by run id.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from app import db
from app.ingest import index as index_mod

ROOT = Path(__file__).resolve().parent.parent.parent
SAMPLE_PATH = ROOT / "examples" / "sample-run.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read() -> Optional[dict]:
    try:
        if not SAMPLE_PATH.exists():
            return None
        return json.loads(SAMPLE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def sample_info() -> dict:
    data = _read()
    if not data or not data.get("run"):
        return {"available": False, "imported": False, "run_id": None,
                "label": None, "mock": None}
    rid = data["run"]["id"]
    exists = db.query_one("SELECT id FROM runs WHERE id=?", (rid,)) is not None
    sample = data.get("sample") or {}
    return {
        "available": True,
        "imported": exists,
        "run_id": rid,
        "label": sample.get("label") or data["run"].get("name"),
        "description": sample.get("description"),
        "source_file": sample.get("source_file"),
        "mock": bool(sample.get("mock")),
    }


def _insert_source(conn, data: dict) -> str:
    rec = data.get("source_record") or {}
    sample = data.get("sample") or {}
    sha = rec.get("sha256") or sample.get("source_sha256")
    filename = rec.get("filename") or sample.get("source_filename") or "sample.pdf"
    if sha:
        existing = conn.execute("SELECT id FROM sources WHERE sha256=?", (sha,)).fetchone()
        if existing is not None:
            source_id = existing["id"]
            conn.execute("UPDATE sources SET brief_json=COALESCE(brief_json, ?) WHERE id=?",
                         (db.j(data.get("source") or {}), source_id))
            return source_id
    source_id = rec.get("id") or "src_sample_world"
    conn.execute(
        "INSERT OR REPLACE INTO sources(id, filename, sha256, kind, pages, created_at,"
        " status, brief_json, error) VALUES(?,?,?,?,?,?,?,?,?)",
        (source_id, filename, sha, rec.get("kind") or "file", rec.get("pages") or 0,
         rec.get("created_at") or _now(), "extracted",
         db.j(data.get("source") or {}), None))
    for i, c in enumerate(data.get("chunks") or []):
        conn.execute(
            "INSERT OR REPLACE INTO chunks(id, source_id, idx, text, page_start, page_end,"
            " heading, n_words) VALUES(?,?,?,?,?,?,?,?)",
            (c["id"], source_id, c.get("idx", i), c.get("text", ""),
             c.get("page_start"), c.get("page_end"), c.get("heading"),
             c.get("n_words") or len(str(c.get("text") or "").split())))
    return source_id


def import_bundle(data: dict) -> dict:
    run_data = data.get("run") or {}
    run_id = run_data.get("id")
    if not run_id:
        raise ValueError("sample bundle has no run id")
    if db.query_one("SELECT id FROM runs WHERE id=?", (run_id,)) is not None:
        return sample_info() | {"imported": False, "already_present": True, "run_id": run_id}
    source_id = None
    with db.tx() as conn:
        source_id = _insert_source(conn, data)
        manifest = run_data.get("manifest") or data.get("manifest") or {}
        provider = run_data.get("provider_json") or run_data.get("provider_hint") or {}
        scenario = run_data.get("scenario") or {}
        config = run_data.get("config") or {}
        now = _now()
        conn.execute(
            "INSERT INTO runs(id, name, source_id, scenario_json, config_json, provider_json,"
            " seed, status, current_tick, last_completed_tick, rng_state, llm_calls_used,"
            " created_at, updated_at, error_json, started_at, finished_at, parent_run_id,"
            " branch_round, manifest_json, llm_reserved)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (run_id, run_data.get("name") or "Sample world", source_id,
             db.j(scenario), db.j(config), db.j(provider), run_data.get("seed"),
             run_data.get("status") or "completed",
             run_data.get("current_tick") or run_data.get("last_completed_tick") or 0,
             run_data.get("last_completed_tick") or run_data.get("ticks_done") or 0,
             None, run_data.get("llm_calls_used") or 0,
             run_data.get("created_at") or now, run_data.get("finished_at") or now,
             db.j(run_data.get("error")) if run_data.get("error") else None,
             run_data.get("started_at"), run_data.get("finished_at"),
             run_data.get("parent_run_id"), run_data.get("branch_round"),
             db.j(manifest), 0))
        for a in data.get("agents") or []:
            conn.execute(
                "INSERT OR REPLACE INTO agents(id, run_id, handle, name, bio, archetype,"
                " stakeholder_group, persona_json, personality_json, traits_json, goals_json,"
                " interests_json, stances_json, state_json, knowledge_json, belief_summary,"
                " source_chunk_ids_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (a["id"], run_id, a.get("handle") or a["id"], a.get("name") or a["id"],
                 a.get("bio") or "", a.get("archetype") or "ordinary user",
                 a.get("group") or a.get("stakeholder_group") or "unassigned",
                 db.j(a.get("persona") or {}), db.j(a.get("big5") or a.get("personality") or {}),
                 db.j(a.get("traits") or {}), db.j(a.get("goals") or []),
                 db.j(a.get("interests") or []), db.j(a.get("stances") or {}),
                 db.j(a.get("state") or {"mood": 0.0, "arousal": 0.2, "fatigue": 0.0}),
                 db.j(a.get("knowledge") or []), a.get("belief_summary") or "",
                 db.j(a.get("knowledge") or [])))
        seq = 0
        for p in data.get("posts") or []:
            seq += 1
            conn.execute(
                "INSERT OR REPLACE INTO posts(id, run_id, tick, agent_id, kind, parent_id, text,"
                " stance_json, emotion, cited_chunk_ids_json, likes, reposts, replies,"
                " is_fallback, seq, model, provider, via_fallback)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (p["id"], run_id, p.get("tick") or 0, p.get("agent_id") or "agent_unknown",
                 p.get("kind") or "post", p.get("parent_id"), p.get("text") or "",
                 db.j(p.get("stance") or {}), p.get("emotion") or "neutral",
                 db.j(p.get("cited_chunk_ids") or []), p.get("likes") or 0,
                 p.get("reposts") or 0, p.get("replies") or 0,
                 p.get("is_fallback") or 0, p.get("seq") or seq,
                 p.get("model"), p.get("provider"), p.get("via_fallback") or 0))
        for e in data.get("edges") or []:
            conn.execute(
                "INSERT OR REPLACE INTO edges(run_id, src, dst, follows, weight, interactions,"
                " last_tick) VALUES(?,?,?,?,?,?,?)",
                (run_id, e["src"], e["dst"], e.get("follows") or 0,
                 e.get("weight") or 0, e.get("interactions") or 0, e.get("last_tick") or 0))
        for m in data.get("metrics") or []:
            tick = m.get("tick") or 0
            conn.execute("INSERT OR REPLACE INTO metrics(run_id, tick, metrics_json)"
                         " VALUES(?,?,?)", (run_id, tick, db.j(m)))
        rows = data.get("stance_history_rows")
        if rows is None:
            rows = []
        for s in rows:
            conn.execute(
                "INSERT INTO stance_history(run_id, tick, agent_id, issue_id, value, confidence)"
                " VALUES(?,?,?,?,?,?)",
                (run_id, s.get("tick") or 0, s.get("agent_id") or "",
                 s.get("issue_id") or "", s.get("value") or 0,
                 s.get("confidence") or 0.5))
        for m in data.get("memories") or []:
            conn.execute(
                "INSERT INTO memories(run_id, agent_id, tick, kind, text, importance, refs_json)"
                " VALUES(?,?,?,?,?,?,?)",
                (run_id, m.get("agent_id") or "", m.get("tick") or 0,
                 m.get("kind") or "memory", m.get("text") or "",
                 m.get("importance") or 0.5, db.j(m.get("refs") or [])))
        for e in data.get("events") or []:
            conn.execute(
                "INSERT INTO events(run_id, tick, kind, payload_json, created_at)"
                " VALUES(?,?,?,?,?)",
                (run_id, e.get("tick") or 0, e.get("kind") or "event",
                 db.j(e.get("payload") or {}), e.get("created_at") or now))
        for c in data.get("llm_calls") or []:
            conn.execute(
                "INSERT INTO llm_calls(run_id, task, provider, model, request_hash, request_json,"
                " response_text, parsed_ok, status, http_status, error, tokens_in, tokens_out,"
                " latency_ms, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (run_id, c.get("task") or "", c.get("provider") or "", c.get("model") or "",
                 None, None, None, 1 if c.get("status") == "ok" else 0,
                 c.get("status") or "ok", None, c.get("error"),
                 c.get("tokens_in"), c.get("tokens_out"), c.get("latency_ms") or 0,
                 c.get("created_at") or now))
        counted = (data.get("report") or {}).get("counted")
        if counted and counted.get("report_md"):
            essay = (data.get("report") or {}).get("essay") or {}
            conn.execute(
                "INSERT OR REPLACE INTO reports(run_id, created_at, analytics_json, report_md,"
                " report_json, essay_json, essay_meta_json) VALUES(?,?,?,?,?,?,?)",
                (run_id, counted.get("created_at") or now,
                 db.j(counted.get("analytics") or {}), counted.get("report_md") or "",
                 db.j(counted.get("report_json") or {}),
                 db.j(essay.get("sections") or {}) if essay else None,
                 db.j(essay.get("meta") or {}) if essay else None))
    # rebuild the BM25 index so the imported source is usable for future runs
    try:
        chunks = db.query("SELECT id, text FROM chunks WHERE source_id=? ORDER BY idx", (source_id,))
        if chunks:
            idx = index_mod.SourceIndex(source_id)
            idx.build([c["id"] for c in chunks], [c["text"] for c in chunks])
            index_mod.put_index(idx)
    except Exception:
        pass
    try:
        from app.analytics.report import generate_report
        if db.query_one("SELECT run_id FROM reports WHERE run_id=?", (run_id,)) is None:
            generate_report(run_id)
    except Exception:
        pass
    return sample_info() | {"imported": True, "available": True, "run_id": run_id}


def import_sample() -> dict:
    data = _read()
    if not data:
        return {"available": False, "imported": False, "run_id": None}
    return import_bundle(data)


def ensure_sample_world() -> bool:
    """First start only: import the sample when the database has no runs.

    Disabled under pytest: tests create isolated databases and must not inherit
    production sample data.
    """
    if "pytest" in sys.modules or any("pytest" in m for m in sys.modules):
        return False
    data = _read()
    if not data:
        return False
    if (db.scalar("SELECT COUNT(*) FROM runs") or 0) > 0:
        return False
    try:
        result = import_bundle(data)
        return bool(result.get("imported"))
    except Exception:
        return False
