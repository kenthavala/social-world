"""Runs API: CRUD, seed/start/pause/resume/stop, events, feeds, agents, graph, metrics."""
from __future__ import annotations

import asyncio
import json
import random
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app import db
from app.errors import AppError
from app.sim import budget as budget_mod
from app.sim import engine
from app.api.stream import stream_response
from app.version import APP_VERSION, PROMPT_VERSION

router = APIRouter(prefix="/api")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clamp_config(cfg: dict) -> dict:
    out = {
        "agents": max(5, min(100, int(cfg.get("agents", 16) or 16))),
        "ticks": max(1, min(100, int(cfg.get("ticks", 12) or 12))),
        "writes_per_tick": max(0, min(20, int(cfg.get("writes_per_tick", 4) or 4))),
        "pop_mix": {k: max(0.0, min(1.0, float((cfg.get("pop_mix") or {}).get(k, d))))
                    for k, d in (("pro", 0.3), ("con", 0.3), ("undecided", 0.4))},
        "seed": int(cfg.get("seed", random.randint(0, 2**31 - 1))),
        "write_batch": max(1, min(5, int(cfg.get("write_batch", 3) or 3))),
        "reflect_every": max(0, min(20, int(cfg.get("reflect_every", 5) or 5))),
        "backfire": bool(cfg.get("backfire", True)),
    }
    est = budget_mod.estimate({"agents": out["agents"], "ticks": out["ticks"],
                               "writes_per_tick": out["writes_per_tick"]})
    default_budget = est["max_llm_calls"]
    out["max_llm_calls"] = max(out["writes_per_tick"], int(cfg.get("max_llm_calls") or default_budget))
    return out


class EstimateIn(BaseModel):
    config: dict = {}


@router.post("/estimate")
def estimate_runs(body: EstimateIn) -> dict:
    cfg = _clamp_config(body.config)
    est = budget_mod.estimate({"agents": cfg["agents"], "ticks": cfg["ticks"],
                               "writes_per_tick": cfg["writes_per_tick"]})
    from app.config import config as app_config
    provider = app_config.llm_provider
    from app.llm.presets import PRESETS
    preset = PRESETS.get(provider)
    rpm = app_config.llm_rpm or (preset.default_rpm if preset else 10) or 10
    return {"estimate": est, "config": cfg,
            "warnings": budget_mod.warnings({"agents": cfg["agents"], "ticks": cfg["ticks"],
                                             "writes_per_tick": cfg["writes_per_tick"]},
                                            est, provider, rpm)}


class RunIn(BaseModel):
    source_id: Optional[str] = None
    name: str = ""
    scenario_json: dict = Field(default_factory=dict)
    config: dict = Field(default_factory=dict)
    parent_run_id: Optional[str] = None
    branch_round: Optional[int] = None


def _write_manifest(run_id: str, source_id: Optional[str], cfg: dict,
                    provider_meta: dict, created_at: str,
                    parent_run_id: Optional[str] = None,
                    branch_round: Optional[int] = None) -> dict:
    sha = db.scalar("SELECT sha256 FROM sources WHERE id=?", (source_id,)) if source_id else None
    manifest = {
        "run_id": run_id,
        "provider": provider_meta.get("name"),
        "model": provider_meta.get("model"),
        "seed": cfg.get("seed"),
        "prompt_version": PROMPT_VERSION,
        "app_version": APP_VERSION,
        "source_sha256": sha,
        "created_at": created_at,
        "parent_run_id": parent_run_id,
        "branch_round": branch_round,
    }
    db.execute("UPDATE runs SET manifest_json=?, parent_run_id=?, branch_round=? WHERE id=?",
               (db.j(manifest), parent_run_id, branch_round, run_id))
    return manifest


