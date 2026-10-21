"""Release API: manifest, backfill, branch/compare, provider presets."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.version import APP_VERSION


@pytest.fixture()
def client(fresh_db):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def test_run_manifest_records_provenance(client, sample_source):
    r = client.post("/api/runs", json={
        "source_id": sample_source["source_id"], "name": "manifest",
        "config": {"agents": 5, "ticks": 1, "writes_per_tick": 1, "seed": 42}})
    assert r.status_code == 200, r.text
    detail = r.json()
    m = detail["manifest"]
    assert m["run_id"] == detail["id"]
    assert m["app_version"] == APP_VERSION
    assert m["seed"] == 42
    assert m["source_sha256"] and len(m["source_sha256"]) == 64
    assert m["prompt_version"]
    assert detail["llm_reserved"] == 0


def test_backfill_returns_posts_after_sequence(client, sample_source, fresh_db):
    r = client.post("/api/runs", json={
        "source_id": sample_source["source_id"], "name": "backfill",
        "config": {"agents": 5, "ticks": 1, "writes_per_tick": 1, "seed": 7}})
    run_id = r.json()["id"]
    fresh_db.execute(
        "INSERT INTO posts(id, run_id, tick, agent_id, kind, text, seq)"
        " VALUES('p_a',?,1,'a','post','one',1),('p_b',?,1,'b','post','two',2)",
        (run_id, run_id))
    body = client.get(f"/api/runs/{run_id}/backfill?after_post=1").json()
    assert [p["id"] for p in body["posts"]] == ["p_b"]
    assert body["last_post_seq"] == 2


def test_branch_is_a_truthful_rerun_and_compare_is_counted(client, sample_source, fresh_db):
    r = client.post("/api/runs", json={
        "source_id": sample_source["source_id"], "name": "original",
        "config": {"agents": 6, "ticks": 2, "writes_per_tick": 1, "seed": 99}})
    original = r.json()["id"]
    b = client.post(f"/api/runs/{original}/branch", json={
        "text": "A delivery-van exemption is announced.", "audience": "all"})
    assert b.status_code == 200, b.text
    body = b.json()
    assert body["mode"] == "rerun_from_round_1"
    assert body["parent_run_id"] == original
    assert body["branch_round"] == 1
    sched = fresh_db.query_one(
        "SELECT tick, payload_json FROM events WHERE run_id=? AND kind='scheduled'",
        (body["id"],))
    assert sched is not None and sched["tick"] == 1
    assert "delivery-van" in sched["payload_json"]
    cmp = client.get(f"/api/runs/{original}/compare?other={body['id']}")
    assert cmp.status_code == 200, cmp.text
    data = cmp.json()
    assert data["left"]["run"]["id"] == original
    assert data["right"]["run"]["id"] == body["id"]
    assert "posts" in data["diffs"] and "citation_total" in data["diffs"]
    assert "counted differences" in data["label"]


def test_local_provider_presets_need_no_key(client):
    names = {p["name"] for p in client.get("/api/providers").json()["providers"]}
    assert {"ollama", "lmstudio"} <= names
    local = [p for p in client.get("/api/providers").json()["providers"]
             if p["name"] in ("ollama", "lmstudio")]
    assert all(p["has_key"] for p in local)


def test_raise_budget_updates_config(client, sample_source):
    r = client.post("/api/runs", json={
        "source_id": sample_source["source_id"], "name": "budget",
        "config": {"agents": 5, "ticks": 1, "writes_per_tick": 1, "max_llm_calls": 2}})
    run_id = r.json()["id"]
    b = client.post(f"/api/runs/{run_id}/budget", json={"max_llm_calls": 25})
    assert b.status_code == 200
    assert b.json()["max_llm_calls"] == 25
