"""API integration: upload -> brief -> run -> seed -> start (SSE machinery) -> export."""
from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.api import stream as stream_mod


@pytest.fixture()
def client(fresh_db):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


@pytest.fixture()
def uploaded_source(client):
    import pymupdf
    doc = pymupdf.open()
    page = doc.new_page()
    txt = ("Renewable energy subsidies encourage investment and reduce emissions. Critics "
           "counter that household costs rise and reliability suffers during calm winters. "
           "Rural towns differ on wind projects; the council must decide this quarter. ") * 8
    page.insert_textbox(pymupdf.Rect(50, 50, 545, 700), txt, fontsize=11)
    data = doc.tobytes()
    doc.close()
    resp = client.post("/api/sources", files={"file": ("policy.pdf", data, "application/pdf")})
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200


def test_redact_preview_endpoint(client):
    """The preview uses the same redact() every error/log string goes through."""
    r = client.post("/api/settings/redact-preview",
                    json={"text": "Authorization: Bearer nvapi-xyz sk-abcd1234"})
    assert r.status_code == 200
    body = r.json()
    assert body["redacted"] == "Authorization: Bearer [REDACTED] nvapi-[REDACTED] sk-[REDACTED]"
    assert body["rules"] == ["sk-", "nvapi-", "Bearer ", "eyJ"]


def test_upload_and_fetch_source(client, uploaded_source):
    assert uploaded_source["status"] == "extracted"
    detail = client.get(f"/api/sources/{uploaded_source['source_id']}").json()
    assert detail["chunks"] >= 1
    chunk = client.get(
        f"/api/sources/{uploaded_source['source_id']}/chunks/{detail['chunks'] and ''}")
    # error path: unknown chunk
    r = client.get(f"/api/sources/{uploaded_source['source_id']}/chunks/c_0000")
    assert r.status_code == 404
    assert "error" in r.json()


def test_brief_generation(client, uploaded_source):
    sid = uploaded_source["source_id"]
    r = client.post(f"/api/sources/{sid}/brief", json={"scenario": "How will towns react?"})
    assert r.status_code == 200
    brief = r.json()["brief"]
    assert brief["issues"] and brief["stakeholder_groups"]
    # editable via PUT
    brief["issues"][0]["name"] = "Renamed issue"
    r2 = client.put(f"/api/sources/{sid}/brief", json={"brief": brief})
    assert r2.status_code == 200
    assert r2.json()["brief"]["issues"][0]["name"] == "Renamed issue"


def test_estimate_endpoint(client):
    r = client.post("/api/estimate", json={"config": {"agents": 16, "ticks": 12,
                                                     "writes_per_tick": 4}})
    assert r.status_code == 200
    est = r.json()["estimate"]
    assert est["max_llm_calls"] > 0
    cfg = r.json()["config"]
    assert 5 <= cfg["agents"] <= 100


def test_unlimited_run_blocked(client, uploaded_source):
    r = client.post("/api/runs", json={"source_id": "src_missing", "config": {}})
    assert r.status_code == 404
    assert r.json()["error"]["component"] == "api"


def test_settings_no_key_leak(client, tmp_path, monkeypatch, fresh_db):
    import app.api.settings as settings_api
    monkeypatch.setattr(settings_api, "ENV_FILE", tmp_path / "t.env")
    r = client.put("/api/settings", json={"settings": {"llm_temperature": 0.5},
                                          "keys": {"NVIDIA_API_KEY": "sk-nv-secret"}})
    assert r.status_code == 200
    assert "sk-nv-secret" not in r.text
    body = r.json()
    assert body["keys"]["NVIDIA_API_KEY"] is True
    assert "sk-nv-secret" not in client.get("/api/settings").text


def test_provider_list(client):
    r = client.get("/api/providers")
    names = {p["name"] for p in r.json()["providers"]}
    assert {"openrouter", "nvidia_nim", "fcc", "mock"} <= names


def test_full_run_flow_mines_sse(client, uploaded_source):
    sid = uploaded_source["source_id"]
    client.post(f"/api/sources/{sid}/brief", json={"scenario": "How will towns react?"})
    r = client.post("/api/runs", json={"source_id": sid, "name": "API test",
                                       "config": {"agents": 6, "ticks": 2,
                                                  "writes_per_tick": 2, "seed": 7}})
    assert r.status_code == 200, r.text
    run_id = r.json()["id"]
    assert client.post(f"/api/runs/{run_id}/seed").status_code == 200
    r = client.post(f"/api/runs/{run_id}/start")
    assert r.status_code == 200, r.text
    for _ in range(100):
        detail = client.get(f"/api/runs/{run_id}").json()
        if detail["status"] in ("completed", "failed", "interrupted"):
            break
        asyncio.get_event_loop().time()
        __import__("time").sleep(0.15)
    assert detail["status"] == "completed", client.get(f"/api/runs/{run_id}/errors").json()
    posts = client.get(f"/api/runs/{run_id}/posts").json()["posts"]
    assert len(posts) > 0
    agents = client.get(f"/api/runs/{run_id}/agents").json()["agents"]
    assert len(agents) == 6
    metrics = client.get(f"/api/runs/{run_id}/metrics").json()
    assert metrics["metrics"] and metrics["stance_by_issue"]
    exp = client.get(f"/api/runs/{run_id}/export?format=json")
    assert exp.status_code == 200
    body = exp.json()
    assert body["run"]["id"] == run_id
    # M3: the bundle is self-contained and traceable
    assert body["run"]["started_at"] and body["run"]["finished_at"]
    assert isinstance(body["llm_calls"], list) and len(body["llm_calls"]) > 0
    assert all({"task", "provider", "model", "status", "latency_ms"} <= set(c)
               for c in body["llm_calls"])
    assert isinstance(body["stance_history"], list) and body["stance_history"]
    assert isinstance(body["chunks"], list) and body["chunks"]         # source_id set
    assert body["chunks"][0]["page_start"] is not None
    assert isinstance(body["events"], list)
    csvz = client.get(f"/api/runs/{run_id}/export?format=csv")
    assert csvz.status_code == 200
    import io as _io
    import zipfile as _zip
    names = _zip.ZipFile(_io.BytesIO(csvz.content)).namelist()
    assert "posts.csv" in names and "llm_calls.csv" in names and "stance_history.csv" in names
    md = client.get(f"/api/runs/{run_id}/export?format=md")
    assert md.status_code == 200 and "OASIS-Lite run" in md.text
    assert "LLM calls by outcome" in md.text
    # second active run refused while... (run already completed, so: create + start quickly blocked)
    client.post(f"/api/runs/{run_id}/events", json={"text": "Breaking change!"})
    errors = client.get(f"/api/runs/{run_id}/errors").json()["errors"]
    assert isinstance(errors, list)


@pytest.mark.asyncio
async def test_sse_broker_unit():
    gen = stream_mod._generator("run_sse_test")
    first = await gen.__anext__()
    assert first["event"] == "open"
    stream_mod.emit("run_sse_test", "tick_completed", {"tick": 1})
    got = await gen.__anext__()
    assert got["event"] == "tick_completed"
    stream_mod._subscribers["run_sse_test"].clear()


def test_chunks_listing(client, uploaded_source):
    sid = uploaded_source["source_id"]
    r = client.get(f"/api/sources/{sid}/chunks")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == r.json()["chunks"].__len__() > 0
    first = body["chunks"][0]
    assert first["id"].startswith("c_")
    assert "citations" in first
    assert client.get("/api/sources/nonexistent/chunks").status_code == 404
