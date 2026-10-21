"""The tick engine: run lifecycle worker, seeding, tick loop with atomic commits."""
from __future__ import annotations

import asyncio
import json
import secrets
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from app import db
from app.analytics import metrics as metrics_mod
from app.config import config
from app.errors import AppError, BudgetExhausted
from app.ingest import index as index_mod
from app.llm import adapters
from app.sim import budget as budget_mod
from app.sim import events as events_mod
from app.sim import feed as feed_mod
from app.sim import memory, opinion, policy, relations
from app.sim import seeding
from app.sim.models import PersonaOut, ReflectItem, WriteItem

_tasks: dict[str, asyncio.Task] = {}
_injected: dict[str, list[dict]] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pid() -> str:
    return "p_" + secrets.token_hex(6)


def content_pid(agent_id: str, tick: int, seq: int, text: str) -> str:
    """Deterministic post id derived from content (keeps runs reproducible)."""
    import hashlib
    return "p_" + hashlib.sha1(f"{agent_id}|{tick}|{seq}|{text}".encode()).hexdigest()[:10]


def emit(run_id: str, kind: str, payload: dict) -> None:
    from app.api.stream import emit as sse_emit
    sse_emit(run_id, kind, payload)


# ---------------------------------------------------------------------------
# Run lifecycle
# ---------------------------------------------------------------------------

async def start_run(run_id: str) -> None:
    row = db.query_one("SELECT status FROM runs WHERE id=?", (run_id,))
    if row is None:
        raise AppError("run not found", component="engine", stage="start", status_code=404)
    if row["status"] == "running":
        raise AppError("a run is already active; only one run can run at a time",
                       component="engine", stage="start", error_type="conflict", status_code=409)
    if row["status"] in ("completed", "failed"):
        raise AppError(f"cannot start a run in state '{row['status']}'",
                       component="engine", stage="start", status_code=409,
                       hint="Create a new run to simulate again.")
    old = _tasks.pop(run_id, None)
    try:
        current = asyncio.current_task()
    except RuntimeError:
        current = None
    if old and old is not current and not old.done():
        old.cancel()
    n = _now()
    db.execute("UPDATE runs SET status='running', error_json=NULL, updated_at=?,"
               " started_at=COALESCE(started_at, ?) WHERE id=?", (n, n, run_id))
    emit(run_id, "run_status", {"status": "running"})
    _rehydrate_scheduled(run_id)
    _tasks[run_id] = asyncio.create_task(_run_worker(run_id))


def request_pause(run_id: str) -> None:
    db.execute("UPDATE runs SET status='paused', updated_at=? WHERE id=?", (_now(), run_id))
    emit(run_id, "run_status", {"status": "paused"})


async def request_resume(run_id: str) -> None:
    row = db.query_one("SELECT status FROM runs WHERE id=?", (run_id,))
    if row is None:
        raise AppError("run not found", component="engine", stage="resume", status_code=404)
    if row["status"] not in ("paused", "interrupted"):
        raise AppError(f"cannot resume a run in state '{row['status']}'",
                       component="engine", stage="resume", status_code=409)
    await start_run(run_id)


def request_stop(run_id: str) -> None:
    db.execute("UPDATE runs SET status='interrupted', updated_at=?, finished_at=? WHERE id=?",
               (_now(), _now(), run_id))
    emit(run_id, "run_status", {"status": "interrupted"})


def recover_on_startup() -> None:
    rows = db.query("SELECT id FROM runs WHERE status IN ('running', 'seeding')")
    for r in rows:
        db.execute("UPDATE runs SET status='interrupted', updated_at=?, finished_at=? WHERE id=?",
                   (_now(), _now(), r["id"]))


def inject_event(run_id: str, text: str, chunk_id: Optional[str] = None,
                 tick: Optional[int] = None, audience: str = "all") -> dict:
    row = db.query_one("SELECT current_tick, status FROM runs WHERE id=?", (run_id,))
    if row is None:
        raise AppError("run not found", component="engine", stage="inject", status_code=404)
    if chunk_id is not None:
        from app import db as _db
        if _db.query_one("SELECT id FROM chunks WHERE id=?", (chunk_id,)) is None:
            raise AppError("unknown chunk_id", component="engine", stage="inject", status_code=400)
    ev = {"tick": tick if tick is not None else (row["current_tick"] or 0) + 1,
          "text": text[:500], "chunk_id": chunk_id, "source": "live",
          "audience": audience or "all"}
    sid = _scheduled_id(run_id, ev["tick"], ev["text"], ev["audience"])
    ev["sid"] = sid
    # Persist the schedule so it survives restarts; marked "fired" when it lands.
    db.execute("INSERT INTO events(run_id, tick, kind, payload_json, created_at)"
               " VALUES(?,?,?,?,?)",
               (run_id, ev["tick"], "scheduled",
                db.j({"sid": sid, "text": ev["text"], "chunk_id": chunk_id,
                      "audience": ev["audience"], "source": "live", "status": "scheduled"}),
                _now()))
    _injected.setdefault(run_id, []).append(ev)
    return ev


def _scheduled_id(run_id: str, tick: int, text: str, audience: str) -> str:
    import hashlib
    return "se_" + hashlib.sha1(f"{run_id}|{tick}|{text}|{audience}".encode()).hexdigest()[:8]


def _rehydrate_scheduled(run_id: str) -> None:
    """Queued events written to the events table survive restarts; rebuild the in-memory queue."""
    queue = _injected.get(run_id, [])
    for r in db.query("SELECT tick, payload_json FROM events WHERE run_id=? AND kind='scheduled'"
                      " ORDER BY tick", (run_id,)):
        p = db.uj(r["payload_json"], {}) or {}
        if p.get("status") != "scheduled":
            continue
        ev = {"tick": r["tick"], "text": p.get("text", ""), "chunk_id": p.get("chunk_id"),
              "source": p.get("source", "live"), "audience": p.get("audience", "all"),
              "sid": p.get("sid")}
        if ev not in queue:
            queue.append(ev)
    _injected[run_id] = queue


def _consume_injected(run_id: str, tick: int) -> list[dict]:
    queue = _injected.get(run_id, [])
    due = [e for e in queue if e["tick"] <= tick]
    _injected[run_id] = [e for e in queue if e["tick"] > tick]
    for ev in due:  # honest: the persisted schedule row now records it fired
        if not ev.get("sid"):
            continue
        p = {"sid": ev["sid"], "text": ev.get("text", ""), "chunk_id": ev.get("chunk_id"),
             "audience": ev.get("audience", "all"), "source": ev.get("source", "live"),
             "status": "fired"}
        db.execute("UPDATE events SET payload_json=? WHERE run_id=? AND kind='scheduled'"
                   " AND payload_json LIKE ?", (db.j(p), run_id, f'%{ev["sid"]}%'))
    return due


