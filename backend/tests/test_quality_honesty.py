"""Quality honesty: a mock-provider run must not look like a high-quality real run."""
from __future__ import annotations

import asyncio

import pytest

from app import db
from app.analytics.realism import compute_realism
from app.analytics.report import generate_report
from app.sim import engine


def _seed_and_run(run_id: str) -> None:
    async def _go() -> None:
        from app.llm.gateway import gateway
        await engine.seed_run(run_id, gateway)
        ctx = await engine.load_context(run_id)
        await engine.do_tick(ctx, 1)
    asyncio.run(_go())
    db.execute("UPDATE runs SET status='completed', current_tick=1, last_completed_tick=1"
               " WHERE id=?", (run_id,))


def test_mock_run_headline_is_capped_and_flagged(brief_run):
    run_id, _ = brief_run
    _seed_and_run(run_id)
    q = compute_realism(run_id)
    assert q["overall"]["mock_provider"] is True
    assert q["overall"]["provider"] == "mock"
    assert q["overall"]["score"] <= 25
    assert q["overall"]["score_capped"] is True
    assert q["overall"]["cap"] == 25
    assert "mock provider" in q["overall"]["label"].lower()
    assert "capped at 25/100" in q["overall"]["note"]
    assert "not model output" in q["summary"]["headline"]
    # Dimension scores still describe the recorded configuration.
    assert any(d["score"] is not None for d in q["dimensions"])


def test_mock_run_report_states_the_cap(brief_run):
    run_id, _ = brief_run
    _seed_and_run(run_id)
    rep = generate_report(run_id)
    md = rep["report_md"]
    assert "Mock-provider run" in md
    assert "capped at 25/100" in md
    assert "Strong configuration" not in md
    assert f"{compute_realism(run_id)['overall']['score']}/100" in md


def test_non_mock_run_is_not_capped(brief_run):
    run_id, _ = brief_run
    db.execute("UPDATE runs SET provider_json=? WHERE id=?",
               (db.j({"name": "custom", "model": "m-1"}), run_id))
    _seed_and_run(run_id)
    q = compute_realism(run_id)
    assert q["overall"]["mock_provider"] is False
    assert q["overall"]["score_capped"] is False
    assert q["overall"]["cap"] is None
    assert q["overall"]["note"] is None


def test_replication_stability_is_counted_from_comparable_runs(brief_run):
    run_id, source_id = brief_run
    _seed_and_run(run_id)
    base_cfg = db.uj(db.scalar("SELECT config_json FROM runs WHERE id=?", (run_id,)), {})
    peer_cfg = dict(base_cfg, seed=987654)
    db.execute(
        "INSERT INTO runs(id, name, source_id, scenario_json, config_json, provider_json, seed,"
        " status, current_tick, last_completed_tick, rng_state, llm_calls_used, created_at,"
        " updated_at, error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("run_peer", "peer", source_id, db.j({"question": "q", "events": []}),
         db.j(peer_cfg), db.j({}), 987654, "draft", 0, 0, None, 0, "", "", None))
    _seed_and_run("run_peer")

    q = compute_realism(run_id)
    dim = next(d for d in q["dimensions"] if d["id"] == "replication_stability")
    assert dim["status"] == "assessed"
    assert dim["score"] is not None and 0 <= dim["score"] <= 100
    assert set(dim["evidence"]["runs"]) == {run_id, "run_peer"}
    assert len(set(dim["evidence"]["seeds"])) == 2
    assert dim["evidence"]["rounds"] == 1
    assert "repeatability" in dim["explanation"]

    mech = {m["id"]: m for m in q["mechanisms"]}
    assert mech["replication_stability"]["score"] == dim["score"]
    assert mech["replication_stability"]["status"] == "assessed"
    assert "100 x (1 - mean spread / 2)" in mech["replication_stability"]["calculation"]


def test_replication_stability_not_assessed_without_a_peer(brief_run):
    run_id, _ = brief_run
    _seed_and_run(run_id)
    q = compute_realism(run_id)
    dim = next(d for d in q["dimensions"] if d["id"] == "replication_stability")
    assert dim["status"] == "not_assessed"
    assert dim["score"] is None
    mech = {m["id"]: m for m in q["mechanisms"]}
    assert mech["replication_stability"]["status"] == "not_assessed"
    assert mech["stance_inertia"]["status"] == "active"
    assert "0.5" in mech["stance_inertia"]["calculation"]
