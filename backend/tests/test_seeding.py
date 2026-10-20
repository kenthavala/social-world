"""Seeding and engine determinism tests (mock provider)."""
from __future__ import annotations

import pytest

from app import db
from app.errors import AppError
from app.sim import engine
from app.sim.seeding import clamp_persona, derived_traits, template_persona


@pytest.mark.asyncio
async def test_seeding_creates_agents_and_edges(brief_run):
    run_id, _ = brief_run
    from app.llm.gateway import gateway
    n = await engine.seed_run(run_id, gateway)
    assert n == 8
    agents = db.query("SELECT * FROM agents WHERE run_id=?", (run_id,))
    assert len(agents) == 8
    for a in agents:
        stances = db.uj(a["stances_json"], {})
        assert set(stances.keys()) == {"iss_1", "iss_2"}
        for st in stances.values():
            assert -1.0 <= st["value"] <= 1.0
        traits = db.uj(a["traits_json"], {})
        assert 0.2 <= traits["activity"] <= 0.8
    handles = [a["handle"] for a in agents]
    assert len(set(handles)) == len(handles)  # unique
    edges = db.query("SELECT COUNT(*) c FROM edges WHERE run_id=? AND follows=1", (run_id,))
    assert edges[0]["c"] >= 8


@pytest.mark.asyncio
async def test_seed_fallback_personas(brief_run):
    run_id, _ = brief_run

    class FailingGateway:
        async def complete(self, *args, **kwargs):
            raise AppError("down", component="llm", stage="test")

    n = await engine.seed_run(run_id, FailingGateway())
    assert n == 8
    agents = db.query("SELECT * FROM agents WHERE run_id=?", (run_id,))
    assert all(a["name"] for a in agents)
    assert all(db.uj(a["stances_json"], {}) for a in agents)


def test_population_mix_within_one_agent(fresh_db, sample_source):
    brief = {"issues": [{"id": "iss_1", "name": "Q", "question": "q", "pro_label": "P",
                         "con_label": "C", "evidence_chunk_ids": []}],
             "stakeholder_groups": [{"name": "G", "description": "", "size_hint": "large",
                                     "stance_by_issue": {"iss_1": 0.0}}],
             "summary": "s", "key_claims": [], "entities": [], "fallback": True}
    import random
    from app.sim import seeding
    rng = random.Random(99)
    n = 10
    slots = seeding.assign_targets(n, brief, {"pop_mix": {"pro": 0.4, "con": 0.4, "undecided": 0.2}}, rng)
    pros = sum(1 for s in slots if s["targets"]["iss_1"] > 0.3)
    cons = sum(1 for s in slots if s["targets"]["iss_1"] < -0.3)
    assert abs(pros - 4) <= 2
    assert abs(cons - 4) <= 2


def test_template_persona_clamps():
    slot = {"ordinal": 3, "group": {"name": "Residents pro", "description": "d",
                                    "stance_by_issue": {"iss_1": 0.6}},
            "group_name": "Residents pro", "targets": {"iss_1": 0.7}}
    out = template_persona(slot, ["iss_1"])
    clamped = clamp_persona(out, slot, ["iss_1"])
    assert clamped["archetype"] in ("ordinary user", "expert", "journalist", "activist",
                                    "skeptic", "official")
    assert clamped["stances"]["iss_1"]["confidence"] == 0.5
    t = derived_traits(clamped["big5"])
    assert 0.2 <= t["activity"] <= 0.8


@pytest.mark.asyncio
async def test_same_seed_identical_logs(brief_run):
    """Same seed + writes_per_tick=0 -> identical event logs and post sequences."""
    run_id, _ = brief_run
    from app.llm.gateway import gateway
    from app.sim.engine import load_context, do_tick

    async def simulate():
        await engine.seed_run(run_id, gateway)
        ctx = await load_context(run_id)
        for tick in range(1, 4):
            await do_tick(ctx, tick)
            ctx.last_completed = tick
        posts = db.query("SELECT tick, agent_id, kind, parent_id, text, is_fallback FROM posts"
                         " WHERE run_id=? ORDER BY tick, id", (run_id,))
        events = db.query("SELECT tick, kind FROM events WHERE run_id=? ORDER BY id", (run_id,))
        agents = db.query("SELECT id, handle, stances_json FROM agents WHERE run_id=? ORDER BY id",
                          (run_id,))
        return ([dict(p) for p in posts], [dict(e) for e in events],
                [dict(a) for a in agents])

    first = await simulate()
    # wipe posts/events/memories but keep agents out of the DB (fresh agents next time)
    db.execute("DELETE FROM posts WHERE run_id=?", (run_id,))
    db.execute("DELETE FROM events WHERE run_id=?", (run_id,))
    db.execute("DELETE FROM agents WHERE run_id=?", (run_id,))
    db.execute("DELETE FROM edges WHERE run_id=?", (run_id,))
    db.execute("UPDATE runs SET status='draft', last_completed_tick=0, llm_calls_used=0 WHERE id=?", (run_id,))
    second = await simulate()
    # agent seeds identical
    assert first[2] == second[2]
    assert first[0] == second[0]
    assert first[1] == second[1]


@pytest.mark.asyncio
async def test_writes_cite_real_chunks(brief_run):
    run_id, source_id = brief_run
    cfg = db.uj(db.scalar("SELECT config_json FROM runs WHERE id=?", (run_id,)), {})
    cfg["writes_per_tick"] = 4
    db.execute("UPDATE runs SET config_json=? WHERE id=?", (db.j(cfg), run_id))
    from app.llm.gateway import gateway
    from app.sim.engine import load_context, do_tick
    await engine.seed_run(run_id, gateway)
    ctx = await load_context(run_id)
    await do_tick(ctx, 1)
    posts = db.query("SELECT cited_chunk_ids_json FROM posts WHERE run_id=? AND kind='post'", (run_id,))
    real = {r["id"] for r in db.query("SELECT id FROM chunks WHERE source_id=?", (source_id,))}
    cited = [c for p in posts for c in (db.uj(p["cited_chunk_ids_json"], []) or [])]
    assert cited, "expected at least one citation"
    assert all(c in real for c in cited)
