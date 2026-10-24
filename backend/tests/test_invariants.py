"""Data-integrity invariants.

These tests assert properties that must hold for every run, at several sizes. They
are deliberately independent of the UI: if a future change loses a configured
issue, drops a stakeholder group or emits a post citing a chunk that does not
exist, one of these fails.
"""
from __future__ import annotations

import pytest

from app import db
from app.ingest.brief import _sanitize_brief
from app.sim import engine

ISSUE_COUNTS = [2, 5, 10]
GROUP_COUNTS = [2, 6, 10, 15]
AGENT_COUNTS = [20, 50, 100]


def make_brief(n_issues: int, n_groups: int) -> dict:
    return {
        "summary": "Invariant scenario.",
        "issues": [
            {"id": f"iss_{i + 1}", "name": f"Issue {i + 1}", "question": f"Q{i + 1}?",
             "pro_label": "Supports", "con_label": "Opposes", "evidence_chunk_ids": []}
            for i in range(n_issues)
        ],
        "stakeholder_groups": [
            {"name": f"Group {j + 1}", "description": f"Group {j + 1}",
             "size_hint": ["small", "medium", "large"][j % 3],
             "stance_by_issue": {f"iss_{i + 1}": round(((i + j) % 5 - 2) / 4, 2)
                                 for i in range(n_issues)},
             "population_weight": 1.0 + j * 0.1}
            for j in range(n_groups)
        ],
        "key_claims": [], "entities": [],
    }


def prepare(sample_source, n_issues: int, n_groups: int, run_id: str,
            agents: int, ticks: int = 1) -> tuple[str, dict]:
    source_id = sample_source["source_id"]
    brief = _sanitize_brief(make_brief(n_issues, n_groups))
    db.execute("UPDATE sources SET brief_json=? WHERE id=?", (db.j(brief), source_id))
    cfg = {"agents": agents, "ticks": ticks, "writes_per_tick": 2, "seed": 1234,
           "pop_mix": {"pro": 0.34, "con": 0.33, "undecided": 0.33},
           "max_llm_calls": 5000, "write_batch": 3, "reflect_every": 5, "backfire": True}
    db.execute(
        "INSERT INTO runs(id,name,source_id,scenario_json,config_json,provider_json,seed,status,"
        "current_tick,last_completed_tick,rng_state,llm_calls_used,created_at,updated_at,error_json)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (run_id, "Invariant run", source_id, db.j({"question": "q", "events": []}),
         db.j(cfg), db.j({}), 1234, "draft", 0, 0, None, 0, "", "", None))
    return source_id, brief


async def run_once(source_id: str, brief: dict, run_id: str, ticks: int = 1) -> None:
    from app.llm.gateway import gateway
    await engine.seed_run(run_id, gateway)
    ctx = await engine.load_context(run_id)
    for tick in range(1, ticks + 1):
        await engine.do_tick(ctx, tick)
        ctx.last_completed = tick


@pytest.mark.asyncio
@pytest.mark.parametrize("n_issues", ISSUE_COUNTS)
async def test_issue_count_invariant(fresh_db, sample_source, n_issues):
    _sid, brief = prepare(sample_source, n_issues, 3, f"run_inv_i{n_issues}", 20)
    await run_once(_sid, brief, f"run_inv_i{n_issues}")
    stored = db.uj(db.scalar("SELECT brief_json FROM sources WHERE id=?", (_sid,)), {})
    assert len(stored["issues"]) == n_issues
    for agent in db.query("SELECT stances_json FROM agents WHERE run_id=?",
                          (f"run_inv_i{n_issues}",)):
        assert set(db.uj(agent["stances_json"], {})) == {
            f"iss_{i + 1}" for i in range(n_issues)}


@pytest.mark.asyncio
@pytest.mark.parametrize("n_groups", GROUP_COUNTS)
async def test_group_count_invariant(fresh_db, sample_source, n_groups):
    run_id = f"run_inv_g{n_groups}"
    sid, brief = prepare(sample_source, 3, n_groups, run_id, 20)
    await run_once(sid, brief, run_id)
    stored = db.uj(db.scalar("SELECT brief_json FROM sources WHERE id=?", (sid,)), {})
    assert len(stored["stakeholder_groups"]) == n_groups
    seen = {r["g"] for r in db.query(
        "SELECT DISTINCT stakeholder_group AS g FROM agents WHERE run_id=?", (run_id,))}
    assert seen == {g["name"] for g in brief["stakeholder_groups"]}, (
        f"missing: {{g['name'] for g in brief['stakeholder_groups']}} - seen")


@pytest.mark.asyncio
@pytest.mark.parametrize("agents", AGENT_COUNTS)
async def test_agent_population_invariant(fresh_db, sample_source, agents):
    run_id = f"run_inv_a{agents}"
    sid, brief = prepare(sample_source, 3, 6, run_id, agents)
    await run_once(sid, brief, run_id)
    assert db.scalar("SELECT COUNT(*) FROM agents WHERE run_id=?", (run_id,)) == agents


@pytest.mark.asyncio
async def test_group_representation_when_population_permits(fresh_db, sample_source):
    """With more agents than groups, every configured group must have at least one."""
    run_id = "run_inv_rep"
    sid, brief = prepare(sample_source, 3, 10, run_id, 30)
    await run_once(sid, brief, run_id)
    counts = {r["g"]: r["n"] for r in db.query(
        "SELECT stakeholder_group AS g, COUNT(*) AS n FROM agents WHERE run_id=?"
        " GROUP BY stakeholder_group", (run_id,))}
    for g in brief["stakeholder_groups"]:
        assert counts.get(g["name"], 0) >= 1, f"group {g['name']} has no agent"