@router.post("/runs")
def create_run(body: RunIn) -> dict:
    if body.source_id:
        src = db.query_one("SELECT id, status FROM sources WHERE id=?", (body.source_id,))
        if src is None:
            raise AppError("source not found", component="api", stage="runs", status_code=404)
        if src["status"] != "extracted":
            raise AppError(f"source is not ready for a run (status: {src['status']})",
                           component="api", stage="runs", status_code=409,
                           hint="Wait for extraction to finish; a failed document must be re-uploaded.")
    active = db.query_one("SELECT id FROM runs WHERE status IN ('running','seeding')")
    if active is not None:
        raise AppError(f"run {active['id']} is already active; only one run can run at a time",
                       component="api", stage="runs", error_type="conflict", status_code=409)
    run_id = "run_" + uuid.uuid4().hex[:10]
    cfg = _clamp_config(body.config)
    name = (body.name or f"Simulation {_now()[:16]}")[:80]
    from app.config import config as _cfg
    provider_meta = {"name": _cfg.llm_provider, "model": _cfg.llm_model}
    created = _now()
    db.execute(
        "INSERT INTO runs(id, name, source_id, scenario_json, config_json, provider_json, seed,"
        " status, current_tick, last_completed_tick, rng_state, llm_calls_used, created_at,"
        " updated_at, error_json, parent_run_id, branch_round)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (run_id, name, body.source_id or None, db.j(body.scenario_json), db.j(cfg),
         db.j(provider_meta), cfg["seed"], "draft", 0, 0, None, 0, created, created, None,
         body.parent_run_id, body.branch_round))
    _write_manifest(run_id, body.source_id, cfg, provider_meta, created,
                    body.parent_run_id, body.branch_round)
    return run_detail(run_id)


@router.get("/runs")
def list_runs() -> dict:
    rows = db.query("SELECT * FROM runs ORDER BY created_at DESC LIMIT 100")
    out = []
    for r in rows:
        src_name = db.scalar("SELECT filename FROM sources WHERE id=?", (r["source_id"],)) \
            if r["source_id"] else None
        cfg = db.uj(r["config_json"], {}) or {}
        out.append({
            "id": r["id"], "name": r["name"], "status": r["status"],
            "source": src_name, "source_id": r["source_id"],
            "ticks_done": r["last_completed_tick"] or 0,
            "ticks_total": (cfg.get("ticks") or 0),
            "created_at": r["created_at"],
            "llm_calls_used": r["llm_calls_used"] or 0,
        })
    return {"runs": out}


def run_detail(run_id: str) -> dict:
    r = db.query_one("SELECT * FROM runs WHERE id=?", (run_id,))
    if r is None:
        raise AppError("run not found", component="api", stage="runs", status_code=404)
    cfg = db.uj(r["config_json"], {}) or {}
    n_agents = db.scalar("SELECT COUNT(*) FROM agents WHERE run_id=?", (run_id,)) or 0
    n_posts = db.scalar("SELECT COUNT(*) FROM posts WHERE run_id=?", (run_id,)) or 0
    return {
        "id": r["id"], "name": r["name"], "status": r["status"],
        "source_id": r["source_id"], "scenario": db.uj(r["scenario_json"], {}),
        "config": cfg, "seed": r["seed"],
        "current_tick": r["current_tick"], "last_completed_tick": r["last_completed_tick"],
        "llm_calls_used": r["llm_calls_used"] or 0,
        "max_llm_calls": cfg.get("max_llm_calls"),
        "error": db.uj(r["error_json"]),
        "agents": n_agents, "posts": n_posts,
        "created_at": r["created_at"], "updated_at": r["updated_at"],
        "started_at": r["started_at"], "finished_at": r["finished_at"],
        # provider/model captured at creation (additive; used by the run header)
        "provider": db.uj(r["provider_json"], {}) or {},
        "manifest": db.uj(r["manifest_json"], {}) or None,
        "parent_run_id": r["parent_run_id"],
        "branch_round": r["branch_round"],
        "llm_reserved": r["llm_reserved"] or 0,
    }


@router.get("/runs/{run_id}")
def get_run(run_id: str) -> dict:
    return run_detail(run_id)


@router.delete("/runs/{run_id}")
def delete_run(run_id: str) -> dict:
    status = db.scalar("SELECT status FROM runs WHERE id=?", (run_id,))
    if status in ("running", "seeding", "paused"):
        raise AppError("stop the run before deleting it", component="api", stage="runs",
                       status_code=409,
                       hint="A running, seeding or paused run owns live state; stop it first.")
    if run_id in engine._tasks and not engine._tasks[run_id].done():
        raise AppError("stop the run before deleting it", component="api", stage="runs",
                       status_code=409)
    with db.tx() as conn:
        for table, col in (("posts", "run_id"), ("reactions", "run_id"),
                           ("edges", "run_id"), ("edge_history", "run_id"),
                           ("memories", "run_id"), ("stance_history", "run_id"),
                           ("events", "run_id"), ("metrics", "run_id"),
                           ("llm_calls", "run_id"), ("agents", "run_id"),
                           ("reports", "run_id"), ("runs", "id")):
            conn.execute(f"DELETE FROM {table} WHERE {col}=?", (run_id,))
    return {"deleted": run_id}


