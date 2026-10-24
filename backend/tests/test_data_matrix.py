"""Data matrix: 2/5/10 issues x 3/6/10/15 stakeholder groups.

Every extended field the wizard can edit must survive the whole chain:
PUT /brief (wizard save) -> API response -> SQLite -> run -> seeding -> findings
-> report -> export. Counts alone are not enough: the test compares every field.
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app import db
from app.main import app
from app.sim import engine

ISSUE_TEXT_FIELDS = (
    "detailed_context", "geographic_scope", "time_horizon", "current_situation",
    "proposed_change", "alternative_options", "key_tradeoffs", "evidence_sources",
    "known_uncertainties", "metrics", "decision_question",
)
GROUP_TEXT_FIELDS = (
    "demographic_characteristics", "geographic_distribution", "economic_characteristics",
    "incentives", "constraints", "stance_distribution", "behavioural_tendencies",
)
GROUP_LIST_FIELDS = ("interests", "priorities", "concerns", "typical_information_sources")


@pytest.fixture()
def client(fresh_db):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _build_brief(n_issues: int, n_groups: int, chunk_ids: list[str]) -> dict:
    issues = []
    for i in range(n_issues):
        issue = {
            "id": f"iss_{i + 1}",
            "name": f"Contested Issue {i + 1:02d}",
            "question": f"Should measure {i + 1} be adopted?",
            "pro_label": f"Back measure {i + 1}",
            "con_label": f"Block measure {i + 1}",
            "evidence_chunk_ids": chunk_ids[: (i % 2) + 1],
            "category": "transport" if i % 2 == 0 else "environment",
            "keywords": [f"keyword{i + 1}a", f"keyword{i + 1}b"],
            "potential_arguments": [f"argument for {i + 1}"],
            "potential_counterarguments": [f"argument against {i + 1}"],
            "related_groups": [f"Stakeholder Group {j + 1:02d}" for j in range(min(2, n_groups))],
            "importance": round(0.2 + 0.05 * i, 3),
            "initial_stance": 0.1,
            "stance_range_min": -0.9,
            "stance_range_max": 0.9,
        }
        for field in ISSUE_TEXT_FIELDS:
            issue[field] = f"{field} for issue {i + 1}"
        issues.append(issue)

    groups = []
    for j in range(n_groups):
        stance = 0.8 if j % 3 == 0 else (-0.8 if j % 3 == 1 else 0.0)
        group = {
            "name": f"Stakeholder Group {j + 1:02d}",
            "description": f"Description of group {j + 1}",
            "size_hint": ("small", "medium", "large")[j % 3],
            "stance_by_issue": {f"iss_{i + 1}": stance for i in range(n_issues)},
            "population_weight": round(1.0 + j, 3),
            "initial_stance": stance / 2,
            "influence": round(1.0 + (j % 5), 3),
            "sensitivity": 2.5,
            "institutional_power": round(0.5 + (j % 4), 3),
            "trust_level": 0.6,
            "exposure": 0.7,
            "knowledge_level": 0.4,
            "likely_arguments": [f"group {j + 1} argument"],
            "likely_objections": [f"group {j + 1} objection"],
        }
        for field in GROUP_TEXT_FIELDS:
            group[field] = f"{field} for group {j + 1}"
        for field in GROUP_LIST_FIELDS:
            group[field] = [f"{field} item one", f"{field} item two"]
        groups.append(group)

    return {
        "summary": f"A brief with {n_issues} issues and {n_groups} groups.",
        "issues": issues,
        "stakeholder_groups": groups,
        "key_claims": [{"text": "A counted claim.", "chunk_id": chunk_ids[0]}],
        "entities": ["Council", "Residents"],
        "fallback": False,
    }


def _run_one_tick(run_id: str) -> None:
    async def _go() -> None:
        ctx = await engine.load_context(run_id)
        await engine.do_tick(ctx, 1)
    asyncio.run(_go())
    db.execute("UPDATE runs SET status='completed', current_tick=1, last_completed_tick=1"
               " WHERE id=?", (run_id,))


@pytest.mark.parametrize("n_issues,n_groups", [
    (2, 3), (2, 6), (2, 10), (2, 15),
    (5, 3), (5, 6), (5, 10), (5, 15),
    (10, 3), (10, 6), (10, 10), (10, 15),
])
def test_extended_fields_survive_the_whole_chain(client, sample_source, n_issues, n_groups):
    sid = sample_source["source_id"]
    chunk_ids = [c["id"] for c in client.get(f"/api/sources/{sid}/chunks").json()["chunks"]]
    assert len(chunk_ids) >= 2
    brief = _build_brief(n_issues, n_groups, chunk_ids)

    # 1. wizard save -> API response -------------------------------------------------
    r = client.put(f"/api/sources/{sid}/brief", json={"brief": brief})
    assert r.status_code == 200, r.text
    saved = r.json()["brief"]
    assert len(saved["issues"]) == n_issues
    assert len(saved["stakeholder_groups"]) == n_groups
    for src_issue, got_issue in zip(brief["issues"], saved["issues"]):
        assert got_issue == src_issue, f"issue field lost: {src_issue['id']}"
    for src_group, got_group in zip(brief["stakeholder_groups"], saved["stakeholder_groups"]):
        assert got_group == src_group, f"group field lost: {src_group['name']}"

    # 2. API -> SQLite ----------------------------------------------------------------
    got = client.get(f"/api/sources/{sid}").json()
    assert got["brief"] == saved
    stored = db.uj(db.scalar("SELECT brief_json FROM sources WHERE id=?", (sid,)), {})
    assert stored == saved

    # 3. run creation keeps the source link and the configured population -------------
    agents_n = 30
    run = client.post("/api/runs", json={
        "source_id": sid, "name": f"matrix {n_issues}x{n_groups}",
        "config": {"agents": agents_n, "ticks": 1, "writes_per_tick": 0, "seed": 42}})
    assert run.status_code == 200, run.text
    run_id = run.json()["id"]
    assert run.json()["source_id"] == sid
    assert run.json()["config"]["agents"] == agents_n

    # 4. seeding: every group gets agents and its configured stance direction ----------
    s = client.post(f"/api/runs/{run_id}/seed")
    assert s.status_code == 200, s.text
    assert s.json()["agents"] == agents_n
    rows = db.query("SELECT stakeholder_group AS g, stances_json FROM agents WHERE run_id=?",
                    (run_id,))
    assert {row["g"] for row in rows} == {g["name"] for g in brief["stakeholder_groups"]}
    for j, group in enumerate(brief["stakeholder_groups"]):
        want = 0.8 if j % 3 == 0 else (-0.8 if j % 3 == 1 else 0.0)
        members = [db.uj(row["stances_json"], {}) for row in rows if row["g"] == group["name"]]
        assert members, f"group {group['name']} received no agents"
        for stances in members:
            for i in range(n_issues):
                value = float(stances[f"iss_{i + 1}"]["value"])
                if want > 0:
                    assert value > -0.1
                elif want < 0:
                    assert value < 0.1
                else:
                    # 0.5 * base + 0.5 * 0.0, base in [-0.9, 0.9]
                    assert -0.46 <= value <= 0.46

    # 5. one tick, then findings ------------------------------------------------------
    _run_one_tick(run_id)
    findings = client.get(f"/api/runs/{run_id}/findings").json()
    issue_rows = next(f for f in findings["findings"] if f["id"] == "issues")["rows"]
    group_rows = next(f for f in findings["findings"] if f["id"] == "groups")["rows"]
    assert {row["name"] for row in issue_rows} >= {i["name"] for i in brief["issues"]}
    assert {row["group"] for row in group_rows} >= {g["name"] for g in brief["stakeholder_groups"]}

    # 6. report: every configured label appears, and the group counts are real ---------
    rep = client.post(f"/api/runs/{run_id}/report")
    assert rep.status_code == 200, rep.text
    md = client.get(f"/api/runs/{run_id}/report").json()["report_md"]
    assert md
    for issue in brief["issues"]:
        assert issue["name"] in md, f"report lost issue {issue['name']}"
    for group in brief["stakeholder_groups"]:
        assert group["name"] in md, f"report lost group {group['name']}"
    analytics = db.uj(db.scalar(
        "SELECT analytics_json FROM reports WHERE run_id=?", (run_id,)), {})
    report_json = db.uj(db.scalar(
        "SELECT report_json FROM reports WHERE run_id=?", (run_id,)), {})
    reported_groups = [g["name"] for g in report_json["stakeholder_groups"]]
    assert reported_groups == [g["name"] for g in brief["stakeholder_groups"]]
    assert report_json["issue_names"] == {i["id"]: i["name"] for i in brief["issues"]}
    assert analytics  # the counted analytics snapshot is stored too

    # 7. export: the full brief comes back byte-for-byte as stored ---------------------
    exp = client.get(f"/api/runs/{run_id}/export?format=json")
    assert exp.status_code == 200, exp.text
    data = exp.json()
    assert data["source"] == saved
    exported_groups = {a["group"] for a in data["agents"]}
    assert exported_groups == {g["name"] for g in brief["stakeholder_groups"]}