@pytest.mark.asyncio
async def test_agents_have_valid_group_and_issues(fresh_db, sample_source):
    run_id = "run_inv_valid"
    sid, brief = prepare(sample_source, 4, 4, run_id, 20)
    await run_once(sid, brief, run_id)
    group_names = {g["name"] for g in brief["stakeholder_groups"]}
    issue_ids = {i["id"] for i in brief["issues"]}
    for a in db.query("SELECT id, stakeholder_group, stances_json, knowledge_json"
                      " FROM agents WHERE run_id=?", (run_id,)):
        assert a["stakeholder_group"] in group_names, a["stakeholder_group"]
        assert set(db.uj(a["stances_json"], {})) == issue_ids
        for st in db.uj(a["stances_json"], {}).values():
            assert -1.0 <= st["value"] <= 1.0


@pytest.mark.asyncio
async def test_posts_cite_only_real_chunks(fresh_db, sample_source):
    run_id = "run_inv_cite"
    sid, brief = prepare(sample_source, 3, 3, run_id, 20, ticks=2)
    await run_once(sid, brief, run_id, ticks=2)
    real = {r["id"] for r in db.query("SELECT id FROM chunks WHERE source_id=?", (sid,))}
    posts = db.query("SELECT id, cited_chunk_ids_json FROM posts WHERE run_id=?", (run_id,))
    assert posts, "expected posts"
    for p in posts:
        for cid in db.uj(p["cited_chunk_ids_json"], []) or []:
            assert cid in real, f"post {p['id']} cites unknown chunk {cid}"


@pytest.mark.asyncio
async def test_findings_reference_valid_rows(fresh_db, sample_source):
    run_id = "run_inv_find"
    sid, brief = prepare(sample_source, 3, 4, run_id, 20, ticks=2)
    await run_once(sid, brief, run_id, ticks=2)

    from app.analytics.findings import build_findings
    out = build_findings(run_id)
    assert out["findings"]
    posts = {r["id"] for r in db.query("SELECT id FROM posts WHERE run_id=?", (run_id,))}
    agents = {r["id"] for r in db.query("SELECT id FROM agents WHERE run_id=?", (run_id,))}
    for f in out["findings"]:
        assert f["denominator"] >= 0
        for row in f["rows"]:
            for pid in row.get("post_ids", []) or []:
                assert pid in posts, f"finding {f['id']} references unknown post {pid}"
            if row.get("agent_id"):
                assert row["agent_id"] in agents


@pytest.mark.asyncio
async def test_report_is_traceable_and_never_claims_accuracy(fresh_db, sample_source):
    run_id = "run_inv_report"
    sid, brief = prepare(sample_source, 3, 4, run_id, 20, ticks=2)
    await run_once(sid, brief, run_id, ticks=2)

    from app.analytics.report import generate_report
    md = generate_report(run_id)["report_md"]

    # every configured issue name and group name appears
    for i in brief["issues"]:
        assert i["name"] in md
    for g in brief["stakeholder_groups"]:
        assert g["name"] in md
    # the honesty contract
    assert "has not yet been externally validated" in md.lower()
    assert "not a survey" in md.lower() or "not a forecast" in md.lower()
    # no fabricated accuracy figure
    for bad in ("90% accuracy", "95% accuracy", "90% accurate", "95% accurate"):
        assert bad not in md.lower()
    # counted source
    assert "recorded database rows" in md


@pytest.mark.asyncio
async def test_narrative_covers_all_configured_entities(fresh_db, sample_source):
    run_id = "run_inv_narr"
    sid, brief = prepare(sample_source, 5, 6, run_id, 24, ticks=2)
    await run_once(sid, brief, run_id, ticks=2)

    from app.analytics.narrative import build_narrative
    n = build_narrative(run_id)
    assert len(n["issues"]) == 5
    assert len(n["stakeholders"]) == 6
    for issue in n["issues"]:
        assert issue["issue_id"] in {i["id"] for i in brief["issues"]}
    for stake in n["stakeholders"]:
        assert stake["name"] in {g["name"] for g in brief["stakeholder_groups"]}


def test_no_issue_or_group_is_dropped_by_the_brief_round_trip(fresh_db, sample_source):
    """User edits must survive save exactly: counts and every extended field."""
    for n_issues, n_groups in ((2, 2), (5, 6), (10, 10), (10, 15)):
        brief = make_brief(n_issues, n_groups)
        brief["issues"][0]["category"] = "policy.transport"
        brief["issues"][0]["detailed_context"] = "context"
        brief["stakeholder_groups"][0]["interests"] = ["cost"]
        brief["stakeholder_groups"][0]["influence"] = 5
        out = _sanitize_brief(brief)
        assert len(out["issues"]) == n_issues
        assert len(out["stakeholder_groups"]) == n_groups
        assert out["issues"][0]["category"] == "policy.transport"
        assert out["issues"][0]["detailed_context"] == "context"
        assert out["stakeholder_groups"][0]["interests"] == ["cost"]
        assert out["stakeholder_groups"][0]["influence"] == 5