# ---------------------------------------------------------------------------
# Worker loop
# ---------------------------------------------------------------------------

async def _run_worker(run_id: str) -> None:
    try:
        ctx = await load_context(run_id)
        status = db.scalar("SELECT status FROM runs WHERE id=?", (run_id,))
        if status != "running":
            return
        while True:
            row = db.query_one("SELECT status FROM runs WHERE id=?", (run_id,))
            if row is None or row["status"] in ("interrupted",):
                break
            if row["status"] == "paused":
                await asyncio.sleep(0.3)
                continue
            if ctx.last_completed >= ctx.cfg["ticks"]:
                db.execute("UPDATE runs SET status='completed', updated_at=?, finished_at=?, current_tick=? WHERE id=?",
                           (_now(), _now(), ctx.cfg["ticks"], run_id))
                emit(run_id, "run_status", {"status": "completed",
                                            "tick": ctx.cfg["ticks"]})
                try:  # auto-generate the deterministic report snapshot
                    from app.analytics.report import generate_report
                    generate_report(run_id)
                except Exception as e:  # noqa: BLE001 — reporting must never fail a run
                    log_event(run_id, ctx.cfg["ticks"], "warning",
                              {"report_error": f"{type(e).__name__}: {e}"[:200]})
                break
            tick = ctx.last_completed + 1
            db.execute("UPDATE runs SET status='running', current_tick=?, updated_at=? WHERE id=?",
                       (tick, _now(), run_id))
            emit(run_id, "tick_started", {"tick": tick, "of": ctx.cfg["ticks"]})
            try:
                used = await do_tick(ctx, tick)
            except BudgetExhausted as e:
                ctx.budget_exhausted = True
                _pause_with_reason(run_id, f"LLM budget reached: {e}",
                                   "Raise this run's call budget, then resume. "
                                   "Posts from completed rounds are kept.")
                break
            except AppError as e:
                if _should_pause(e):
                    _pause_with_reason(run_id, e.message, e.hint or "")
                else:
                    _fail_run(run_id, e)
                break
            if ctx.failure_streak >= 3 and ctx.failure_rate() > 0.5:
                ctx.pause_self()
            ctx.last_completed = tick
            emit(run_id, "tick_completed", {"tick": tick, "metrics": ctx.last_metrics})
            if ctx.budget_exhausted:
                _pause_with_reason(run_id, "LLM budget reached during this round",
                                   "Raise this run's call budget, then resume. "
                                   "The round's fallback posts are recorded and marked.")
                break
        # graceful exit states are set above or by stop/pause
    except asyncio.CancelledError:
        raise
    except Exception as e:  # noqa: BLE001
        _fail_run(run_id, AppError(f"engine crashed: {type(e).__name__}: {e}",
                                   component="engine", stage="tick", error_type="internal"))


def _should_pause(e: AppError) -> bool:
    """Provider/config failures a person can fix: pause and keep the run resumable."""
    if e.error_type in ("missing_key", "missing_config", "provider_failed"):
        return True
    return bool(e.http_status in (401, 402, 403, 429) or (e.http_status or 0) >= 500)


def _pause_with_reason(run_id: str, message: str, hint: str = "") -> None:
    """Pause (not fail) at a round boundary, recording exactly why."""
    db.execute(
        "UPDATE runs SET status='paused', error_json=?, updated_at=? WHERE id=?",
        (db.j({"message": message, "hint": hint, "error_type": "paused",
               "provider": None, "model": None}), _now(), run_id))
    tick = db.scalar("SELECT last_completed_tick FROM runs WHERE id=?", (run_id,)) or 0
    log_event(run_id, tick, "warning", {"message": message, "paused": True, "hint": hint})
    emit(run_id, "run_status", {"status": "paused", "reason": message})


def _fail_run(run_id: str, e: AppError) -> None:
    db.execute("UPDATE runs SET status='failed', error_json=?, updated_at=?, finished_at=? WHERE id=?",
               (db.j({"message": e.message, "hint": e.hint, "error_type": e.error_type,
                      "provider": e.provider, "model": e.model}), _now(), _now(), run_id))
    db.execute("INSERT INTO events(run_id, tick, kind, payload_json, created_at)"
               " VALUES(?,?,?,?,?)",
               (run_id, db.scalar("SELECT current_tick FROM runs WHERE id=?", (run_id,)) or 0,
                "error", db.j({"message": e.message, "hint": e.hint}), _now()))
    emit(run_id, "error", {"message": e.message, "hint": e.hint, "error_type": e.error_type})
    emit(run_id, "run_status", {"status": "failed"})



class Context:
    """In-memory state for one run."""

    def __init__(self, run_id: str, run_row, brief: dict, agents: list[dict],
                 edges: dict[str, dict], pool: list[dict], chunk_ids: set[str],
                 scenario: dict, config: dict):
        self.run_id = run_id
        self.run = dict(run_row)
        self.brief = brief
        self.issue_ids = [i["id"] for i in (brief.get("issues") or [])]
        self.agents = agents
        self.edges = edges
        self.pool = pool              # recent posts (last 5 ticks, enriched dicts)
        self.chunk_ids = chunk_ids
        self.scenario = scenario
        self.cfg = config
        self.budget_exhausted = False
        self.last_completed = run_row["last_completed_tick"] or 0
        self.failure_history: list[float] = []
        self.last_metrics: dict = {}
        self.post_buffer: list[dict] = []
        self.post_deltas: dict[str, dict[str, int]] = {}
        self.reflection_snapshot: dict[str, dict[str, float]] = {}
        self.failure_streak = 0
        self.baseline_calls = current_used(run_id)
        self._post_seq: dict[int, int] = {}
        self._run_seq = int(db.scalar(
            "SELECT COALESCE(MAX(seq),0) FROM posts WHERE run_id=?", (run_id,)) or 0)
        self.write_meta: dict[str, dict] = {}
        self._rng_tick: Optional[int] = None

    def next_post_seq(self, tick: int) -> int:
        n = self._post_seq.get(tick, 0)
        self._post_seq[tick] = n + 1
        return n

    def next_run_seq(self) -> int:
        self._run_seq += 1
        return self._run_seq

    def failure_rate(self) -> float:
        if not self.failure_history:
            return 0.0
        return sum(1 for f in self.failure_history if f > 0.5) / max(1, len(self.failure_history))

    def pause_self(self) -> None:
        db.execute("UPDATE runs SET status='paused', updated_at=? WHERE id=?",
                   (_now(), self.run_id))
        emit(self.run_id, "run_status", {"status": "paused"})


