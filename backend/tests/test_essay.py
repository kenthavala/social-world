"""LLM executive summary (essay): recorded, labeled, and honest on failure.

The essay is the ONLY generated part of a report. These tests prove:
- the call goes through the gateway and lands in llm_calls (task='essay'),
- it is counted in llm_calls_used but NOT blocked by the simulation budget,
- a failure leaves the counted report intact and stores no essay,
- regenerating the report clears the essay (it summarized an old snapshot),
- exports carry the essay with its generated-not-counted label.
"""
from __future__ import annotations

import httpx
import pytest
import respx

from app import db
from app.config import config
from app.main import app


@pytest.fixture()
def client(fresh_db):
    from fastapi.testclient import TestClient
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


_ESSAY_JSON = (
    '{"executive_summary": "Opinion on the tram question stayed mixed by tick 2.",'
    ' "opinion_shifts": "No majority flip was recorded.",'
    ' "limitations": "Stubbed provider; generated prose, not counted data."}'
)


def _fake_llm(monkeypatch, base: str = "https://essay.test/v1") -> None:
    monkeypatch.setenv("LLM_PROVIDER", "custom")
    monkeypatch.setenv("LLM_BASE_URL", base)
    monkeypatch.setenv("LLM_WIRE_FORMAT", "openai_chat")
    monkeypatch.setenv("LLM_API_KEY", "sk-SECRETVALUE")
    monkeypatch.setenv("LLM_MODEL", "m-1")
    config.reload()


def _respond_with(body: str):
    route = respx.post("https://essay.test/v1/chat/completions")
    route.mock(return_value=httpx.Response(200, json={
        "choices": [{"message": {"content": body}, "finish_reason": "stop"}],
        "usage": {}, "model": "m-1"}))
    return route


def test_reports_essay_columns_exist(fresh_db):
    cols = {r["name"] for r in fresh_db.connect().execute("PRAGMA table_info(reports)")}
    assert {"essay_json", "essay_meta_json"} <= cols


def test_essay_records_call_and_surfaces(client, brief_run, monkeypatch):
    _fake_llm(monkeypatch)
    run_id, _src = brief_run
    r = client.post(f"/api/runs/{run_id}/report")
    assert r.status_code == 200, r.text
    with respx.mock:
        _respond_with(_ESSAY_JSON)
        r2 = client.post(f"/api/runs/{run_id}/report/essay")
        assert r2.status_code == 200, r2.text
        essay = r2.json()["essay"]
        assert essay["sections"]["executive_summary"].startswith("Opinion on the tram")
        assert essay["meta"]["provider"] == "custom" and essay["meta"]["model"] == "m-1"
        assert essay["meta"]["from_cache"] is False
        assert essay["meta"]["report_created_at"]  # pinned to a real snapshot

    # the call is recorded and honestly counted in the run's used column
    row = db.query_one(
        "SELECT status, parsed_ok FROM llm_calls WHERE run_id=? AND task='essay'", (run_id,))
    assert row is not None and row["status"] == "ok" and row["parsed_ok"] == 1
    assert db.scalar("SELECT llm_calls_used FROM runs WHERE id=?", (run_id,)) == 1

    rep = client.get(f"/api/runs/{run_id}/report").json()
    assert rep["essay"]["sections"]["executive_summary"].startswith("Opinion on the tram")
    assert rep["essay"]["meta"]["report_created_at"] == rep["created_at"]


def test_essay_bypasses_ended_simulation_budget(client, brief_run, monkeypatch):
    """An operator action after the run: allowed past max_llm_calls, still counted."""
    _fake_llm(monkeypatch)
    run_id, _src = brief_run
    cfg = {"agents": 2, "ticks": 1, "writes_per_tick": 0, "seed": 1,
           "pop_mix": {"pro": 0.4, "con": 0.2, "undecided": 0.4}, "max_llm_calls": 3}
    db.execute("UPDATE runs SET llm_calls_used=4, config_json=? WHERE id=?",
               (db.j(cfg), run_id))
    client.post(f"/api/runs/{run_id}/report")
    with respx.mock:
        _respond_with(_ESSAY_JSON)
        r = client.post(f"/api/runs/{run_id}/report/essay")
        assert r.status_code == 200, r.text
    # budget stays an honest counter: 4 sim calls + 1 essay call = 5 (max was 3)
    assert db.scalar("SELECT llm_calls_used FROM runs WHERE id=?", (run_id,)) == 5


