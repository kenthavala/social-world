"""Safety/integrity: ordering, replayable SSE, redaction, budget reservation, seeding stop."""
from __future__ import annotations

import asyncio
import io
import logging

import pytest

from app import db


def _cfg(run_id: str, **over) -> dict:
    cfg = db.uj(db.scalar("SELECT config_json FROM runs WHERE id=?", (run_id,)), {}) or {}
    cfg.update(over)
    db.execute("UPDATE runs SET config_json=? WHERE id=?", (db.j(cfg), run_id))
    return cfg


@pytest.mark.asyncio
async def test_post_seq_is_monotonic_and_unique(brief_run):
    run_id, _ = brief_run
    _cfg(run_id, writes_per_tick=3, ticks=2)
    from app.llm.gateway import gateway
    from app.sim import engine
    await engine.seed_run(run_id, gateway)
    ctx = await engine.load_context(run_id)
    await engine.do_tick(ctx, 1)
    ctx = await engine.load_context(run_id)  # simulate a reload between rounds
    await engine.do_tick(ctx, 2)
    rows = db.query("SELECT id, seq FROM posts WHERE run_id=? ORDER BY seq", (run_id,))
    assert rows
    seqs = [r["seq"] for r in rows]
    assert seqs == list(range(1, len(seqs) + 1))
    assert len({r["id"] for r in rows}) == len(rows)


@pytest.mark.asyncio
async def test_twenty_context_reloads_never_duplicate_posts(brief_run):
    """The tick commit is atomic; a fresh context per round must not re-insert rows."""
    run_id, _ = brief_run
    _cfg(run_id, writes_per_tick=2, ticks=20)
    from app.llm.gateway import gateway
    from app.sim import engine
    await engine.seed_run(run_id, gateway)
    for tick in range(1, 21):
        ctx = await engine.load_context(run_id)  # process "restarted" before each round
        ctx.last_completed = tick - 1
        await engine.do_tick(ctx, tick)
        db.execute("UPDATE runs SET last_completed_tick=? WHERE id=?", (tick, run_id))
    rows = db.query("SELECT id, tick, agent_id, seq FROM posts WHERE run_id=?", (run_id,))
    assert len(rows) == len({r["id"] for r in rows})
    assert len(rows) == len({r["seq"] for r in rows})
    assert len(rows) == len({(r["tick"], r["agent_id"]) for r in rows})


@pytest.mark.asyncio
async def test_sse_ids_and_last_event_replay(brief_run):
    run_id, _ = brief_run
    from app.api import stream
    stream.emit(run_id, "tick_started", {"tick": 1})
    first = db.query_one("SELECT id FROM stream_events WHERE run_id=? ORDER BY id", (run_id,))
    stream.emit(run_id, "tick_completed", {"tick": 1})
    gen = stream._generator(run_id, str(first["id"]))
    opened = await gen.__anext__()
    assert opened["event"] == "open"
    replayed = await gen.__anext__()
    assert replayed["event"] == "tick_completed"
    assert int(replayed["id"]) > first["id"]
    await gen.aclose()
    stream._subscribers.get(run_id, set()).clear()


def test_redaction_filter_masks_keys_in_logs():
    from app.logsafe import RedactFilter, scrub
    assert "SECRET" not in scrub("Authorization: Bearer nvapi-SECRETVALUE")
    assert "SECRET" not in scrub("api_key=sk-SECRETVALUE12345")
    buf = io.StringIO()
    h = logging.StreamHandler(buf)
    h.addFilter(RedactFilter())
    log = logging.getLogger("test.redaction")
    log.propagate = False
    log.addHandler(h)
    log.warning("using key sk-SECRETVALUE12345 and Authorization: Bearer nvapi-SECRETVALUE")
    h.flush()
    out = buf.getvalue()
    assert "SECRETVALUE" not in out
    assert "[REDACTED]" in out
    log.removeHandler(h)


@pytest.mark.asyncio
async def test_budget_reservation_is_atomic(brief_run):
    run_id, _ = brief_run
    _cfg(run_id, max_llm_calls=1)
    db.execute("UPDATE runs SET llm_calls_used=0, llm_reserved=0 WHERE id=?", (run_id,))
    from app.errors import BudgetExhausted
    from app.llm.gateway import _release_budget, _reserve_budget
    _reserve_budget(run_id)
    with pytest.raises(BudgetExhausted):
        _reserve_budget(run_id)
    _release_budget(run_id)
    _reserve_budget(run_id)  # the slot is free again
    _release_budget(run_id)


@pytest.mark.asyncio
async def test_stop_during_seeding_is_not_overwritten(brief_run):
    run_id, _ = brief_run
    from app.llm.gateway import LLMResult
    from app.sim import engine

    class SlowGateway:
        def __init__(self):
            self.entered = asyncio.Event()
            self.release = asyncio.Event()

        async def complete(self, task, messages, **kw):
            self.entered.set()
            await self.release.wait()
            return LLMResult(text="", parsed=[], model="mock", provider="mock", task=task)

    g = SlowGateway()
    task = asyncio.create_task(engine.seed_run(run_id, g))
    await asyncio.wait_for(g.entered.wait(), timeout=5)
    assert db.scalar("SELECT status FROM runs WHERE id=?", (run_id,)) == "seeding"
    engine.request_stop(run_id)
    g.release.set()
    await asyncio.wait_for(task, timeout=10)
    assert db.scalar("SELECT status FROM runs WHERE id=?", (run_id,)) == "interrupted"
    assert (db.scalar("SELECT COUNT(*) FROM agents WHERE run_id=?", (run_id,)) or 0) > 0


def test_migration_v4_backfills_sequence(tmp_path, monkeypatch):
    import sqlite3
    path = tmp_path / "v3.db"
    con = sqlite3.connect(path)
    con.executescript(db.SCHEMA)
    con.execute("INSERT INTO schema_version(version) VALUES(3)")
    con.execute("INSERT INTO runs(id,name,status,created_at,updated_at) VALUES('r1','x','draft','','')")
    con.execute(
        "INSERT INTO posts(id,run_id,tick,agent_id,kind,text,seq) VALUES"
        "('p1','r1',1,'a','post','one',NULL),('p2','r1',1,'b','post','two',NULL)")
    con.commit()
    con.close()
    monkeypatch.setattr(db, "DB_PATH", path)
    db.reset()
    try:
        db.connect()
        seqs = [r["seq"] for r in db.query("SELECT seq FROM posts ORDER BY seq")]
        assert seqs == [1, 2]
        v = db.scalar("SELECT MAX(version) FROM schema_version")
        assert v >= 4
    finally:
        db.reset()