@router.post("/runs/{run_id}/seed")
async def seed_run(run_id: str) -> dict:
    r = db.query_one("SELECT * FROM runs WHERE id=?", (run_id,))
    if r is None:
        raise AppError("run not found", component="api", stage="seed", status_code=404)
    if r["status"] not in ("draft", "ready"):
        raise AppError(f"cannot seed a run in state '{r['status']}'",
                       component="api", stage="seed", status_code=409)
    from app.llm.gateway import gateway
    n = await engine.seed_run(run_id, gateway)
    return {"agents": n, "status": db.scalar("SELECT status FROM runs WHERE id=?", (run_id,))}


@router.post("/runs/{run_id}/start")
async def start_run(run_id: str) -> dict:
    """Start in the background so a client disconnect cannot strand seeding."""
    r = run_detail(run_id)
    if r["status"] in ("completed", "failed", "running", "seeding"):
        raise AppError(f"cannot start a run in state '{r['status']}'",
                       component="api", stage="runs", status_code=409)
    if r["status"] == "paused" or r["status"] == "interrupted":
        raise AppError("this run is resumable — use Resume", component="api",
                       stage="runs", status_code=409)
    from app.llm.gateway import gateway
    task = asyncio.create_task(engine.seed_and_start(run_id, gateway))
    engine._tasks[run_id] = task
    return run_detail(run_id)


@router.post("/runs/{run_id}/pause")
def pause_run(run_id: str) -> dict:
    engine.request_pause(run_id)
    return run_detail(run_id)


@router.post("/runs/{run_id}/resume")
async def resume_run(run_id: str) -> dict:
    status = db.scalar("SELECT status FROM runs WHERE id=?", (run_id,))
    if status not in ("paused", "interrupted"):
        raise AppError(f"cannot resume a run in state '{status}'",
                       component="api", stage="runs", status_code=409)
    from app.llm.gateway import gateway
    task = asyncio.create_task(engine.seed_and_start(run_id, gateway, resume=True))
    engine._tasks[run_id] = task
    return run_detail(run_id)


class BudgetIn(BaseModel):
    max_llm_calls: int = Field(gt=0, le=100000)


@router.post("/runs/{run_id}/budget")
def raise_budget(run_id: str, body: BudgetIn) -> dict:
    """Raise a paused run's call budget, then Resume. Additive; the estimate is unchanged."""
    row = db.query_one("SELECT config_json, status FROM runs WHERE id=?", (run_id,))
    if row is None:
        raise AppError("run not found", component="api", stage="runs", status_code=404)
    cfg = db.uj(row["config_json"], {}) or {}
    cfg["max_llm_calls"] = int(body.max_llm_calls)
    db.execute("UPDATE runs SET config_json=?, updated_at=? WHERE id=?",
               (db.j(cfg), _now(), run_id))
    return run_detail(run_id)


@router.post("/runs/{run_id}/stop")
def stop_run(run_id: str) -> dict:
    engine.request_stop(run_id)
    return run_detail(run_id)


class InjectIn(BaseModel):
    text: str = ""
    tick: Optional[int] = None
    chunk_id: Optional[str] = None
    audience: Optional[str] = None


@router.post("/runs/{run_id}/events")
def inject_event(run_id: str, body: InjectIn) -> dict:
    ev = engine.inject_event(run_id, body.text, body.chunk_id, body.tick,
                             body.audience or "all")
    return {"injected": ev}


# --- read endpoints -----------------------------------------------------------

@router.get("/runs/{run_id}/agents")
def list_agents(run_id: str) -> dict:
    rows = db.query("SELECT * FROM agents WHERE run_id=? ORDER BY id", (run_id,))
    out = []
    for r in rows:
        stances = db.uj(r["stances_json"], {}) or {}
        traits = db.uj(r["traits_json"], {}) or {}
        state = db.uj(r["state_json"], {}) or {}
        out.append({
            "id": r["id"], "handle": r["handle"], "name": r["name"], "bio": r["bio"],
            "archetype": r["archetype"], "group": r["stakeholder_group"],
            "stances": stances, "traits": traits, "state": state,
            "belief_summary": r["belief_summary"], "knowledge": db.uj(r["knowledge_json"], []),
        })
    return {"agents": out}


