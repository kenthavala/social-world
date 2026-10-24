"""Pipeline regression tests: N issues and M stakeholder groups survive end to end.

Covers the reported defects:
  BUG A — multiple issues must reach the simulation, findings and report.
  BUG B — multiple stakeholder groups must reach seeding, findings and report.
  BUG C — a brief round-trip through the save endpoint must be lossless.
  BUG D — the quality endpoint must compute the full honest dimension set.

Each test drives the real code path (DB -> seeding -> engine -> analytics) with the
mock provider, so a regression in any layer fails here rather than only in the UI.
"""
from __future__ import annotations

import pytest

from app import db
from app.ingest.brief import _fallback_brief, _sanitize_brief
from app.sim import engine

ISSUE_COUNTS = [2, 5, 10]
GROUP_COUNTS = [3, 6, 10, 15]


def make_brief(n_issues: int, n_groups: int = 3, *, extended: bool = False) -> dict:
    issues = []
    for i in range(n_issues):
        item = {
            "id": f"iss_{i + 1}",
            "name": f"Issue {i + 1} name",
            "question": f"Question {i + 1}?",
            "pro_label": "Supports",
            "con_label": "Opposes",
            "evidence_chunk_ids": [],
        }
        if extended:
            item.update({
                "category": "policy.transport",
                "detailed_context": f"context {i + 1}",
                "geographic_scope": "regional",
                "time_horizon": "5 years",
                "current_situation": "contested",
                "proposed_change": "levy",
                "alternative_options": "none modelled",
                "key_tradeoffs": "cost vs emissions",
                "evidence_sources": "chapter 2",
                "known_uncertainties": "uptake",
                "metrics": "mean stance",
                "decision_question": f"Adopt measure {i + 1}?",
                "keywords": ["transport", "cost"],
                "potential_arguments": ["cuts emissions"],
                "potential_counterarguments": ["raises costs"],
                "related_groups": ["Residents"],
                "importance": 0.7,
                "initial_stance": 0.1,
                "stance_range_min": -1.0,
                "stance_range_max": 1.0,
            })
        issues.append(item)

    groups = []
    for j in range(n_groups):
        group = {
            "name": f"Stakeholder {j + 1}",
            "description": f"Group {j + 1} description",
            "size_hint": ["small", "medium", "large"][j % 3],
            "stance_by_issue": {
                f"iss_{i + 1}": round(((i * 7 + j * 3) % 5 - 2) / 2, 2)
                for i in range(n_issues)
            },
        }
        if extended:
            group.update({
                "population_weight": 1.0 + j * 0.1,
                "demographic_characteristics": "mixed",
                "geographic_distribution": "urban",
                "economic_characteristics": "middle income",
                "interests": ["transport", "cost"],
                "priorities": ["reliability"],
                "concerns": ["cost"],
                "incentives": "lower fares",
                "constraints": "budget",
                "typical_information_sources": ["local press"],
                "initial_stance": 0.1,
                "stance_distribution": "wide",
                "influence": 4,
                "sensitivity": 3,
                "trust_level": 0.6,
                "institutional_power": 2,
                "exposure": 0.8,
                "knowledge_level": 0.6,
                "behavioural_tendencies": "waits for evidence",
                "likely_arguments": ["cleaner air"],
                "likely_objections": ["higher bills"],
            })
        groups.append(group)

    return {
        "summary": "Transport policy is contested.",
        "issues": issues,
        "stakeholder_groups": groups,
        "key_claims": [],
        "entities": [],
        "fallback": False,
    }


@pytest.mark.parametrize("n", ISSUE_COUNTS)
def test_sanitize_preserves_every_issue(n):
    brief = make_brief(n, 3)
    out = _sanitize_brief(brief)
    assert len(out["issues"]) == n
    assert [i["id"] for i in out["issues"]] == [f"iss_{i + 1}" for i in range(n)]


@pytest.mark.parametrize("n", GROUP_COUNTS)
def test_sanitize_preserves_every_group(n):
    brief = make_brief(5, n)
    out = _sanitize_brief(brief)
    assert len(out["stakeholder_groups"]) == n
    assert [g["name"] for g in out["stakeholder_groups"]] == [
        f"Stakeholder {j + 1}" for j in range(n)
    ]


def test_sanitize_preserves_extended_issue_fields():
    """BUG C: a builder edit must survive the save round-trip unchanged."""
    brief = make_brief(2, 2, extended=True)
    out = _sanitize_brief(brief)
    issue = out["issues"][0]
    for field in ("category", "detailed_context", "geographic_scope", "time_horizon",
                  "current_situation", "proposed_change", "alternative_options",
                  "key_tradeoffs", "evidence_sources", "known_uncertainties", "metrics",
                  "decision_question"):
        assert issue[field] == brief["issues"][0][field], field
    assert issue["keywords"] == ["transport", "cost"]
    assert issue["potential_arguments"] == ["cuts emissions"]
    assert issue["potential_counterarguments"] == ["raises costs"]
    assert issue["related_groups"] == ["Residents"]
    assert issue["importance"] == 0.7
    assert issue["initial_stance"] == 0.1


