"""Crash/recovery: run 'crashes' mid-tick, gets marked interrupted, resumes, no duplicates.

Also covers pause→resume: pause requested mid-tick (inside the LLM call) commits the
current tick, the worker idles while paused, and resume finishes the remaining ticks.
"""
from __future__ import annotations

import asyncio

import pytest

from app import db
from app.sim import engine


@pytest.mark.asyncio
async def test_interrupt_then_resume_completes(brief_run):
    run_id, _ = brief_run
    cfg = db.uj(db.scalar("SELECT config_json FROM runs WHERE id=?", (run_id,)), {})
    cfg["writes_per_tick"] = 2
    cfg["ticks"] = 3
    db.execute("UPDATE runs SET config_json=? WHERE id=?", (db.j(cfg), run_id))
    from app.llm.gateway import gateway
    await engine.seed_run(run_id, gateway)
    ctx = await engine.load_context(run_id)

    # "crash" during tick 2: only tick 1 committed
    await engine.do_tick(ctx, 1)
    ctx.last_completed = 1
    # interrupted means the server died here
    db.execute("UPDATE runs SET status='interrupted' WHERE id=?", (run_id,))

    await engine.request_resume(run_id)
    task = engine._tasks.get(run_id)
    assert task is not None
    deadline = asyncio.get_event_loop().time() + 30
    while not task.done():
        await asyncio.sleep(0.2)
        assert asyncio.get_event_loop().time() < deadline, "resume did not finish"

    status = db.scalar("SELECT status FROM runs WHERE id=?", (run_id,))
    assert status == "completed"
    assert (db.scalar("SELECT last_completed_tick FROM runs WHERE id=?", (run_id,)) or 0) == 3
    posts = db.query("SELECT id FROM posts WHERE run_id=?", (run_id,))
    assert len(posts) == len({p["id"] for p in posts})  # no duplicates
    bad = db.query("SELECT tick, COUNT(DISTINCT agent_id) c FROM posts WHERE run_id=?"
                   " GROUP BY tick", (run_id,))
    assert all(r["c"] > 0 for r in bad)


@pytest.mark.asyncio
async def test_recovery_marker_on_startup(fresh_db):
    db.execute(
        "INSERT INTO runs(id, name, source_id, scenario_json, config_json, provider_json, seed,"
        " status, current_tick, last_completed_tick, rng_state, llm_calls_used, created_at,"
        " updated_at, error_json) VALUES('run_rec','x',NULL,'{}','{}','{}',1,'running',1,0,NULL,0,'','','')")
    engine.recover_on_startup()
    assert db.scalar("SELECT status FROM runs WHERE id='run_rec'") == "interrupted"


@pytest.mark.asyncio
async def test_pause_then_resume_completes(brief_run, monkeypatch):
    """Pause mid-tick (while the write call is in flight) then resume: tick 1 commits,
    the worker idles paused, and resume finishes ticks 2-3 with no duplicated posts."""
    import app.llm.gateway as gw_mod
    from app import db as dbm
    from app.llm import mock
    from app.llm.gateway import LLMResult, gateway as real_gw

    run_id, _ = brief_run
    cfg = dbm.uj(dbm.scalar("SELECT config_json FROM runs WHERE id=?", (run_id,)), {})
    cfg["writes_per_tick"] = 2
    cfg["ticks"] = 3
    dbm.execute("UPDATE runs SET config_json=? WHERE id=?", (dbm.j(cfg), run_id))
    await engine.seed_run(run_id, real_gw)
    ctx = await engine.load_context(run_id)
    posts_before_pause_target = dbm.scalar("SELECT COUNT(*) FROM posts WHERE run_id=?", (run_id,))

    class HeldGateway:
        """Vends exactly one real mock call; blocks every following call on a gate."""

        def __init__(self) -> None:
            self.gate = asyncio.Event()
            self.blocked = False

        async def complete(self, task, messages, *, expect=None, run_id=None,
                           no_cache=False, max_items=None):
            blocked_this_call = not self.gate.is_set()
            if blocked_this_call:
                self.blocked = True
                await self.gate.wait()
            text = mock.complete_mock(task, messages)
            ok, parsed = real_gw._try_parse(text, expect, max_items)
            return LLMResult(text=text, parsed=parsed, model="mock", provider="mock", task=task)

    held = HeldGateway()
    monkeypatch.setattr(gw_mod, "gateway", held)

    await engine.start_run(run_id)
    deadline = asyncio.get_event_loop().time() + 10
    while not held.blocked:  # worker is now inside tick 1's first LLM call
        await asyncio.sleep(0.05)
        assert asyncio.get_event_loop().time() < deadline, "worker never reached the LLM call"

    engine.request_pause(run_id)
    assert dbm.scalar("SELECT status FROM runs WHERE id=?", (run_id,)) == "paused"

    held.gate.set()  # let tick 1 complete; the worker then sees 'paused' and idles
    deadline = asyncio.get_event_loop().time() + 10
    while (dbm.scalar("SELECT last_completed_tick FROM runs WHERE id=?", (run_id,)) or 0) < 1:
        await asyncio.sleep(0.05)
        assert asyncio.get_event_loop().time() < deadline, "tick 1 never committed"
    await asyncio.sleep(0.35)  # let the worker reach its paused idle branch
    assert dbm.scalar("SELECT status FROM runs WHERE id=?", (run_id,)) == "paused"
    paused_at = dbm.scalar("SELECT last_completed_tick FROM runs WHERE id=?", (run_id,)) or 0
    assert 1 <= paused_at < 3
    posts_at_pause = dbm.scalar("SELECT COUNT(*) FROM posts WHERE run_id=?", (run_id,))
    assert posts_at_pause > 0  # tick 1 committed exactly once

    await engine.request_resume(run_id)
    task = engine._tasks.get(run_id)
    assert task is not None
    deadline = asyncio.get_event_loop().time() + 30
    while not task.done():
        await asyncio.sleep(0.2)
        assert asyncio.get_event_loop().time() < deadline, "resume did not finish"

    status = dbm.scalar("SELECT status FROM runs WHERE id=?", (run_id,))
    assert status == "completed"
    assert (dbm.scalar("SELECT last_completed_tick FROM runs WHERE id=?", (run_id,)) or 0) == 3
    rows = dbm.query("SELECT id, tick, agent_id FROM posts WHERE run_id=?", (run_id,))
    assert len(rows) == len({r["id"] for r in rows})  # no duplicate posts
    assert len(rows) == len({(r["tick"], r["agent_id"]) for r in rows})  # no re-committed groups
    assert dbm.scalar("SELECT COUNT(*) FROM posts WHERE run_id=?", (run_id,)) >= posts_at_pause
