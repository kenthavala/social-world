"""Counted findings, PDF provenance and the bundled sample importer."""
from __future__ import annotations

import pytest

from app import db
from app.analytics.findings import build_findings
from app.api.export import _bundle, _bundle_md, _pdf_bytes
from app.examples import import_bundle


@pytest.mark.asyncio
async def test_findings_denominators_links_and_pdf(brief_run):
    run_id, _ = brief_run
    cfg = db.uj(db.scalar("SELECT config_json FROM runs WHERE id=?", (run_id,)), {}) or {}
    cfg.update(ticks=2, writes_per_tick=3)
    db.execute("UPDATE runs SET config_json=? WHERE id=?", (db.j(cfg), run_id))
    from app.llm.gateway import gateway
    from app.sim import engine
    await engine.seed_run(run_id, gateway)
    await engine.start_run(run_id)
    task = engine._tasks.get(run_id)
    if task:
        await task

    f = build_findings(run_id)
    assert f["posts_total"] > 0
    assert f["agents_total"] > 0
    ids = {x["id"] for x in f["findings"]}
    assert {"round_stance", "most_cited", "agents", "groups", "pages"} <= ids
    for finding in f["findings"]:
        assert "denominator" in finding and "rows" in finding
    cited = next(x for x in f["findings"] if x["id"] == "most_cited")
    assert cited["rows"]
    assert cited["rows"][0]["post_ids"]

    data = _bundle(run_id)
    pdf = _pdf_bytes(data)
    assert pdf.startswith(b"%PDF-")
    md = _bundle_md(data)
    assert "Simulated data" in md and "LLM calls by outcome" in md
    assert "## Source references" in md


def test_sample_bundle_import_is_idempotent(fresh_db):
    data = {
        "run": {"id": "run_sample_test", "name": "Sample test", "status": "completed",
                "seed": 7, "scenario": {"question": "q"}, "config": {"agents": 2, "ticks": 1},
                "provider_json": {"name": "mock", "model": "mock-1"},
                "last_completed_tick": 1, "llm_calls_used": 0,
                "created_at": "2026-01-01T00:00:00", "finished_at": "2026-01-01T00:01:00"},
        "source_record": {"filename": "sample.md", "sha256": "f" * 64, "pages": 1},
        "source": {"issues": [], "stakeholder_groups": []},
        "chunks": [{"id": "c_sample1", "idx": 0, "text": "sample text", "page_start": 1,
                    "page_end": 1, "heading": "H", "n_words": 2}],
        "agents": [{"id": "agent_s1", "handle": "s1", "name": "Sam", "group": "Residents",
                    "stances": {"iss_1": {"value": 0.5, "confidence": 0.5}},
                    "knowledge": ["c_sample1"]}],
        "posts": [{"id": "p_sample1", "tick": 1, "agent_id": "agent_s1", "kind": "post",
                   "text": "hello", "stance": {"iss_1": {"value": 0.5}},
                   "cited_chunk_ids": ["c_sample1"], "seq": 1}],
        "metrics": [{"tick": 1, "posts": 1}],
        "stance_history_rows": [{"tick": 1, "agent_id": "agent_s1", "issue_id": "iss_1",
                                 "value": 0.5, "confidence": 0.5}],
        "events": [], "llm_calls": [], "edges": [], "memories": [],
        "report": {"counted": {"report_md": "# counted", "analytics": {"posts": 1},
                               "report_json": {}, "created_at": "2026-01-01T00:01:00"}},
    }
    res = import_bundle(data)
    assert res["imported"] is True and res["run_id"] == "run_sample_test"
    assert fresh_db.scalar("SELECT COUNT(*) FROM runs WHERE id='run_sample_test'") == 1
    assert fresh_db.scalar("SELECT COUNT(*) FROM posts WHERE run_id='run_sample_test'") == 1
    assert fresh_db.scalar("SELECT COUNT(*) FROM chunks WHERE source_id='src_sample_world'") == 1
    assert fresh_db.scalar("SELECT COUNT(*) FROM reports WHERE run_id='run_sample_test'") == 1
    again = import_bundle(data)
    assert again["imported"] is False and again["already_present"] is True
    assert fresh_db.scalar("SELECT COUNT(*) FROM runs WHERE id='run_sample_test'") == 1