@router.get("/runs/{run_id}/agents/{agent_id}")
def agent_detail(run_id: str, agent_id: str) -> dict:
    r = db.query_one("SELECT * FROM agents WHERE id=? AND run_id=?", (agent_id, run_id))
    if r is None:
        raise AppError("agent not found", component="api", stage="agents", status_code=404)
    memories = db.query(
        "SELECT * FROM memories WHERE run_id=? AND agent_id=? ORDER BY tick DESC, id DESC LIMIT 50",
        (run_id, agent_id))
    posts = db.query("SELECT * FROM posts WHERE run_id=? AND agent_id=? ORDER BY tick DESC LIMIT 50",
                     (run_id, agent_id))
    stances = db.uj(r["stances_json"], {}) or {}
    stance_hist = db.query(
        "SELECT tick, issue_id, value FROM stance_history WHERE run_id=? AND agent_id=?"
        " ORDER BY tick", (run_id, agent_id))
    series: dict[str, list] = {}
    for h in stance_hist:
        series.setdefault(h["issue_id"], []).append({"tick": h["tick"], "value": h["value"]})
    edges_out = db.query(
        "SELECT * FROM edges WHERE run_id=? AND (src=? OR dst=?)", (run_id, agent_id, agent_id))
    return {
        "agent": {
            "id": r["id"], "handle": r["handle"], "name": r["name"], "bio": r["bio"],
            "archetype": r["archetype"], "group": r["stakeholder_group"],
            "persona": db.uj(r["persona_json"], {}), "big5": db.uj(r["personality_json"], {}),
            "traits": db.uj(r["traits_json"], {}), "goals": db.uj(r["goals_json"], []),
            "interests": db.uj(r["interests_json"], []), "stances": stances,
            "state": db.uj(r["state_json"], {}), "knowledge": db.uj(r["knowledge_json"], []),
            "belief_summary": r["belief_summary"],
        },
        "memories": [{"tick": m["tick"], "kind": m["kind"], "text": m["text"],
                      "importance": m["importance"]} for m in memories],
        "posts": [dict(p) | {"stance": db.uj(p["stance_json"], {})}
                  for p in posts],
        "stance_history": series,
        "edges": [{"src": e["src"], "dst": e["dst"], "follows": e["follows"],
                   "weight": e["weight"]} for e in edges_out],
    }


@router.get("/runs/{run_id}/posts")
def list_posts(run_id: str, agent: Optional[str] = None, kind: Optional[str] = None,
               tick_from: Optional[int] = None, tick_to: Optional[int] = None,
               q: Optional[str] = None, limit: int = 200, offset: int = 0) -> dict:
    sql = ("SELECT p.*, a.handle, a.name FROM posts p LEFT JOIN agents a ON a.id = p.agent_id"
           " AND a.run_id = p.run_id WHERE p.run_id=?")
    params: list[Any] = [run_id]
    if agent:
        sql += " AND p.agent_id=?"
        params.append(agent)
    if kind:
        sql += " AND p.kind=?"
        params.append(kind)
    if tick_from is not None:
        sql += " AND p.tick>=?"
        params.append(tick_from)
    if tick_to is not None:
        sql += " AND p.tick<=?"
        params.append(tick_to)
    if q:
        sql += " AND p.text LIKE ?"
        params.append(f"%{q}%")
    sql += " ORDER BY p.seq, p.tick LIMIT ? OFFSET ?"
    params += [max(1, min(1000, limit)), max(0, offset)]
    rows = db.query(sql, params)
    posts = []
    for p in rows:
        posts.append({"id": p["id"], "tick": p["tick"], "agent_id": p["agent_id"],
                      "handle": p["handle"], "name": p["name"], "kind": p["kind"],
                      "parent_id": p["parent_id"], "text": p["text"],
                      "stance": db.uj(p["stance_json"], {}), "emotion": p["emotion"],
                      "cited_chunk_ids": db.uj(p["cited_chunk_ids_json"], []),
                      "likes": p["likes"], "reposts": p["reposts"], "replies": p["replies"],
                      "is_fallback": p["is_fallback"], "seq": p["seq"],
                      "model": p["model"], "provider": p["provider"],
                      "via_fallback": p["via_fallback"]})
    return {"posts": posts, "count": len(posts)}