async def load_context(run_id: str) -> Context:
    row = db.query_one("SELECT * FROM runs WHERE id=?", (run_id,))
    if row is None:
        raise AppError("run not found", component="engine", stage="load", status_code=404)
    brief = db.uj(row["source_id"] and db.scalar(
        "SELECT brief_json FROM sources WHERE id=?", (row["source_id"],)) or "{}", {}) or {}
    scenario = db.uj(row["scenario_json"], {}) or {}
    cfg = db.uj(row["config_json"], {}) or {}
    src_id = row["source_id"]
    chunk_ids = {r["id"] for r in db.query("SELECT id FROM chunks WHERE source_id=?", (src_id,))}
    agents_rows = db.query("SELECT * FROM agents WHERE run_id=? ORDER BY id", (run_id,))
    agents: list[dict] = []
    for r in agents_rows:
        a = {
            "id": r["id"], "handle": r["handle"], "name": r["name"], "bio": r["bio"],
            "archetype": r["archetype"], "group": r["stakeholder_group"],
            "persona": db.uj(r["persona_json"], {}), "big5": db.uj(r["personality_json"], {}),
            "traits": db.uj(r["traits_json"], {}), "goals": db.uj(r["goals_json"], []),
            "interests": db.uj(r["interests_json"], []),
            "stances": {k: dict(v) for k, v in (db.uj(r["stances_json"], {}) or {}).items()},
            "state": db.uj(r["state_json"], {}) or {"mood": 0.0, "arousal": 0.2, "fatigue": 0.0},
            "knowledge": db.uj(r["knowledge_json"], []) or [],
            "belief_summary": r["belief_summary"] or "",
            "memories": [], "_source_id": src_id,
        }
        for m in db.query("SELECT * FROM memories WHERE run_id=? AND agent_id=? ORDER BY tick, id",
                          (run_id, r["id"])):
            a["memories"].append({"tick": m["tick"], "kind": m["kind"], "text": m["text"],
                                  "importance": m["importance"], "refs": db.uj(m["refs_json"], [])})
        agents.append(a)
    edges: dict[str, dict] = {}
    for r in db.query("SELECT * FROM edges WHERE run_id=?", (run_id,)):
        edges[f"{r['src']}|{r['dst']}"] = {"src": r["src"], "dst": r["dst"],
                                            "follows": r["follows"], "weight": r["weight"],
                                            "interactions": r["interactions"]}
    pool: list[dict] = []
    from_tick = max(0, (row["last_completed_tick"] or 0) - 4)
    for r in db.query(
            "SELECT * FROM posts WHERE run_id=? AND tick>=? ORDER BY tick, id", (run_id, from_tick)):
        pool.append(_post_from_row(r))
    ctx = Context(run_id, row, brief, agents, edges, pool, chunk_ids, scenario, cfg)
    ctx.reflection_snapshot = {
        a["id"]: {iid: st["value"] for iid, st in a["stances"].items()} for a in agents}
    return ctx


def _post_from_row(r) -> dict:
    return {"id": r["id"], "tick": r["tick"], "agent_id": r["agent_id"], "kind": r["kind"],
            "parent_id": r["parent_id"], "text": r["text"],
            "stance": db.uj(r["stance_json"], {}) or {}, "emotion": r["emotion"] or "",
            "cited": db.uj(r["cited_chunk_ids_json"], []) or [],
            "likes": r["likes"], "reposts": r["reposts"], "replies": r["replies"],
            "is_fallback": r["is_fallback"], "run_id": r["run_id"],
            "seq": r["seq"], "model": r["model"], "provider": r["provider"],
            "via_fallback": r["via_fallback"]}


# ---------------------------------------------------------------------------
# Seeding
# ---------------------------------------------------------------------------

async def seed_run(run_id: str, gateway) -> int:
    """Create agents + edges. Returns agent count. Marks run 'seeding' -> 'ready'."""
    row = db.query_one("SELECT * FROM runs WHERE id=?", (run_id,))
    if row is None:
        raise AppError("run not found", component="engine", stage="seed", status_code=404)
    db.execute("UPDATE runs SET status='seeding', updated_at=? WHERE id=?", (_now(), run_id))
    emit(run_id, "run_status", {"status": "seeding"})
    brief = db.uj(db.scalar("SELECT brief_json FROM sources WHERE id=?", (row["source_id"],)) or "{}", {}) or {}
    scenario = db.uj(row["scenario_json"], {}) or {}
    cfg = db.uj(row["config_json"], {}) or {}
    n = int(cfg.get("agents", 16))
    rng = random_rng(row["seed"])

    slots = seeding.assign_targets(n, brief, cfg, rng)
    issue_ids = [i["id"] for i in (brief.get("issues") or [])]
    agents: list[dict] = []
    batch_size = 5
    used_handles: set[str] = set()
    batches = [slots[i:i + batch_size] for i in range(0, n, batch_size)]
    fallback_count = 0
    for bi, batch in enumerate(batches):
        emit(run_id, "stage", {"label": "Generating personas", "i": bi + 1, "n": len(batches)})
        outs: list[PersonaOut] = []
        try:
            result = await gateway.complete("persona", seeding.persona_prompt(batch, brief),
                                            expect=PersonaOut, run_id=run_id,
                                            max_items=len(batch))
            raw = result.parsed if isinstance(result.parsed, list) else [result.parsed]
            outs = [p for p in raw if isinstance(p, PersonaOut)]
        except (AppError, BudgetExhausted) as e:
            if isinstance(e, BudgetExhausted):
                raise
        for j, slot in enumerate(batch):
            out = outs[j] if j < len(outs) else None
            if out is None:
                fallback_count += 1
                out = seeding.template_persona(slot, issue_ids)
            agent = clamp_to_agent(slot, out, bi * batch_size + j, run_id)
            # de-duplicate handle collisions within the run
            if agent["handle"] in used_handles:
                agent["handle"] = f"{agent['handle'][:14]}{slot['ordinal']}"
            used_handles.add(agent["handle"])
            # knowledge: 2-4 chunks via BM25 on interests
            src_id = row["source_id"]
            known = knowledge_for(src_id, agent["interests"], rng, target=2 + (j % 3))
            agent["knowledge"] = known
            agent["_source_id"] = src_id
            agent["belief_summary"] = f"{agent['bio']} Weighs in from the {agent['group']} side."
            agents.append(agent)
    edges = seeding.initial_edges(agents, rng)
    persist_agents(run_id, agents, edges)
    # A stop/pause requested while personas were generating must win: never flip an
    # interrupted run back to 'ready' behind the user's back.
    current = db.scalar("SELECT status FROM runs WHERE id=?", (run_id,))
    final_status = current if current in ("interrupted", "failed", "paused") else "ready"
    db.execute(
        "UPDATE runs SET status=?, last_completed_tick=0, rng_state=?,"
        " llm_calls_used=0, updated_at=? WHERE id=?", (final_status, "0", _now(), run_id))
    emit(run_id, "run_status", {"status": final_status, "agents": len(agents),
                                "fallback_personas": fallback_count})
    return len(agents)


