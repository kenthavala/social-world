"""Additive-migration tests: an existing M1 database must keep opening."""
from __future__ import annotations

import sqlite3

import pytest

from app import db as db_mod
import app.db as dbm


M1_RUNS = (
    "CREATE TABLE runs("
    " id TEXT PRIMARY KEY, name TEXT, source_id TEXT, scenario_json TEXT, config_json TEXT,"
    " provider_json TEXT, seed INTEGER, status TEXT, current_tick INTEGER,"
    " last_completed_tick INTEGER, rng_state TEXT, llm_calls_used INTEGER DEFAULT 0,"
    " created_at TEXT, updated_at TEXT, error_json TEXT)"
)


@pytest.fixture()
def m1_db(tmp_path, monkeypatch):
    """A DB file in the pre-v2 shape: runs without started_at/finished_at, version 1."""
    path = tmp_path / "m1_old.db"
    con = sqlite3.connect(path)
    con.execute(M1_RUNS)
    con.execute("CREATE TABLE schema_version(version INTEGER)")
    con.execute("INSERT INTO schema_version(version) VALUES(1)")
    con.commit()
    con.close()
    dbm.reset()
    monkeypatch.setattr(dbm, "DB_PATH", path)
    yield path
    dbm.reset()


def test_migration_v2_adds_time_columns(m1_db):
    dbm.connect()
    cols = {r["name"] for r in dbm.query("PRAGMA table_info(runs)")}
    assert {"started_at", "finished_at"} <= cols
    # a v1 file migrates through EVERY additive step (v2 time columns, v3 essay)
    assert (dbm.query_one("SELECT MAX(version) v FROM schema_version") or {"v": 0})["v"] >= 2
    rep_cols = {r["name"] for r in dbm.query("PRAGMA table_info(reports)")}
    assert {"essay_json", "essay_meta_json"} <= rep_cols


def test_migration_v3_adds_essay_columns(tmp_path, monkeypatch):
    """A v2 database (no essay columns) migrates to v3 without losing anything."""
    path = tmp_path / "v2_old.db"
    con = sqlite3.connect(path)
    con.executescript(dbm.SCHEMA)   # full fresh schema at v2
    con.execute("INSERT INTO schema_version(version) VALUES(2)")
    con.commit()
    con.close()
    monkeypatch.setattr(dbm, "DB_PATH", path)
    dbm.reset()
    try:
        dbm.connect()
        cols = {r["name"] for r in dbm.query("PRAGMA table_info(reports)")}
        assert {"essay_json", "essay_meta_json"} <= cols
    finally:
        dbm.reset()


def test_migration_preserves_rows(m1_db):
    con = sqlite3.connect(m1_db)
    con.execute(
        "INSERT INTO runs(id, name, source_id, scenario_json, config_json, provider_json,"
        " seed, status, current_tick, last_completed_tick, rng_state, llm_calls_used,"
        " created_at, updated_at, error_json)"
        " VALUES('run_old', 'Legacy', NULL, '{}', '{}', '{}', 1, 'interrupted', 0, 0,"
        " NULL, 0, '2026-01-01T00:00:00', '2026-01-01T00:00:00', NULL)")
    con.commit()
    con.close()
    dbm.connect()
    row = dbm.query_one("SELECT id, name, started_at, finished_at FROM runs WHERE id='run_old'")
    assert row["name"] == "Legacy"
    assert row["started_at"] is None and row["finished_at"] is None


@pytest.mark.asyncio
async def test_engine_records_started_and_finished(brief_run):
    """A real (mock-provider) run writes honest started_at / finished_at."""
    run_id, _ = brief_run
    from app.llm.gateway import gateway
    from app.sim import engine
    await engine.seed_run(run_id, gateway)
    await engine.start_run(run_id)
    await engine._tasks[run_id]
    row = db_mod.query_one("SELECT status, started_at, finished_at FROM runs WHERE id=?", (run_id,))
    assert row["status"] == "completed"
    assert row["started_at"] is not None
    assert row["finished_at"] is not None
    assert row["finished_at"] >= row["started_at"]


@pytest.mark.asyncio
async def test_no_self_edges_persisted(brief_run):
    """An agent reacting to its own post must never create a self-relationship edge."""
    run_id, _ = brief_run
    from app.llm.gateway import gateway
    from app.sim import engine
    row = db_mod.query_one("SELECT config_json FROM runs WHERE id=?", (run_id,))
    cfg = db_mod.uj(row["config_json"], {})
    cfg["writes_per_tick"] = 3  # generate posts so likes/replies (and self-reactions) occur
    db_mod.execute("UPDATE runs SET config_json=? WHERE id=?", (db_mod.j(cfg), run_id))
    await engine.seed_run(run_id, gateway)
    await engine.start_run(run_id)
    await engine._tasks[run_id]
    n_self = db_mod.scalar("SELECT COUNT(*) FROM edges WHERE run_id=? AND src=dst", (run_id,)) or 0
    n_all = db_mod.scalar("SELECT COUNT(*) FROM edges WHERE run_id=?", (run_id,)) or 0
    assert n_all > 0  # the run actually recorded relationships
    assert n_self == 0


# ---
# Phase 6: persistent scheduled events + audience-targeted briefings