@router.get("/runs/{run_id}/stats")
def get_run_stats(run_id: str) -> dict:
    """Counted call outcomes for the Run details drawer. No generated prose."""
    if db.query_one("SELECT id FROM runs WHERE id=?", (run_id,)) is None:
        raise AppError("run not found", component="api", stage="stats", status_code=404)
    by_status: dict[str, int] = {}
    by_task: dict[str, int] = {}
    models: dict[str, int] = {}
    latency = 0
    calls = 0
    for r in db.query("SELECT task, status, model, latency_ms FROM llm_calls WHERE run_id=?",
                      (run_id,)):
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
        by_task[r["task"]] = by_task.get(r["task"], 0) + 1
        if r["model"]:
            models[r["model"]] = models.get(r["model"], 0) + 1
        if r["latency_ms"]:
            latency += r["latency_ms"]
            calls += 1
    return {
        "run_id": run_id,
        "calls": sum(by_status.values()),
        "by_status": by_status,
        "by_task": by_task,
        "models": models,
        "avg_latency_ms": int(latency / calls) if calls else None,
        "repaired": by_status.get("parse_failed", 0),
        "rejected": by_status.get("error", 0),
        "fallback_posts": db.scalar(
            "SELECT COUNT(*) FROM posts WHERE run_id=? AND via_fallback=1", (run_id,)) or 0,
        "template_posts": db.scalar(
            "SELECT COUNT(*) FROM posts WHERE run_id=? AND is_fallback=1", (run_id,)) or 0,
    }


class BranchIn(BaseModel):
    text: str = ""
    audience: str = "all"
    name: str = ""
    tick: int = 1


@router.post("/runs/{run_id}/branch")
def branch_run(run_id: str, body: BranchIn) -> dict:
    """Truthful intervention comparison: a NEW run from round 1 with the same
    source, scenario, config and seed, plus the intervention. The engine does not
    fork state at an arbitrary round, so this is labelled as a re-run, not a fork."""
    orig = db.query_one("SELECT * FROM runs WHERE id=?", (run_id,))
    if orig is None:
        raise AppError("run not found", component="api", stage="branch", status_code=404)
    if not body.text.strip():
        raise AppError("intervention text is required", component="api", stage="branch")
    cfg = db.uj(orig["config_json"], {}) or {}
    new = create_run(RunIn(
        source_id=orig["source_id"],
        name=(body.name or f"{orig['name']} — intervention")[:80],
        scenario_json=db.uj(orig["scenario_json"], {}) or {},
        config=cfg,
        parent_run_id=run_id,
        branch_round=1,
    ))
    engine.inject_event(new["id"], body.text.strip()[:500], tick=1,
                        audience=body.audience or "all")
    return new | {"mode": "rerun_from_round_1", "parent_run_id": run_id,
                  "label": "Re-run with this intervention from round 1"}


def _stance_bucket(stances: dict) -> str:
    vals = [float(v.get("value", 0.0)) for v in stances.values()
            if isinstance(v, dict)] if stances else []
    mean = sum(vals) / max(1, len(vals))
    return "pro" if mean > 0.15 else "con" if mean < -0.15 else "neu"