async def seed_and_start(run_id: str, gateway, *, resume: bool = False) -> None:
    """Background path for Start/Resume: seed if needed, then run. Never leaves
    a client disconnect responsible for finishing a seed."""
    try:
        if (db.scalar("SELECT COUNT(*) FROM agents WHERE run_id=?", (run_id,)) or 0) == 0:
            await seed_run(run_id, gateway)
        status = db.scalar("SELECT status FROM runs WHERE id=?", (run_id,))
        allowed = {"ready", "paused", "interrupted", "draft"} if resume else {"ready", "draft"}
        if status in allowed:
            await start_run(run_id)
    except BudgetExhausted as e:
        _pause_with_reason(run_id, f"LLM budget reached while seeding: {e}",
                           "Raise the run's call budget, then resume.")
    except AppError as e:
        if _should_pause(e):
            _pause_with_reason(run_id, e.message, e.hint or "")
        else:
            _fail_run(run_id, e)


def random_rng(seed: int) -> __import__("random").Random:
    import random as _random
    return _random.Random(seed)


def clamp_to_agent(slot: dict, out: PersonaOut, ordinal: int, run_key: str = "") -> dict:
    clamped = seeding.clamp_persona(out, slot, list(slot["targets"].keys()))
    big5 = clamped["big5"]
    return {
        "id": seeding.agent_id(ordinal, run_key), "handle": clamped["handle"], "name": clamped["name"],
        "bio": clamped["bio"], "archetype": clamped["archetype"], "group": clamped["group"],
        "persona": clamped, "big5": big5, "traits": seeding.derived_traits(big5),
        "goals": clamped["goals"], "interests": clamped["interests"],
        "stances": clamped["stances"], "state": {"mood": 0.0, "arousal": 0.2, "fatigue": 0.0},
        "knowledge": [], "belief_summary": "", "memories": [],
    }


def knowledge_for(source_id: str, interests: list[str], rng, target: int = 3) -> list[str]:
    query = " ".join(interests[:5]) or "main claims evidence"
    hits = [cid for cid, _s in index_mod.search(source_id, query, k=10)]
    if not hits:
        rows = db.query("SELECT id FROM chunks WHERE source_id=? ORDER BY idx LIMIT 5", (source_id,))
        hits = [r["id"] for r in rows]
    if not hits:
        return []
    take = min(target, len(hits))
    picked = hits[:take]
    rng.shuffle(picked)
    return picked[:target]


def persist_agents(run_id: str, agents: list[dict], edges: dict[str, dict]) -> None:
    with db.tx() as conn:
        conn.execute("DELETE FROM agents WHERE run_id=?", (run_id,))
        conn.execute("DELETE FROM edges WHERE run_id=?", (run_id,))
        for a in agents:
            conn.execute(
                "INSERT INTO agents(id, run_id, handle, name, bio, archetype, stakeholder_group,"
                " persona_json, personality_json, traits_json, goals_json, interests_json,"
                " stances_json, state_json, knowledge_json, belief_summary, source_chunk_ids_json)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (a["id"], run_id, a["handle"], a["name"], a["bio"], a["archetype"], a["group"],
                 db.j(a["persona"]), db.j(a["big5"]), db.j(a["traits"]), db.j(a["goals"]),
                 db.j(a["interests"]), db.j(a["stances"]), db.j(a["state"]),
                 db.j(a["knowledge"]), a["belief_summary"][:400], db.j(a["knowledge"])))
        for e in edges.values():
            if e["src"] == e["dst"]:
                continue  # never persist a self-relationship (agent reacting to own post)
            conn.execute(
                "INSERT OR REPLACE INTO edges(run_id, src, dst, follows, weight, interactions,"
                " last_tick) VALUES(?,?,?,?,?,?,?)",
                (run_id, e["src"], e["dst"], e["follows"], e["weight"], e["interactions"], 0))


# ---------------------------------------------------------------------------
# Tick
# ---------------------------------------------------------------------------

