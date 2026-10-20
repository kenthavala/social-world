"""Exports: json bundle + markdown summary. Never contains keys or base URLs."""
from __future__ import annotations

import io
import json
import zipfile
from datetime import datetime, timezone

from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response

from app import db
from app.errors import AppError

router = APIRouter(prefix="/api")


def _bundle(run_id: str) -> dict:
    r = db.query_one("SELECT * FROM runs WHERE id=?", (run_id,))
    if r is None:
        raise AppError("run not found", component="api", stage="export", status_code=404)
    cfg = db.uj(r["config_json"], {}) or {}
    provider_meta = db.uj(r["provider_json"], {}) or {}
    src_id = r["source_id"]
    # the stored LLM essay, carried WITH its generated-not-counted label
    essay = None
    rep = db.query_one("SELECT essay_json, essay_meta_json FROM reports WHERE run_id=?", (run_id,))
    if rep is not None and rep["essay_json"]:
        sections = db.uj(rep["essay_json"], {})
        if sections:
            essay = {"honesty": "LLM draft; generated prose; not counted data",
                     "sections": sections, "meta": db.uj(rep["essay_meta_json"], {})}
    return {
        "run": {"id": r["id"], "name": r["name"], "status": r["status"], "seed": r["seed"],
                "scenario": db.uj(r["scenario_json"], {}), "config": cfg,
                "created_at": r["created_at"],
                "started_at": r["started_at"], "finished_at": r["finished_at"],
                "ticks_done": r["last_completed_tick"], "llm_calls_used": r["llm_calls_used"],
                "error": db.uj(r["error_json"]),
                "provider_hint": {"provider": provider_meta.get("name"),
                                  "model": provider_meta.get("model")}},
        "source": db.uj(db.scalar("SELECT brief_json FROM sources WHERE id=?",
                                  (src_id,)) or "{}", {}) if src_id else None,
        "chunks": [_chunk(c) for c in db.query(
            "SELECT id, heading, page_start, page_end, text FROM chunks"
            " WHERE source_id=? ORDER BY idx", (src_id,))] if src_id else [],
        "agents": [_agent(a) for a in db.query("SELECT * FROM agents WHERE run_id=?", (run_id,))],
        "posts": [_post(p) for p in db.query(
            "SELECT * FROM posts WHERE run_id=? ORDER BY tick, id", (run_id,))],
        "edges": [dict(e) for e in db.query("SELECT * FROM edges WHERE run_id=?", (run_id,))],
        "metrics": [db.uj(m["metrics_json"], {}) for m in
                    db.query("SELECT * FROM metrics WHERE run_id=? ORDER BY tick", (run_id,))],
        "stance_history": [dict(s) for s in db.query(
            "SELECT tick, issue_id, ROUND(AVG(value), 4) AS mean FROM stance_history"
            " WHERE run_id=? GROUP BY tick, issue_id ORDER BY tick, issue_id", (run_id,))],
        "events": [{"tick": e["tick"], "kind": e["kind"], "payload": db.uj(e["payload_json"], {})}
                   for e in db.query("SELECT * FROM events WHERE run_id=? ORDER BY id", (run_id,))],
        "llm_calls": [{"id": c["id"], "task": c["task"], "provider": c["provider"],
                       "model": c["model"], "status": c["status"],
                       "parsed_ok": c["parsed_ok"], "error": c["error"],
                       "tokens_in": c["tokens_in"], "tokens_out": c["tokens_out"],
                       "latency_ms": c["latency_ms"], "created_at": c["created_at"]}
                      for c in db.query("SELECT * FROM llm_calls WHERE run_id=? ORDER BY id",
                                        (run_id,))],
        "llm_stats": {"calls": db.scalar("SELECT COUNT(*) FROM llm_calls WHERE run_id=?",
                                         (run_id,)) or 0},
        "report": {"origin": "See Insights + report_md; counted-only summary",
                   "essay": essay},
        "exported_at": datetime.now(timezone.utc).isoformat(),
    }


def _agent(a) -> dict:
    return {"id": a["id"], "handle": a["handle"], "name": a["name"], "bio": a["bio"],
            "archetype": a["archetype"], "group": a["stakeholder_group"],
            "stances": db.uj(a["stances_json"], {}), "traits": db.uj(a["traits_json"], {}),
            "belief_summary": a["belief_summary"]}


def _post(p) -> dict:
    return {"id": p["id"], "tick": p["tick"], "agent_id": p["agent_id"], "kind": p["kind"],
            "parent_id": p["parent_id"], "text": p["text"],
            "stance": db.uj(p["stance_json"], {}), "emotion": p["emotion"],
            "cited_chunk_ids": db.uj(p["cited_chunk_ids_json"], []),
            "likes": p["likes"], "reposts": p["reposts"], "replies": p["replies"],
            "is_fallback": p["is_fallback"]}