def test_sanitize_preserves_extended_group_fields():
    """BUG C: stakeholder-group attributes must not be silently dropped."""
    brief = make_brief(2, 2, extended=True)
    out = _sanitize_brief(brief)
    group = out["stakeholder_groups"][0]
    source = brief["stakeholder_groups"][0]
    for field in ("population_weight", "demographic_characteristics", "geographic_distribution",
                  "economic_characteristics", "incentives", "constraints",
                  "stance_distribution", "behavioural_tendencies", "initial_stance",
                  "influence", "sensitivity", "trust_level", "institutional_power",
                  "exposure", "knowledge_level"):
        assert group[field] == source[field], field
    assert group["interests"] == ["transport", "cost"]
    assert group["concerns"] == ["cost"]
    assert group["likely_arguments"] == ["cleaner air"]
    assert group["likely_objections"] == ["higher bills"]


@pytest.mark.parametrize("n", GROUP_COUNTS)
def test_fallback_honours_requested_group_count(n):
    """BUG B: LLM failure must not collapse the group count to three."""
    brief = _fallback_brief("scenario", "src", n_issues=5, n_groups=n)
    assert len(brief["issues"]) == 5
    assert len(brief["stakeholder_groups"]) == n
    assert brief["fallback"] is True


@pytest.mark.parametrize("n", ISSUE_COUNTS)
def test_fallback_honours_requested_issue_count(n):
    brief = _fallback_brief("scenario", "src", n_issues=n, n_groups=6)
    assert len(brief["issues"]) == n
    assert [i["id"] for i in brief["issues"]] == [f"iss_{i + 1}" for i in range(n)]
    # every group must carry a stance for every issue, or seeding has to invent one
    for group in brief["stakeholder_groups"]:
        assert set(group["stance_by_issue"]) == {f"iss_{i + 1}" for i in range(n)}


def _seed_source_brief(source_id: str, brief: dict) -> None:
    db.execute("UPDATE sources SET brief_json=? WHERE id=?", (db.j(brief), source_id))


def _make_run(source_id: str, run_id: str, *, agents: int = 20, ticks: int = 2) -> None:
    cfg = {
        "agents": agents, "ticks": ticks, "writes_per_tick": 2, "seed": 4242,
        "pop_mix": {"pro": 0.3, "con": 0.3, "undecided": 0.4},
        "max_llm_calls": 500, "write_batch": 3, "reflect_every": 5, "backfire": True,
    }
    db.execute(
        "INSERT INTO runs(id,name,source_id,scenario_json,config_json,provider_json,seed,status,"
        "current_tick,last_completed_tick,rng_state,llm_calls_used,created_at,updated_at,error_json)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (run_id, "Test run", source_id, db.j({"question": "How will people respond?",
                                              "events": []}), db.j(cfg), db.j({}), 4242,
         "draft", 0, 0, None, 0, "", "", None))


@pytest.mark.asyncio
@pytest.mark.parametrize("n_issues,n_groups", [(2, 3), (5, 6), (10, 10), (10, 15)])
async def test_full_pipeline_preserves_issues_and_groups(fresh_db, sample_source,
                                                         n_issues, n_groups):
    """BUG A + B: every configured issue and group reaches agents, stances, findings, report."""
    source_id = sample_source["source_id"]
    brief = make_brief(n_issues, n_groups)
    _seed_source_brief(source_id, _sanitize_brief(brief))
    run_id = f"run_pipe_{n_issues}_{n_groups}"
    _make_run(source_id, run_id)

    from app.llm.gateway import gateway
    n = await engine.seed_run(run_id, gateway)
    assert n == 20

    agents = db.query("SELECT stakeholder_group, stances_json FROM agents WHERE run_id=?",
                      (run_id,))
    seen_groups = {a["stakeholder_group"] for a in agents}
    expected_groups = {g["name"] for g in brief["stakeholder_groups"]}
    assert seen_groups == expected_groups, f"missing groups: {expected_groups - seen_groups}"
    for a in agents:
        keys = set(db.uj(a["stances_json"], {}))
        assert keys == {f"iss_{i + 1}" for i in range(n_issues)}

    ctx = await engine.load_context(run_id)
    assert ctx.issue_ids == [f"iss_{i + 1}" for i in range(n_issues)]
    for tick in range(1, 3):
        await engine.do_tick(ctx, tick)
        ctx.last_completed = tick

    recorded = {r["issue_id"] for r in db.query(
        "SELECT DISTINCT issue_id FROM stance_history WHERE run_id=?", (run_id,))}
    assert recorded == {f"iss_{i + 1}" for i in range(n_issues)}

    from app.analytics.findings import build_findings
    findings = {f["id"]: f for f in build_findings(run_id)["findings"]}
    assert len(findings["issues"]["rows"]) == n_issues
    assert len(findings["groups"]["rows"]) == n_groups

    from app.analytics.report import generate_report
    report = generate_report(run_id)
    md = report.get("report_md") or ""
    # every issue is labelled by its configured name, and every group is listed
    for issue in brief["issues"]:
        assert issue["name"] in md, f"issue name missing from report: {issue['name']}"
    for group in brief["stakeholder_groups"]:
        assert group["name"] in md, f"group name missing from report: {group['name']}"