async def do_tick(ctx: Context, tick: int) -> int:
    """One full tick. Returns LLM calls used. Commits atomically."""
    run_id = ctx.run_id
    used_pre = current_used(run_id)
    rng = __import__("random").Random(f"{ctx.run.get('seed')}|{tick}")
    llm_used = 0
    fallback_count = 0
    follows_gained = follows_lost = reaction_count = 0

    # 1. events ------------------------------------------------------------
    new_posts: list[dict] = []
    sched = events_mod.scheduled_events(ctx.scenario)
    for ev in [e for e in sched if e["tick"] == tick]:
        sp = events_mod.system_post(run_id, tick, ev["text"])
        new_posts.append(sp)
        log_event(run_id, tick, "news", {"text": ev["text"]})
        emit(run_id, "post_created", {"post": sp})
    for ev in _consume_injected(run_id, tick):
        aud = ev.get("audience") or "all"
        if aud != "all":
            # Private briefing: only that stakeholder group receives it — no public
            # newsroom post, no knowledge push outside the group. Traceable via
            # each member's memory (visible in the Agents tab) and the event log.
            members = [a for a in ctx.agents if a.get("group") == aud]
            for a in members:
                memory.add_item(a, tick, "event",
                                f"[Briefing] {ev['text']}", importance=0.7)
                if ev.get("chunk_id") and ev["chunk_id"] in ctx.chunk_ids \
                        and ev["chunk_id"] not in a["knowledge"] and rng.random() < 0.5:
                    a["knowledge"].append(ev["chunk_id"])
                    memory.add_item(a, tick, "discovered_chunk",
                                    f"A private briefing pointed you to a document excerpt"
                                    f" ({ev['chunk_id']})", refs=[ev["chunk_id"]])
            log_event(run_id, tick, "news", {"text": ev["text"], "audience": aud,
                                             "audience_size": len(members), "live": True,
                                             "private": True})
        elif ev.get("chunk_id") and ev["chunk_id"] in ctx.chunk_ids:
            targets = [a for a in ctx.agents if rng.random() < 0.3]
            for a in targets:
                if ev["chunk_id"] not in a["knowledge"]:
                    a["knowledge"].append(ev["chunk_id"])
                    memory.add_item(a, tick, "discovered_chunk",
                                    f"Live event pushed a document excerpt ({ev['chunk_id']})",
                                    refs=[ev["chunk_id"]])
            log_event(run_id, tick, "news", {"text": ev["text"], "chunk_id": ev["chunk_id"],
                                             "pushed_to": len(targets), "live": True})
            if ev.get("text"):
                sp = events_mod.system_post(run_id, tick, ev["text"])
                new_posts.append(sp)
                emit(run_id, "post_created", {"post": sp})
        else:
            sp = events_mod.system_post(run_id, tick, ev["text"])
            new_posts.append(sp)
            log_event(run_id, tick, "news", {"text": ev["text"], "live": True,
                                             "audience": "all"})
            emit(run_id, "post_created", {"post": sp})
    # discovery every 3 ticks
    if tick % 3 == 0:
        n = events_mod.discover_chunks(ctx.agents, tick, rng, index_mod)
        if n:
            log_event(run_id, tick, "discovery", {"agents": n})

    pool = ctx.pool + [p for p in new_posts]

    # 2. activation ----------------------------------------------------------
    active: list[dict] = []
    for a in ctx.agents:
        if rng.random() < a["traits"]["activity"] * (1 - min(1.0, a["state"].get("fatigue", 0))):
            active.append(a)
            a["state"]["fatigue"] = min(1.0, a["state"].get("fatigue", 0) + 0.1)
        else:
            a["state"]["fatigue"] = max(0.0, a["state"].get("fatigue", 0) - 0.05)

    # 3-4. feeds, reactions, follows -----------------------------------------
    seen_by_agent: dict[str, list[tuple[dict, bool, bool]]] = {}
    conflict_exposure: dict[str, float] = {}
    agree_received: dict[str, list[float]] = {}
    for a in ctx.agents:
        if a not in active:
            seen_by_agent[a["id"]] = []
            continue
        following_items = [(f"{a['id']}|{p.get('agent_id')}" in ctx.edges and
                            ctx.edges[f"{a['id']}|{p.get('agent_id')}"].get("follows"))
                           for p in pool]
        scored = []
        for p, fol in zip(pool, following_items):
            scored.append((feed_mod.score_post(p, a, fol, tick, rng, ctx.issue_ids), p))
        scored.sort(key=lambda sp: (-sp[0], sp[1]["id"]))
        keep = max(1, round(10 * 0.8))
        feed = [p for _s, p in scored[:keep]]
        explore = [p for _s, p in scored[keep:]]
        rng.shuffle(explore)
        feed = feed + explore[:max(0, 10 - len(feed))]
        # decide reactions first, then build seen flags once
        likes_reposts = policy.decide_reactions(a, feed, ctx.edges, rng, ctx.issue_ids)
        liked: set[str] = {pid for pid, k in likes_reposts if k == "like"}
        reposted: set[str] = {pid for pid, k in likes_reposts if k == "repost"}
        seen_by_agent[a["id"]] = [(p, p["id"] in liked, p["id"] in reposted) for p in feed]
        for post_id, kind in likes_reposts:
            target = next((p for p in pool if p["id"] == post_id), None)
            if target is None or target.get("kind") == "system":
                continue
            ctx.post_deltas.setdefault(post_id, {"likes": 0, "reposts": 0, "replies": 0})
            if kind == "like":
                reaction_count += 1
                ctx.post_deltas[post_id]["likes"] += 1
                tgt = target.get("agent_id")
                if tgt and tgt != "newsroom":
                    relations.reaction(ctx.edges, a["id"], tgt)
                    agree_received.setdefault(tgt, []).append(
                        feed_mod.agreement(target, a, ctx.issue_ids))
            else:
                ctx.post_deltas[post_id]["reposts"] += 1
        # follow / unfollow
        for target, action in policy.decide_follows(a, feed, ctx.edges, ctx.issue_ids):
            changed = relations.set_follow(ctx.edges, a["id"], target, action == "follow")
            if changed:
                if action == "follow":
                    follows_gained += 1
                    tgt_agent = next((x for x in ctx.agents if x["id"] == target), None)
                    if tgt_agent:
                        memory.add_item(tgt_agent, tick, "new_follower",
                                        f"@{a['handle']} started following you", refs=[a["id"]])
                else:
                    follows_lost += 1
        conflict = max((abs(feed_mod.agreement(p, a, ctx.issue_ids) - 1)) for p in feed) if feed else 0.0
        conflict_exposure[a["id"]] = min(1.0, conflict / 2)

    # 5. speakers ---------------------------------------------------------------
    urges: list[tuple[float, str, dict]] = []
    for a in active:
        feed = [p for p, _lk, _rp in seen_by_agent.get(a["id"], [])]
        pro = feed_mod.provocation(feed, a, ctx.issue_ids)
        sal = feed_mod.salience(a, ctx.issue_ids)
        urge = a["big5"]["extraversion"] * (0.5 + a["state"].get("arousal", 0.2)) * sal * (0.3 + pro)
        urges.append((urge + rng.random() * 1e-9, a["id"], a))
    urges.sort(key=lambda t: (-t[0], t[1]))
    w = int(ctx.cfg.get("writes_per_tick", 4))
    budget_cap = ctx.cfg.get("max_llm_calls")
    remaining = None if budget_cap is None else max(0, int(budget_cap) - current_used(ctx.run_id)) 
    if remaining is not None and remaining == 0 and not ctx.budget_exhausted:
        ctx.budget_exhausted = True
    speakers = [a for _u, _i, a in urges[:w]]
    per_agent_action: dict[str, dict] = {}
    for a in speakers:
        feed = [p for p, _lk, _rp in seen_by_agent.get(a["id"], [])]
        best = most_provoking(feed, a, ctx.issue_ids)
        target_post = best[0] if best else None
        per_agent_action[a["id"]] = {"action": "reply" if best and best[1] > 0.5 else "post",
                                     "target": target_post,
                                     "target_id": target_post["id"] if target_post else None}

    # 6. writing -----------------------------------------------------------------
    write_batch = max(1, int(ctx.cfg.get("write_batch", 3)))
    items_by_agent: dict[str, WriteItem] = {}
    if w > 0 and speakers and not ctx.budget_exhausted:
        batches = [speakers[i:i + write_batch] for i in range(0, len(speakers), write_batch)]
        tasks = [_write_batch_call(ctx, tick, b, items_by_agent, per_agent_action) for b in batches]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for r in results:
            if isinstance(r, BudgetExhausted):
                ctx.budget_exhausted = True
        ctx.failure_history.extend(1.0 if isinstance(r, Exception) else 0.0 for r in results)
        ctx.failure_history = ctx.failure_history[-3:]
        ctx.failure_streak = sum(1 for f in ctx.failure_history if f > 0.5)
    for a in speakers:
        if a["id"] not in items_by_agent:
            item = fallback_repost(a, ctx, rng, tick)
            fallback_count += 1
            per_agent_action[a["id"]] = {"action": "repost", "target": None,
                                         "target_id": None, "item": item}
        else:
            item = items_by_agent[a["id"]]
            target_post = find_post(ctx.pool + new_posts, item.reply_to)
            per_agent_action[a["id"]] = {"action": item.action, "target": target_post,
                                         "target_id": target_post["id"] if target_post else None}

    for a in speakers:
        spec = per_agent_action[a["id"]]
        if a["id"] in ctx.write_meta:
            spec["write_meta"] = ctx.write_meta[a["id"]]
        item: Any = spec.get("item")
        if item is None:
            wi = items_by_agent.get(a["id"])
            if wi is None:
                continue
            item = wi
        post = materialize_post(ctx, tick, a, item, spec, rng)
        if post is None:
            fallback_count += 1
            item = fallback_repost(a, ctx, rng, tick)
            post = materialize_post(ctx, tick, a, item,
                                    {"action": "repost", "target": None,
                                     "fallback_template": True}, rng)
        if post is not None:
            new_posts.append(post)
            emit(run_id, "post_created", {"post": post})
            opinion.apply_author_shift(a, {"stance": post["stance"]}, ctx.issue_ids)
            memory.add_item(a, tick, "own_post", post["text"][:200], refs=post["cited"])

    # 7. opinion updates ---------------------------------------------------------
    for a in ctx.agents:
        for post, liked, replied in seen_by_agent.get(a["id"], []):
            author = next((x for x in ctx.agents if x["id"] == post["agent_id"]), None)
            if author is None:
                continue  # newsroom etc.
            edge = ctx.edges.get(f"{a['id']}|{post['agent_id']}", {})
            changed = opinion.update_from_post(
                a, author, post, ctx.issue_ids, liked, replied,
                bool(ctx.cfg.get("backfire", True)), float(edge.get("weight", 0.0)))
            if changed and abs(feed_mod.agreement(post, a, ctx.issue_ids) - 1) > 0.8:
                memory.add_item(a, tick, "strong_disagreement", post["text"][:200],
                                refs=[post["agent_id"]])
        arousal = a["state"].get("arousal", 0.2)
        conflict = conflict_exposure.get(a["id"], 0.0)
        a["state"]["arousal"] = round(min(1.0, max(0.0, 0.8 * arousal + 0.3 * conflict)), 4)
        got = agree_received.get(a["id"])
        if got:
            a["state"]["mood"] = round(max(-1.0, min(1.0, a["state"].get("mood", 0.0)
                                                      + 0.2 * (sum(got) / len(got) - 0.5))), 4)

    # 8. relations reply bumps + decay ------------------------------------------
    for a in speakers:
        spec = per_agent_action[a["id"]]
        target_id = spec.get("target_id")
        item = items_by_agent.get(a["id"])
        if item is not None and item.action == "reply" and item.reply_to:
            target_id = item.reply_to
        if spec["action"] == "reply" and target_id is not None:
            parent = find_post(ctx.pool + new_posts, target_id)
            if parent is not None:
                ctx.post_deltas.setdefault(parent["id"], {"likes": 0, "reposts": 0, "replies": 0})
                ctx.post_deltas[parent["id"]]["replies"] += 1
                parent_agent = next((x for x in ctx.agents if x["id"] == parent["agent_id"]), None)
                reply_text = item.text if item is not None else "(replied)"
                if parent_agent is not None:
                    agree = feed_mod.agreement(parent, a, ctx.issue_ids) > 0.5
                    relations.reply(ctx.edges, a["id"], parent["agent_id"], agree)
                    memory.add_item(parent_agent, tick, "reply_received",
                                    f"@{a['handle']} replied: \"{reply_text[:150]}\"",
                                    refs=[a["id"]])
    relations.decay(ctx.edges)

    # 9. reflection ---------------------------------------------------------------
    reflect_every = int(ctx.cfg.get("reflect_every", 5) or 0)
    if reflect_every > 0 and tick % reflect_every == 0 and not ctx.budget_exhausted:
        llm_used += await reflection(ctx, tick)

    # 10. metrics + commit ---------------------------------------------------------
    llm_used = max(0, current_used(run_id) - used_pre)
    mm = metrics_mod.compute(ctx.agents, ctx.issue_ids, new_posts, reaction_count,
                             follows_gained, follows_lost, fallback_count,
                             len(active), llm_used, len(ctx.edges), tick)
    ctx.last_metrics = mm
    commit_tick(ctx, tick, new_posts)
    used_after = current_used(run_id)
    llm_used = max(0, used_after - ctx.baseline_calls)
    emit(run_id, "llm_call", {"task": "tick_summary", "calls": llm_used,
                              "used_total": used_after})
    return llm_used