def _chunk(c) -> dict:
    return {"id": c["id"], "heading": c["heading"], "page_start": c["page_start"],
            "page_end": c["page_end"], "text": c["text"]}


@router.get("/runs/{run_id}/export")
def export_run(run_id: str, format: str = "json") -> Response:
    data = _bundle(run_id)
    fmt = (format or "json").lower()
    if fmt == "json":
        return JSONResponse(data, media_type="application/json",
                            headers={"Content-Disposition":
                                     f'attachment; filename="{run_id}.json"'})
    if fmt == "md":
        md = _bundle_md(data)
        return Response(md, media_type="text/markdown",
                        headers={"Content-Disposition":
                                 f'attachment; filename="{run_id}.md"'})
    if fmt == "csv":
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("agents.csv", _csv(data["agents"],
                       ["id", "handle", "name", "archetype", "group"]))
            z.writestr("posts.csv", _csv(data["posts"],
                       ["id", "tick", "agent_id", "kind", "parent_id", "text", "likes",
                        "reposts", "replies", "is_fallback"]))
            z.writestr("edges.csv", _csv(data["edges"], ["src", "dst", "follows", "weight"]))
            z.writestr("stance_history.csv", _csv(data["stance_history"],
                       ["tick", "issue_id", "mean"]))
            z.writestr("llm_calls.csv", _csv(data["llm_calls"],
                       ["id", "task", "provider", "model", "status", "parsed_ok",
                        "tokens_in", "tokens_out", "latency_ms", "created_at"]))
            z.writestr("chunks.csv", _csv(data["chunks"],
                       ["id", "heading", "page_start", "page_end"]))
            z.writestr("metrics.json", json.dumps(data["metrics"], indent=2))
            z.writestr("run.json", json.dumps(data["run"], indent=2))
        return Response(buf.getvalue(), media_type="application/zip",
                        headers={"Content-Disposition":
                                 f'attachment; filename="{run_id}_csv.zip"'})
    raise AppError("format must be json, md or csv", component="api", stage="export")


def _csv(rows: list[dict], cols: list[str]) -> str:
    import csv as _csv
    out = io.StringIO()
    w = _csv.DictWriter(out, fieldnames=cols, extrasaction="ignore")
    w.writeheader()
    for r in rows:
        flat = {}
        for c in cols:
            v = r.get(c)
            if isinstance(v, (dict, list)):
                v = json.dumps(v, ensure_ascii=False)
            flat[c] = v
        w.writerow(flat)
    return out.getvalue()


def _bundle_md(data: dict) -> str:
    run = data["run"]
    cfg = run["config"]
    calls = data.get("llm_calls") or []
    by_status: dict[str, int] = {}
    for c in calls:
        by_status[c.get("status") or "?"] = by_status.get(c.get("status") or "?", 0) + 1
    call_line = " · ".join(f"{k} {v}" for k, v in sorted(by_status.items())) or "0 calls"
    lines = [
        f"# OASIS-Lite run: {run['name']}",
        "",
        f"- status: {run['status']} · ticks done: {run.get('ticks_done')} ·"
        f" llm calls: {run.get('llm_calls_used')}",
        f"- window: {run.get('started_at') or '—'} → {run.get('finished_at') or '—'} (UTC)",
        f"- seeds/config: agents {cfg.get('agents')} | ticks {cfg.get('ticks')} "
        f"| writes/tick: {cfg.get('writes_per_tick')} | seed: {run['seed']}",
        f"- provider: {run.get('provider_hint', {}).get('provider') or 'n/a'}"
        f" / {run.get('provider_hint', {}).get('model') or 'n/a'}",
        f"- exported: {data['exported_at']}",
        "",
        "## Scenario",
        "",
        "```",
        str(run.get("scenario", {}).get("question") or "")[:800],
        "```",
        "",
        "## LLM calls by outcome",
        "",
        call_line,
        "",
        "## Metrics",
        "",
        "| tick | posts | mean stances |",
        "| --- | --- | --- |",
    ]
    for m in data["metrics"]:
        means = ", ".join(f"{iid}={vals['mean']:.2f}" for iid, vals in
                          (m.get("by_issue") or {}).items())
        lines.append(f"| {m.get('tick')} | {m.get('posts')} | {means} |")
    lines += ["", "## Posts", ""]
    for p in data["posts"][:500]:
        author = next((a["handle"] for a in data["agents"] if a["id"] == p["agent_id"]),
                      p["agent_id"])
        lines.append(f"**tick {p['tick']} — @{author} [{p['kind']}]:** {p['text']}")
        if p.get("cited_chunk_ids"):
            lines.append(f"  (source: {', '.join('%s' % c for c in p['cited_chunk_ids'])})")
    essay = (data.get("report") or {}).get("essay")
    if essay:
        from app.analytics.report import essay_markdown
        lines += ["", essay_markdown(essay["meta"], essay["sections"]), ""]
    return "\n".join(lines)