@pytest.mark.asyncio
async def test_quality_reports_honest_dimension_set(fresh_db, sample_source):
    """BUG D: the quality endpoint must cover the documented dimensions."""
    source_id = sample_source["source_id"]
    _seed_source_brief(source_id, _sanitize_brief(make_brief(3, 3)))
    run_id = "run_quality_01"
    _make_run(source_id, run_id, ticks=2)

    from app.llm.gateway import gateway
    await engine.seed_run(run_id, gateway)
    ctx = await engine.load_context(run_id)
    for tick in range(1, 3):
        await engine.do_tick(ctx, tick)
        ctx.last_completed = tick

    from app.analytics.realism import compute_realism
    data = compute_realism(run_id)
    ids = {d["id"] for d in data["dimensions"]}
    required = {
        "evidence_coverage", "agent_diversity", "issue_coverage",
        "stakeholder_representation", "population_representation",
        "interaction_realism", "network_realism", "temporal_realism",
        "stance_stability", "provider_reliability", "generation_quality",
        "data_completeness", "configuration_completeness", "replication_stability",
        "historical_validation", "outcome_validation",
    }
    assert required <= ids, f"missing dimensions: {sorted(required - ids)}"
    # Every dimension must explain itself and carry a status.
    for dim in data["dimensions"]:
        assert dim["explanation"].strip(), dim["id"]
        assert dim["status"] in {"assessed", "partial", "not_assessed", "not_connected"}
        if dim["status"] in {"not_assessed", "not_connected"}:
            assert dim["score"] is None, f"{dim['id']} must not invent a score"
    # The overall score is a weighted average of assessed dimensions only.
    assert data["overall"]["score"] is not None
    assert "not predictive accuracy" in data["overall"]["method"].lower()
    assert data["predictive_accuracy"]["status"] == "not_validated"
    assert "does not claim" in data["predictive_accuracy"]["message"].lower()


@pytest.mark.asyncio
async def test_narrative_covers_every_issue_and_group(fresh_db, sample_source):
    """The narrative layer must interpret counts without inventing anything."""
    source_id = sample_source["source_id"]
    _seed_source_brief(source_id, _sanitize_brief(make_brief(5, 6)))
    run_id = "run_narr_01"
    _make_run(source_id, run_id, agents=24, ticks=3)

    from app.llm.gateway import gateway
    await engine.seed_run(run_id, gateway)
    ctx = await engine.load_context(run_id)
    for tick in range(1, 4):
        await engine.do_tick(ctx, tick)
        ctx.last_completed = tick

    from app.analytics.narrative import build_narrative
    n = build_narrative(run_id)

    assert n["provenance"]["kind"] == "computed"
    assert n["provenance"]["predictive_accuracy"] == "not_validated"
    assert "No model call" in n["provenance"]["method"]

    # every configured issue gets its own section
    assert len(n["issues"]) == 5
    assert [i["issue_id"] for i in n["issues"]] == [f"iss_{i + 1}" for i in range(5)]
    # every configured group gets its own section, including ones with no agents
    assert len(n["stakeholders"]) == 6
    assert {s["name"] for s in n["stakeholders"]} == {
        f"Stakeholder {j + 1}" for j in range(6)}

    # the eight reader questions are all answered with text
    for key in ("what_happened", "why", "who_drove_it", "what_evidence",
                "agreement", "disagreement", "what_changed", "watch"):
        assert isinstance(n["answers"][key], str) and n["answers"][key].strip(), key

    # findings carry evidence and a strength label, never a fake precision claim
    assert 1 <= len(n["key_findings"]) <= 5
    for f in n["key_findings"]:
        assert f["headline"] and f["explanation"] and f["why_it_matters"]
        assert f["strength"] in ("strong", "moderate", "indicative")
        assert "not a probability" in f["strength_reason"].lower()

    # uncertainty is always stated
    assert n["uncertainty"]
    assert any("personas" in u.lower() for u in n["uncertainty"])

    # scale block is internally consistent with the stored rows
    posts = db.scalar("SELECT COUNT(*) FROM posts WHERE run_id=?", (run_id,)) or 0
    agents = db.scalar("SELECT COUNT(*) FROM agents WHERE run_id=?", (run_id,)) or 0
    assert n["scale"]["posts"] == posts
    assert n["scale"]["agents"] == agents


def test_narrative_handles_empty_run_without_inventing(fresh_db, sample_source):
    """A run with no ticks must return honest 'not enough evidence' text."""
    source_id = sample_source["source_id"]
    _seed_source_brief(source_id, _sanitize_brief(make_brief(2, 3)))
    run_id = "run_narr_empty"
    _make_run(source_id, run_id, ticks=3)

    from app.analytics.narrative import build_narrative
    n = build_narrative(run_id)
    assert n["scale"]["posts"] == 0
    assert n["scale"]["overall_final"] is None
    assert "not enough evidence" in n["answers"]["what_happened"].lower()