def target_is_system(post: dict) -> bool:
    return post.get("kind") == "system"


def most_provoking(feed: list[dict], agent: dict, issue_ids: list[str]) -> Optional[tuple[dict, float]]:
    best = None
    for p in feed:
        if target_is_system(p):
            continue
        diff = abs(feed_mod.agreement(p, agent, issue_ids) - 1)
        if best is None or diff > best[1]:
            best = (p, diff)
    return best


def current_used(run_id: str) -> int:
    row = db.query_one("SELECT llm_calls_used FROM runs WHERE id=?", (run_id,))
    return (row["llm_calls_used"] or 0) if row else 0


def find_post(pool: list[dict], post_id: Optional[str]) -> Optional[dict]:
    if not post_id:
        return None
    return next((p for p in pool if p["id"] == post_id), None)


def log_event(run_id: str, tick: int, kind: str, payload: dict) -> None:
    db.execute("INSERT INTO events(run_id, tick, kind, payload_json, created_at)"
               " VALUES(?,?,?,?,?)", (run_id, tick, kind, db.j(payload), _now()))
    emit(run_id, "event", {"tick": tick, "kind": kind, **payload})


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------

def _persona_card(a: dict) -> str:
    st_words = ", ".join(
        f"{iid}={v['value']:+.1f} (conf {v.get('confidence', 0.5):.0%})"
        for iid, v in a["stances"].items())
    return (f"{a['name']} (@{a['handle']}) — {a['archetype']}, {a['group']}. {a['bio']}\n"
            f"goals: {'; '.join(a['goals'] or [])}\ninterests: {', '.join(a['interests'][:6])}\n"
            f"beliefs: {a['belief_summary'][:200]}\n"
            f"stances on the issues: {st_words}")


def _feed_lines(feed: list[dict], agents_by_id: dict[str, dict], limit: int = 3) -> str:
    lines = []
    for p in feed[:limit]:
        author = agents_by_id.get(p.get("agent_id"), {}).get("handle", p.get("agent_id", "?"))
        lines.append(f'[post_id "{p["id"]}" by @{author}] "{p["text"][:280]}"')
    return "\n".join(lines)


def _chunk_lines(ctx: Context, a: dict, limit: int = 2) -> str:
    rows = ctx.chunk_ids
    known = [cid for cid in a["knowledge"] if cid in rows]
    out = []
    for cid in known[:limit]:
        r = db.query_one("SELECT id, text, page_start, page_end, heading FROM chunks WHERE id=?", (cid,))
        if r:
            out.append(f"[{r['id']} p.{r['page_start']}-{r['page_end']}] {(r['heading'] or '')}\n{r['text'][:700]}")
    return "\n\n".join(out)