def test_essay_failure_is_clean(client, brief_run, monkeypatch):
    """A provider that answers prose instead of the essay JSON must fail loudly:
    the counted report survives untouched, no essay stored, failures recorded."""
    _fake_llm(monkeypatch)
    run_id, _src = brief_run
    client.post(f"/api/runs/{run_id}/report")     # counted snapshot exists
    with respx.mock:
        _respond_with("The model wrote plain prose, no JSON here.")
        r = client.post(f"/api/runs/{run_id}/report/essay")
        assert 400 <= r.status_code < 500, r.text
        body = r.json()
        assert body["error"]["error_type"] == "provider_failed"
        assert "valid JSON" in body["error"]["message"] or body["error"]["message"]

    before = client.get(f"/api/runs/{run_id}/report").json()
    assert before["available"] is True and before["report_md"]
    assert before["essay"] is None
    rows = db.query("SELECT status FROM llm_calls WHERE run_id=? AND task='essay'", (run_id,))
    assert rows and any(x["status"] == "parse_failed" for x in rows)
    assert all(x["status"] in ("parse_failed", "error", "ok") for x in rows)


def test_essay_not_requested_before_report(client, brief_run):
    run_id, _src = brief_run
    r = client.post(f"/api/runs/{run_id}/report/essay")
    assert r.status_code == 404
    assert "Generate the report first" in (r.json()["error"].get("hint") or "")


def test_report_regeneration_clears_essay(client, brief_run, monkeypatch):
    _fake_llm(monkeypatch)
    run_id, _src = brief_run
    client.post(f"/api/runs/{run_id}/report")
    with respx.mock:
        _respond_with(_ESSAY_JSON)
        assert client.post(f"/api/runs/{run_id}/report/essay").status_code == 200
    assert client.get(f"/api/runs/{run_id}/report").json()["essay"] is not None
    client.post(f"/api/runs/{run_id}/report")     # regenerate: old summary invalid
    rep = client.get(f"/api/runs/{run_id}/report").json()
    assert rep["essay"] is None
    row = db.query_one("SELECT essay_json FROM reports WHERE run_id=?", (run_id,))
    assert row["essay_json"] is None


def test_essay_export_carries_its_label(client, brief_run, monkeypatch):
    _fake_llm(monkeypatch)
    run_id, _src = brief_run
    client.post(f"/api/runs/{run_id}/report")
    with respx.mock:
        _respond_with(_ESSAY_JSON)
        client.post(f"/api/runs/{run_id}/report/essay")
    md = client.get(f"/api/runs/{run_id}/export?format=md").text
    assert "Executive summary (LLM draft" in md
    assert "generated, not counted data" in md
    assert "Opinion on the tram" in md
    data = client.get(f"/api/runs/{run_id}/export?format=json").json()
    assert data["report"]["essay"]["honesty"] == "LLM draft; generated prose; not counted data"
    assert data["report"]["essay"]["sections"]["executive_summary"]


def test_essay_cache_hit_makes_the_second_call_free(client, brief_run, monkeypatch):
    _fake_llm(monkeypatch)
    run_id, _src = brief_run
    client.post(f"/api/runs/{run_id}/report")
    with respx.mock:
        route = _respond_with(_ESSAY_JSON)
        r1 = client.post(f"/api/runs/{run_id}/report/essay")
        assert r1.status_code == 200
        r2 = client.post(f"/api/runs/{run_id}/report/essay")
        assert r2.status_code == 200
        assert r2.json()["essay"]["meta"]["from_cache"] is True
        assert route.call_count == 1          # provider hit once, not twice
    # cache hits create no new llm_calls rows: exactly one essay row exists
    n = db.scalar("SELECT COUNT(*) FROM llm_calls WHERE run_id=? AND task='essay'", (run_id,))
    assert n == 1