@router.get("/runs/{run_id}/compare")
def compare_runs(run_id: str, other: str) -> dict:
    """Counted comparison of two runs: per-round stance mix and citations by chunk."""
    if db.query_one("SELECT id FROM runs WHERE id=?", (run_id,)) is None or \
            db.query_one("SELECT id FROM runs WHERE id=?", (other,)) is None:
        raise AppError("run not found", component="api", stage="compare", status_code=404)
    out = {}
    for key, rid in (("left", run_id), ("right", other)):
        rounds: dict[int, dict] = {}
        cites: dict[str, int] = {}
        for p in db.query("SELECT tick, stance_json, cited_chunk_ids_json FROM posts"
                          " WHERE run_id=? ORDER BY seq", (rid,)):
            b = _stance_bucket(db.uj(p["stance_json"], {}) or {})
            r = rounds.setdefault(p["tick"], {"tick": p["tick"], "pro": 0, "neu": 0, "con": 0,
                                              "total": 0})
            r[b] += 1
            r["total"] += 1
            for cid in db.uj(p["cited_chunk_ids_json"], []) or []:
                cites[cid] = cites.get(cid, 0) + 1
        chunk_info = []
        for cid, n in sorted(cites.items(), key=lambda kv: (-kv[1], kv[0]))[:12]:
            row = db.query_one("SELECT heading, page_start, page_end FROM chunks WHERE id=?", (cid,))
            chunk_info.append({"chunk_id": cid, "citations": n,
                               "heading": row["heading"] if row else None,
                               "page_start": row["page_start"] if row else None,
                               "page_end": row["page_end"] if row else None})
        out[key] = {
            "run": run_detail(rid),
            "rounds": [rounds[k] for k in sorted(rounds)],
            "citations": chunk_info,
            "posts": db.scalar("SELECT COUNT(*) FROM posts WHERE run_id=?", (rid,)) or 0,
            "fallback_posts": db.scalar(
                "SELECT COUNT(*) FROM posts WHERE run_id=? AND is_fallback=1", (rid,)) or 0,
            "llm_calls": db.scalar("SELECT COUNT(*) FROM llm_calls WHERE run_id=?", (rid,)) or 0,
        }
    left, right = out["left"], out["right"]
    out["diffs"] = {
        "posts": right["posts"] - left["posts"],
        "fallback_posts": right["fallback_posts"] - left["fallback_posts"],
        "citation_total": sum(c["citations"] for c in right["citations"]) -
                          sum(c["citations"] for c in left["citations"]),
        "rounds": max(0, len(right["rounds"]) - len(left["rounds"])),
    }
    return out | {"label": "Re-run with intervention vs original (counted differences)"}


@router.get("/runs/{run_id}/graph")
def get_graph(run_id: str, tick: Optional[int] = None) -> dict:
    from app.analytics import network
    summary = network.summary(run_id, tick)
    g = network.graph_for_run(run_id, tick)
    nodes = []
    for n_id, data in g.nodes(data=True):
        stances = data.get("stances") or {}
        mean = 0.0
        if stances:
            vals = [float(v.get("value", 0.0)) for v in stances.values() if isinstance(v, dict)]
            mean = sum(vals) / max(1, len(vals))
        nodes.append({"id": n_id, "handle": data.get("handle"), "name": data.get("name"),
                      "archetype": data.get("archetype"), "mean_stance": round(mean, 3)})
    edges = [{"src": s, "dst": t, "weight": float(g.edges[s, t].get("weight", 0)),
              "follows": bool(g.edges[s, t].get("follows"))} for s, t in g.edges]
    return summary | {"nodes": nodes, "edges": edges}


@router.get("/runs/{run_id}/metrics")
def get_metrics(run_id: str) -> dict:
    rows = db.query("SELECT tick, metrics_json FROM metrics WHERE run_id=? ORDER BY tick",
                    (run_id,))
    series = []
    stance = db.query(
        "SELECT tick, issue_id, AVG(value) v FROM stance_history WHERE run_id=? GROUP BY tick, issue_id"
        " ORDER BY tick", (run_id,))
    by_issue: dict[str, list] = {}
    for s in stance:
        by_issue.setdefault(s["issue_id"], []).append({"tick": s["tick"], "value": round(s["v"], 4)})
    for r in rows:
        series.append(db.uj(r["metrics_json"], {}))
    return {"metrics": series, "stance_by_issue": by_issue}


@router.get("/runs/{run_id}/llm-calls")
def get_llm_calls(run_id: str, limit: int = 100) -> dict:
    rows = db.query(
        "SELECT id, task, provider, model, status, http_status, error, tokens_in, tokens_out,"
        " latency_ms, created_at FROM llm_calls WHERE run_id=? ORDER BY id DESC LIMIT ?",
        (run_id, max(1, min(500, limit))))
    return {"calls": [dict(r) for r in rows]}


@router.get("/runs/{run_id}/errors")
def get_errors(run_id: str, limit: int = 100) -> dict:
    rows = db.query(
        "SELECT tick, kind, payload_json, created_at FROM events WHERE run_id=?"
        " AND kind IN ('error', 'warning') ORDER BY id DESC LIMIT ?", (run_id, max(1, min(500, limit))))
    return {"errors": [{"tick": r["tick"], "kind": r["kind"],
                        "payload": db.uj(r["payload_json"], {}), "created_at": r["created_at"]}
                       for r in rows]}