def _write_messages(ctx: Context, tick: int, batch: list[dict],
                    per_agent_action: dict[str, dict]) -> list[dict]:
    agents_by_id = {a["id"]: a for a in ctx.agents}
    blocks = []
    for a in batch:
        spec = per_agent_action[a["id"]]
        feed = [p for p, _lk, _rp in _ctx_seen(ctx, a, tick)]
        target = spec.get("target_id")
        lines = [
            "=== AGENT",
            f'agent_id must be exactly "{a["id"]}"',
            _persona_card(a),
            f"FEED:\n{_feed_lines(feed, agents_by_id)}",
        ]
        chunks_txt = _chunk_lines(ctx, a)
        if chunks_txt:
            lines.append(f"SOURCES:\n{chunks_txt}")
        if spec["action"] == "reply" and target:
            lines.append(f'TASK: action: reply to post_id "{target}" (1-3 sentences, stay in character)')
        else:
            lines.append("TASK: action: start a new post (1-3 sentences, stay in character, "
                         "state your view on the issues and cite chunk ids you use)")
        blocks.append("\n".join(lines))
    sys = (
        "You run a social-media simulation step. Voices must reflect each persona's beliefs and style. "
        "Return ONLY a JSON array with exactly one object per AGENT block above, in the same order:\n"
        '[{"agent_id": "<id from the block>", "action": "post"|"reply", "reply_to": post_id or null, '
        '"text": "1-3 sentences", "stance": {"<issue_id>": number -1..1 (your CURRENT view after what you saw)}, '
        '"emotion": "neutral|happy|angry|anxious|proud", "cited_chunk_ids": ["c_..."]|null}]\n'
        "Use the agent block's requested action. Never hashtag-spam. Cite only chunk ids given to you."
    )
    issues_line = "Issues for stance keys: " + ", ".join(ctx.issue_ids)
    return [{"role": "system", "content": sys + "\n" + issues_line},
            {"role": "user", "content": "\n\n".join(blocks)}]


def _ctx_seen(ctx: Context, agent: dict, tick: int) -> list[tuple[dict, bool, bool]]:
    """Recompute a small feed for the writer prompt (deterministic, cheap)."""
    import random as _random
    rng = _random.Random(f"{ctx.run.get('seed')}|{tick}|feed2|{agent['id']}")
    pool = ctx.pool
    out = []
    for p in pool:
        edge = ctx.edges.get(f"{agent['id']}|{p.get('agent_id')}")
        following = bool(edge and edge.get("follows"))
        s = feed_mod.score_post(p, agent, following, tick, rng, ctx.issue_ids)
        out.append((s, p))
    out.sort(key=lambda sp: (-sp[0], sp[1]["id"]))
    return [(p, False, False) for _s, p in out[:10]]


async def _write_batch_call(ctx: Context, tick: int, batch: list[dict],
                            items_by_agent: dict[str, WriteItem],
                            per_agent_action: dict[str, dict]) -> None:
    messages = _write_messages(ctx, tick, batch, per_agent_action)
    result = await _gateway().complete("write", messages, expect=WriteItem,
                                       run_id=ctx.run_id, max_items=len(batch))
    items = result.parsed if isinstance(result.parsed, list) else [result.parsed]
    meta = {"model": result.model, "provider": result.provider,
            "from_cache": result.from_cache}
    seen_ids: set[str] = set()
    for item in items:
        if item is None or not item.agent_id or item.agent_id in seen_ids:
            continue
        seen_ids.add(item.agent_id)
        if any(a["id"] == item.agent_id for a in batch):
            items_by_agent[item.agent_id] = item
            ctx.write_meta[item.agent_id] = meta


def _gateway():
    from app.llm.gateway import gateway
    return gateway


def fallback_repost(agent: dict, ctx: Context, rng, tick: int) -> WriteItem:
    """Deterministic fallback: repost the most-agreeing feed item (or a stub)."""
    feed = [p for p in ctx.pool if p.get("kind") != "system"]
    best, best_score = None, -2.0
    for p in feed:
        s = feed_mod.agreement(p, agent, ctx.issue_ids)
        if s > best_score:
            best, best_score = p, s
    if best is None:
        return WriteItem(agent_id=agent["id"], action="post",
                         text="Nothing here changes my view for now.", stance={}, emotion="neutral")
    return WriteItem(agent_id=agent["id"], action="post",
                     text=f"Reposting @{next((a['handle'] for a in ctx.agents if a['id'] == best['agent_id']), 'unknown')}: "
                          f"\"{best['text'][:200]}\"", stance=best.get("stance") or {}, emotion="neutral",
                     cited_chunk_ids=[])


def materialize_post(ctx: Context, tick: int, agent: dict, item: WriteItem,
                     spec: dict, rng) -> Optional[dict]:
    if not item.text:
        return None
    action = item.action if item.action in ("post", "reply") else "post"
    parent_id = None
    if action == "reply":
        parent_dict = spec.get("target")
        if parent_dict is None:
            action, item.action = "post", "post"
        else:
            parent_id = parent_dict["id"]
    stance = {}
    for iid in ctx.issue_ids:
        raw = (item.stance or {}).get(iid)
        if isinstance(raw, dict):
            v = raw.get("value", 0.0)
        elif isinstance(raw, (int, float)):
            v = float(raw)
        else:
            v = agent["stances"].get(iid, {}).get("value", 0.0)
        try:
            v = max(-1.0, min(1.0, float(v)))
        except (TypeError, ValueError):
            v = 0.0
        stance[iid] = {"value": round(v, 3),
                       "confidence": round(float(agent["stances"].get(iid, {}).get("confidence", 0.5)), 3)}
    cited = [c for c in (item.cited_chunk_ids or []) if c in ctx.chunk_ids][:4]
    seq = ctx.next_post_seq(tick)
    meta = spec.get("write_meta") or {}
    fallback_template = bool(spec.get("fallback_template"))
    configured = ctx.run.get("provider_json") or {}
    if isinstance(configured, str):
        configured = db.uj(configured, {}) or {}
    cfg_provider = configured.get("name")
    cfg_model = configured.get("model")
    via_fallback = 0
    if fallback_template:
        via_fallback = 1
    elif cfg_provider != "mock" and meta:
        if (meta.get("provider") and cfg_provider and meta["provider"] != cfg_provider) or \
           (meta.get("model") and cfg_model and meta["model"] != cfg_model):
            via_fallback = 1
    return {
        "id": content_pid(agent["id"], tick, seq, item.text[:600]), "run_id": ctx.run_id, "tick": tick, "agent_id": agent["id"],
        "kind": action if action == "reply" else ("repost" if spec.get("action") == "repost" else action),
        "parent_id": parent_id, "text": item.text[:600], "stance": stance,
        "emotion": (item.emotion or "neutral")[:20], "cited": cited,
        "likes": 0, "reposts": 0, "replies": 0,
        "is_fallback": 1 if spec.get("action") == "repost" else 0, "agent": agent,
        "seq": ctx.next_run_seq(),
        "model": "template" if fallback_template else (meta.get("model") or None),
        "provider": "deterministic" if fallback_template else (meta.get("provider") or None),
        "via_fallback": via_fallback,
    }


