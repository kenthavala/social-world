"""Evidence library: the source evidence profile must reflect stored rows only."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import db
from app.main import app
from app.sim import engine


@pytest.fixture()
def client(fresh_db):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


BRIEF = {
    "summary": "A council consults on a congestion charge.",
    "issues": [
        {"id": "iss_1", "name": "Charge level", "question": "How high?",
         "pro_label": "Supports", "con_label": "Opposes",
         "evidence_chunk_ids": []},
        {"id": "iss_2", "name": "Revenue use", "question": "Where does it go?",
         "pro_label": "Supports", "con_label": "Opposes",
         "evidence_chunk_ids": []},
    ],
    "stakeholder_groups": [
        {"name": "Residents", "description": "Live in the zone", "size_hint": "large",
         "stance_by_issue": {"iss_1": 0.2, "iss_2": 0.4}, "influence": 4,
         "concerns": ["cost"]},
        {"name": "Businesses", "description": "Trade in the zone", "size_hint": "small",
         "stance_by_issue": {"iss_1": -0.4, "iss_2": -0.2}, "influence": 5,
         "concerns": ["customers"]},
    ],
    "key_claims": [], "entities": [], "fallback": False,
}


def test_evidence_profile_for_unused_document(client, sample_source):
    """A document with no brief and no runs must report empty links honestly."""
    sid = sample_source["source_id"]
    r = client.get(f"/api/sources/{sid}/evidence")
    assert r.status_code == 200, r.text
    d = r.json()

    assert d["source"]["id"] == sid
    assert d["stats"]["chunks"] > 0
    assert d["coverage"]["runs"] == 0
    assert d["coverage"]["posts_citing"] == 0
    assert d["issues"] == []
    assert d["stakeholder_groups"] == []
    assert d["findings"] == []
    # The page must be told why these are empty.
    assert any("brief" in n.lower() for n in d["notes"])
    assert any("no simulation" in n.lower() for n in d["notes"])


def test_evidence_profile_unknown_source_404(client, fresh_db):
    r = client.get("/api/sources/src_does_not_exist/evidence")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_evidence_profile_after_run(fresh_db, sample_source):
    """After a run, the profile must link issues, groups, usage and citations."""
    sid = sample_source["source_id"]
    db.execute("UPDATE sources SET brief_json=? WHERE id=?", (db.j(BRIEF), sid))

    cfg = {"agents": 8, "ticks": 2, "writes_per_tick": 2, "seed": 77,
           "pop_mix": {"pro": 0.35, "con": 0.3, "undecided": 0.35},
           "max_llm_calls": 300, "write_batch": 3, "reflect_every": 5, "backfire": True}
    run_id = "run_ev_01"
    db.execute(
        "INSERT INTO runs(id,name,source_id,scenario_json,config_json,provider_json,seed,status,"
        "current_tick,last_completed_tick,rng_state,llm_calls_used,created_at,updated_at,error_json)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (run_id, "Evidence run", sid, db.j({"question": "q", "events": []}), db.j(cfg),
         db.j({}), 77, "draft", 0, 0, None, 0, "", "", None))

    from app.llm.gateway import gateway
    await engine.seed_run(run_id, gateway)
    ctx = await engine.load_context(run_id)
    for tick in range(1, 3):
        await engine.do_tick(ctx, tick)
        ctx.last_completed = tick

    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.get(f"/api/sources/{sid}/evidence")
        assert r.status_code == 200, r.text
        d = r.json()

    assert d["coverage"]["runs"] == 1
    assert d["coverage"]["posts_citing"] > 0, "the mock run should cite chunks"
    assert len(d["issues"]) == 2
    assert [i["name"] for i in d["issues"]] == ["Charge level", "Revenue use"]
    assert {g["name"] for g in d["stakeholder_groups"]} == {"Residents", "Businesses"}
    assert sum(g["agents"] for g in d["stakeholder_groups"]) == 8
    assert d["usage"][0]["run_id"] == run_id
    assert d["usage"][0]["posts_citing"] > 0

    # Every returned chunk id must exist in the chunks table (no invented passages).
    real = {row["id"] for row in db.query("SELECT id FROM chunks WHERE source_id=?", (sid,))}
    for c in d["chunks"]:
        assert c["id"] in real
        assert c["citations"] >= 0

    # Findings that reference this document must name a real finding id.
    valid = {"issues", "round_stance", "most_cited", "agents", "groups", "pages",
             "stance_changes"}
    for f in d["findings"]:
        assert f["finding_id"] in valid
        assert f["run_id"] == run_id