def test_inject_persists_scheduled_event(brief_run):
    """An injected event is stored server-side and lands in the queue."""
    run_id, _ = brief_run
    from app.sim import engine
    ev = engine.inject_event(run_id, "Polls show support dropping.", tick=2)
    assert ev["tick"] == 2 and ev["audience"] == "all"
    row = db_mod.query_one(
        "SELECT * FROM events WHERE run_id=? AND kind='scheduled' ORDER BY id DESC LIMIT 1",
        (run_id,))
    assert row is not None
    p = db_mod.uj(row["payload_json"], {})
    assert p["status"] == "scheduled" and p["text"] == "Polls show support dropping."


def test_rehydrate_survives_forget(brief_run):
    """A persisted schedule re-enters the in-memory queue after the process 'restarts'."""
    run_id, _ = brief_run
    from app.sim import engine
    ev = engine.inject_event(run_id, "Leaked memo.", tick=3)
    engine._injected[run_id] = []  # simulate a restart losing the in-memory queue
    engine._rehydrate_scheduled(run_id)
    qs = engine._injected[run_id]
    assert any(q.get("sid") == ev["sid"] and q["tick"] == 3 for q in qs)


@pytest.mark.asyncio
async def test_public_event_broadcasts_private_event_briefs_group(brief_run):
    """Public events hit the newsroom; group briefings are remembered only by that group."""
    run_id, _ = brief_run
    from app.llm.gateway import gateway
    from app.sim import engine
    await engine.seed_run(run_id, gateway)
    agents = db_mod.query("SELECT id, stakeholder_group g FROM agents WHERE run_id=?"
                          " ORDER BY id", (run_id,))
    group = agents[0]["g"]
    engine.inject_event(run_id, "Debate tonight at eight.", tick=1)  # public
    engine.inject_event(run_id, "Quiet: the meeting is moved.", tick=1, audience=group)
    await engine.start_run(run_id)
    await engine._tasks[run_id]
    row = db_mod.query_one("SELECT status FROM runs WHERE id=?", (run_id,))
    assert row["status"] == "completed"
    sys_posts = [r["text"] for r in db_mod.query(
        "SELECT text FROM posts WHERE run_id=? AND agent_id='newsroom'", (run_id,))]
    assert any("Debate tonight at eight." in t for t in sys_posts)
    assert not any("the meeting is moved" in t for t in sys_posts)  # no public leak
    members = [r["id"] for r in agents if r["g"] == group]
    others = [r["id"] for r in agents if r["g"] != group]
    assert len(others) > 0
    for aid in members:
        assert any("meeting is moved" in t for t in _agent_memories_text(aid))
    for aid in others:
        assert all("meeting is moved" not in t for t in _agent_memories_text(aid))
    sched = db_mod.query_one(
        "SELECT payload_json FROM events WHERE run_id=? AND kind='scheduled'"
        " AND payload_json LIKE '%the meeting is moved%'", (run_id,))
    p = db_mod.uj(sched["payload_json"], {})
    assert p["status"] == "fired" and p["audience"] == group


def _agent_memories_text(agent_id: str) -> list[str]:
    """Agent memories are persisted into the memories table each tick (see engine._persist)."""
    rows = db_mod.query("SELECT text FROM memories WHERE agent_id=?", (agent_id,))
    return [r["text"] for r in rows]


# ---
# Phase 7: deterministic, auto-generated reports


@pytest.mark.asyncio
async def test_report_is_deterministic_and_counted(brief_run):
    run_id, _ = brief_run
    from app.analytics.report import generate_report
    from app.llm.gateway import gateway
    from app.sim import engine
    cfg_row = db_mod.query_one("SELECT config_json FROM runs WHERE id=?", (run_id,))
    cfg = db_mod.uj(cfg_row["config_json"], {})
    cfg["writes_per_tick"] = 3
    db_mod.execute("UPDATE runs SET config_json=? WHERE id=?", (db_mod.j(cfg), run_id))
    await engine.seed_run(run_id, gateway)
    await engine.start_run(run_id)
    await engine._tasks[run_id]
    row = db_mod.query_one("SELECT * FROM reports WHERE run_id=?", (run_id,))
    assert row is not None  # auto-generated on completion
    md = row["report_md"]
    assert "recorded database rows" in md
    assert "No AI wrote it" in md
    a = db_mod.uj(row["analytics_json"], {})
    assert a["posts"] == (db_mod.scalar(
        "SELECT COUNT(*) FROM posts WHERE run_id=?", (run_id,)) or 0)
    assert a["llm_calls"] == (db_mod.scalar(
        "SELECT COUNT(*) FROM llm_calls WHERE run_id=?", (run_id,)) or 0)
    # Phase 13: deeper deterministic analytics in the report
    rj = db_mod.uj(row["report_json"], {})
    assert all(k in rj for k in ("turning_points", "clusters", "source_usage", "narratives"))
    assert a["clusters"] == len(rj["clusters"]) >= 1   # seeded agents are one+ community
    assert rj["clusters"][0]["handles"]                 # clusters name real agent handles
    for tp in rj["turning_points"]:
        assert {"issue_id", "tick", "from", "to", "delta"} <= set(tp)
    assert "Biggest opinion shifts" in md or len(rj["turning_points"]) == 0
    assert "Conversation clusters" in md
    # Phase 15: TF-IDF narratives per community
    assert "What each cluster talked about" in md
    assert rj["narratives"] and rj["narratives"][0]["terms"]
    assert all(set(("cluster_index", "size", "handles", "terms", "top_post")) <= set(nv)
               for nv in rj["narratives"])
    # regenerate must produce identical counts (deterministic)
    again = generate_report(run_id)
    assert again["analytics"]["posts"] == a["posts"]