# ---------------------------------------------------------------------------
# Reflection
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Reflection
# ---------------------------------------------------------------------------

async def reflection(ctx: Context, tick: int) -> int:
    """Reflect the 3-5 most-changed agents since the last reflection."""
    deltas: list[tuple[float, dict]] = []
    for a in ctx.agents:
        before = ctx.reflection_snapshot.get(a["id"], {})
        d = sum(abs(a["stances"][iid]["value"] - before.get(iid, 0.0))
                for iid in ctx.issue_ids)
        deltas.append((d, a))
    deltas.sort(key=lambda t: -t[0])
    targets = [a for d, a in deltas[:5] if d > 0.05][:5]
    if not targets:
        return 0
    blocks = []
    for a in targets:
        st = ", ".join(f"{iid}={a['stances'][iid]['value']:+.1f}" for iid in ctx.issue_ids)
        blocks.append(f'agent_id must be exactly "{a["id"]}"\n'
                      f"recap: {a['belief_summary'][:200]}\ncurrent stances: {st}")
    messages = [
        {"role": "system",
         "content": "Rewrite each persona's belief summary (<= 60 words) to reflect their new stances and what happened around them. Be specific and in-voice.\n"
                    'Return ONLY a JSON array: [{"agent_id": str, "belief_summary": str}]'},
        {"role": "user", "content": "\n\n".join(blocks)},
    ]
    result = await _gateway().complete("reflect", messages, expect=ReflectItem,
                                       run_id=ctx.run_id, max_items=5)
    for item in (result.parsed if isinstance(result.parsed, list) else [result.parsed]):
        if isinstance(item, ReflectItem):
            agent = next((a for a in ctx.agents if a["id"] == item.agent_id), None)
            if agent is not None:
                agent["belief_summary"] = item.belief_summary[:400]
    ctx.reflection_snapshot = {
        a["id"]: {iid: st["value"] for iid, st in a["stances"].items()} for a in ctx.agents}
    return 1


# ---------------------------------------------------------------------------
# Commit
# ---------------------------------------------------------------------------

def commit_tick(ctx: Context, tick: int, new_posts: list[dict]) -> None:
    with db.tx() as conn:
        max_seq = conn.execute(
            "SELECT COALESCE(MAX(seq),0) s FROM posts WHERE run_id=?", (ctx.run_id,)
        ).fetchone()["s"] or 0
        for p in new_posts:
            if p.get("seq") is None:
                max_seq += 1
                p["seq"] = max_seq
            else:
                max_seq = max(max_seq, int(p["seq"]))
            conn.execute(
                "INSERT OR REPLACE INTO posts(id, run_id, tick, agent_id, kind, parent_id, text,"
                " stance_json, emotion, cited_chunk_ids_json, likes, reposts, replies, is_fallback,"
                " seq, model, provider, via_fallback)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (p["id"], ctx.run_id, tick, p["agent_id"], p["kind"], p["parent_id"],
                 p["text"], db.j(p["stance"]), p["emotion"], db.j(p["cited"]),
                 0, 0, 0, p.get("is_fallback", 0), p["seq"], p.get("model"),
                 p.get("provider"), p.get("via_fallback", 0)))
            if p.get("agent") is not None:
                # keep agent handle on the runtime object
                p.setdefault("handle", p["agent"]["handle"])
        for post_id, delta in ctx.post_deltas.items():
            conn.execute(
                "UPDATE posts SET likes=likes+?, reposts=reposts+?, replies=replies+? WHERE id=?",
                (delta["likes"], delta["reposts"], delta["replies"], post_id))
        ctx.post_deltas.clear()
        # reactions log
        # edges (skip self-relationships: an agent reacting to its own post is not a relationship)
        for e in ctx.edges.values():
            if e["src"] == e["dst"]:
                continue
            conn.execute(
                "INSERT OR REPLACE INTO edges(run_id, src, dst, follows, weight, interactions,"
                " last_tick) VALUES(?,?,?,?,?,?,?)",
                (ctx.run_id, e["src"], e["dst"], int(e["follows"]), round(float(e["weight"]), 4),
                 int(e.get("interactions", 0)), tick))
        # metrics + stance history
        conn.execute("INSERT OR REPLACE INTO metrics(run_id, tick, metrics_json) VALUES(?,?,?)",
                     (ctx.run_id, tick, db.j(ctx.last_metrics)))
        for a in ctx.agents:
            for iid, st in a["stances"].items():
                conn.execute(
                    "INSERT INTO stance_history(run_id, tick, agent_id, issue_id, value, confidence)"
                    " VALUES(?,?,?,?,?,?)",
                    (ctx.run_id, tick, a["id"], iid, st["value"], st.get("confidence", 0.5)))
        # agents + memories
        for a in ctx.agents:
            conn.execute(
                "UPDATE agents SET stances_json=?, state_json=?, knowledge_json=?,"
                " belief_summary=?, source_chunk_ids_json=? WHERE id=? AND run_id=?",
                (db.j(a["stances"]), db.j(a["state"]), db.j(a["knowledge"]),
                 a["belief_summary"][:400], db.j(a["knowledge"]), a["id"], ctx.run_id))
        conn.execute("DELETE FROM memories WHERE run_id=?", (ctx.run_id,))
        for a in ctx.agents:
            for m in a.get("memories", [])[-50:]:
                conn.execute(
                    "INSERT INTO memories(run_id, agent_id, tick, kind, text, importance, refs_json)"
                    " VALUES(?,?,?,?,?,?,?)",
                    (ctx.run_id, a["id"], m["tick"], m["kind"], m["text"],
                     m["importance"], db.j(m.get("refs", []))))
        conn.execute(
            "UPDATE runs SET last_completed_tick=?, rng_state=?, updated_at=? WHERE id=?",
            (tick, db.j({"tick": tick}), _now(), ctx.run_id))
    # trim pool
    cutoff = tick - 4
    ctx.pool = [p for p in (ctx.pool + new_posts) if p["tick"] >= cutoff]
    # runtime stance series emit for SSE (cheap snapshot)
    emit(ctx.run_id, "stance_tick", {"tick": tick, "metrics": ctx.last_metrics.get("by_issue", {})})