@router.get("/runs/{run_id}/events")
def get_events(run_id: str, limit: int = 200) -> dict:
    rows = db.query("SELECT tick, kind, payload_json, created_at FROM events WHERE run_id=?"
                    " ORDER BY id DESC LIMIT ?", (run_id, max(1, min(1000, limit))))
    return {"events": [{"tick": r["tick"], "kind": r["kind"],
                        "payload": db.uj(r["payload_json"], {}), "created_at": r["created_at"]}
                       for r in rows]}


@router.get("/runs/{run_id}/stream")
def get_stream(run_id: str, request: Request):
    last = request.headers.get("last-event-id") or request.query_params.get("last_event_id")
    return stream_response(run_id, last)


@router.get("/runs/{run_id}/backfill")
def backfill_run(run_id: str, after_event: int = 0, after_post: int = 0,
                 limit: int = 500) -> dict:
    """REST catch-up after an SSE gap. Returns store events and posts by sequence."""
    if db.query_one("SELECT id FROM runs WHERE id=?", (run_id,)) is None:
        raise AppError("run not found", component="api", stage="backfill", status_code=404)
    cap = max(1, min(2000, limit))
    events = db.query(
        "SELECT id, kind, payload_json, created_at FROM stream_events"
        " WHERE run_id=? AND id>? ORDER BY id LIMIT ?", (run_id, max(0, after_event), cap))
    posts = db.query(
        "SELECT p.*, a.handle, a.name FROM posts p LEFT JOIN agents a ON a.id=p.agent_id"
        " AND a.run_id=p.run_id WHERE p.run_id=? AND p.seq>? ORDER BY p.seq LIMIT ?",
        (run_id, max(0, after_post), cap))
    return {
        "run": run_detail(run_id),
        "events": [{"id": r["id"], "kind": r["kind"],
                    "payload": db.uj(r["payload_json"], {}),
                    "created_at": r["created_at"]} for r in events],
        "posts": [{
            "id": p["id"], "tick": p["tick"], "agent_id": p["agent_id"],
            "handle": p["handle"], "name": p["name"], "kind": p["kind"],
            "parent_id": p["parent_id"], "text": p["text"],
            "stance": db.uj(p["stance_json"], {}), "emotion": p["emotion"],
            "cited_chunk_ids": db.uj(p["cited_chunk_ids_json"], []),
            "likes": p["likes"], "reposts": p["reposts"], "replies": p["replies"],
            "is_fallback": p["is_fallback"], "seq": p["seq"], "model": p["model"],
            "provider": p["provider"], "via_fallback": p["via_fallback"],
        } for p in posts],
        "last_event_id": db.scalar(
            "SELECT COALESCE(MAX(id),0) FROM stream_events WHERE run_id=?", (run_id,)) or 0,
        "last_post_seq": db.scalar(
            "SELECT COALESCE(MAX(seq),0) FROM posts WHERE run_id=?", (run_id,)) or 0,
    }


@router.post("/runs/{run_id}/report")
def generate_report_route(run_id: str) -> dict:
    from app.analytics.report import generate_report
    try:
        return generate_report(run_id)
    except ValueError:
        raise AppError("run not found", component="api", stage="report", status_code=404)


@router.get("/runs/{run_id}/report")
def get_report(run_id: str) -> dict:
    row = db.query_one(
        "SELECT report_md, analytics_json, created_at, essay_json, essay_meta_json"
        " FROM reports WHERE run_id=?", (run_id,))
    if row is None:
        return {"report_md": None, "available": False, "essay": None}
    essay = None
    if row["essay_json"]:
        sections = db.uj(row["essay_json"], {})
        meta = db.uj(row["essay_meta_json"], {})
        if sections:
            essay = {"sections": sections, "meta": meta}
    return {"report_md": row["report_md"], "analytics": db.uj(row["analytics_json"], {}),
            "created_at": row["created_at"], "available": True, "essay": essay}


@router.post("/runs/{run_id}/report/essay")
async def generate_report_essay(run_id: str) -> dict:
    """Write the LLM executive summary for the CURRENT counted report snapshot.
    One real LLM call (or a free cache hit on an identical snapshot); recorded
    in llm_calls; not counted against the run's simulation budget."""
    from app.errors import BudgetExhausted
    from app.analytics.report import generate_essay_report
    try:
        return await generate_essay_report(run_id)
    except ValueError as e:
        raise AppError(str(e), component="api", stage="essay", status_code=404,
                       hint="Generate the report first; the essay summarizes a stored counted snapshot.")
    except BudgetExhausted as e:
        raise AppError(str(e), component="api", stage="essay", status_code=429)
