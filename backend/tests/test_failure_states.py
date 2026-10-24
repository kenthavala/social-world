"""Failure states: every one must recover or explain itself without corrupting state.

Covers the provider statuses the gateway can meet (timeout, 401, 402, 404, 410),
invalid/empty/partial JSON, extraction failure, stop/delete during seeding, resume
of an interrupted seed, zero agents and a brief with no issues or groups.
"""
from __future__ import annotations

import asyncio

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app import db
from app.errors import AppError
from app.llm.gateway import LLMResult
from app.main import app
from app.sim import engine

from test_failure_paths import _custom, _msg


@pytest.fixture()
def client(fresh_db):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


# ---------------------------------------------------------------------------
# Provider statuses: actionable hint, correct retry policy
# ---------------------------------------------------------------------------

@respx.mock
@pytest.mark.asyncio
async def test_401_is_not_retried_and_names_the_key(fresh_db, fast_gateway, monkeypatch):
    _custom(monkeypatch, "https://gw401.test/v1")
    route = respx.post("https://gw401.test/v1/chat/completions").mock(
        return_value=httpx.Response(401, json={"error": "invalid api key"}))
    with pytest.raises(AppError) as e:
        await fast_gateway.complete("test", _msg(), no_cache=True)
    assert e.value.http_status == 401
    assert "key" in (e.value.hint or "").lower()
    assert route.call_count == 1  # auth failures are never retried


@respx.mock
@pytest.mark.asyncio
async def test_404_is_not_retried_and_points_at_the_model(fresh_db, fast_gateway, monkeypatch):
    _custom(monkeypatch, "https://gw404.test/v1")
    route = respx.post("https://gw404.test/v1/chat/completions").mock(
        return_value=httpx.Response(404, json={"error": "model not found"}))
    with pytest.raises(AppError) as e:
        await fast_gateway.complete("test", _msg(), no_cache=True)
    assert e.value.http_status == 404
    assert "model" in (e.value.hint or "").lower()
    assert route.call_count == 1


@respx.mock
@pytest.mark.asyncio
async def test_410_is_not_retried_and_says_the_model_was_retired(fresh_db, fast_gateway,
                                                                 monkeypatch):
    _custom(monkeypatch, "https://gw410.test/v1")
    route = respx.post("https://gw410.test/v1/chat/completions").mock(
        return_value=httpx.Response(410, json={"error": "this model has been retired"}))
    with pytest.raises(AppError) as e:
        await fast_gateway.complete("test", _msg(), no_cache=True)
    assert e.value.http_status == 410
    hint = (e.value.hint or "").lower()
    assert "retired" in hint and "model" in hint
    assert route.call_count == 1
    # A retired model is not something waiting can fix: fail the run, do not pause it.
    assert engine._should_pause(e.value) is False


@respx.mock
@pytest.mark.asyncio
async def test_timeout_hint_says_what_to_change(fresh_db, fast_gateway, monkeypatch):
    _custom(monkeypatch, "https://gwtimeout2.test/v1")
    route = respx.post("https://gwtimeout2.test/v1/chat/completions").mock(
        side_effect=httpx.ReadTimeout("read timed out"))
    with pytest.raises(AppError) as e:
        await fast_gateway.complete("test", _msg(), no_cache=True)
    assert route.call_count == 4  # timeouts are retried, then reported
    assert "LLM_TIMEOUT_SECONDS" in (e.value.hint or "")
    # The engine keeps the run resumable for a timeout.
    assert engine._should_pause(e.value) is True


def test_retry_and_pause_policy_by_status():
    assert engine._should_pause(AppError("401", http_status=401)) is True
    assert engine._should_pause(AppError("402", http_status=402)) is True
    assert engine._should_pause(AppError("404", http_status=404)) is False
    assert engine._should_pause(AppError("410", http_status=410)) is False
    assert engine._should_pause(AppError("500", http_status=500)) is True
    assert engine._should_pause(AppError("400", http_status=400)) is False


# ---------------------------------------------------------------------------
# Invalid / empty / partial JSON
# ---------------------------------------------------------------------------

def _completion(content: str) -> dict:
    return {"model": "m-1", "choices": [
        {"message": {"content": content}, "finish_reason": "stop"}]}


@respx.mock
@pytest.mark.asyncio
async def test_partial_json_is_repaired_on_the_retry(fresh_db, fast_gateway, monkeypatch):
    _custom(monkeypatch, "https://gwjson.test/v1")
    route = respx.post("https://gwjson.test/v1/chat/completions").mock(
        side_effect=[httpx.Response(200, json=_completion('{"ok": tru')),
                     httpx.Response(200, json=_completion('{"ok": true}'))])
    result = await fast_gateway.complete("test", _msg(), no_cache=True)
    assert result.parsed == {"ok": True}
    assert route.call_count == 2  # one repair attempt, then success
    rows = fresh_db.query("SELECT status FROM llm_calls ORDER BY id")
    assert [r["status"] for r in rows] == ["parse_failed", "ok"]


@respx.mock
@pytest.mark.asyncio
async def test_invalid_json_twice_fails_with_a_clear_error(fresh_db, fast_gateway,
                                                           monkeypatch):
    _custom(monkeypatch, "https://gwjson2.test/v1")
    route = respx.post("https://gwjson2.test/v1/chat/completions").mock(
        return_value=httpx.Response(200, json=_completion("no json here")))
    with pytest.raises(AppError) as e:
        await fast_gateway.complete("test", _msg(), no_cache=True)
    assert "valid JSON" in e.value.message
    assert e.value.error_type == "provider_failed"
    assert route.call_count == 2  # initial + one repair, not an endless loop
    failed = fresh_db.query("SELECT status FROM llm_calls WHERE status='parse_failed'")
    assert len(failed) == 2  # both the first answer and the repair are audited


@respx.mock
@pytest.mark.asyncio
async def test_empty_response_is_retried_then_reported(fresh_db, fast_gateway, monkeypatch):
    _custom(monkeypatch, "https://gwempty.test/v1")
    route = respx.post("https://gwempty.test/v1/chat/completions").mock(
        return_value=httpx.Response(200, json=_completion("")))
    with pytest.raises(AppError) as e:
        await fast_gateway.complete("test", _msg(), no_cache=True)
    assert "empty response" in e.value.message
    assert route.call_count == 4


def test_parsing_rejects_empty_and_partial_text():
    from app.llm.parsing import extract_json
    for bad in ("", "   ", "not json", '{"unclosed": [1, 2', '```\n\n```'):
        with pytest.raises(ValueError):
            extract_json(bad)


# ---------------------------------------------------------------------------
# Extraction failure
# ---------------------------------------------------------------------------

def test_extraction_failure_marks_source_failed_and_blocks_the_run(client):
    from app.api import sources as sources_api
    with pytest.raises(AppError) as e:
        sources_api.extract_text_document(b"   \n\n \t ", "blank.txt")
    assert e.value.error_type in ("app_error", "extract_failed")
    row = db.query_one("SELECT id, status, error FROM sources ORDER BY created_at DESC LIMIT 1")
    assert row is not None and row["status"] == "failed"
    assert row["error"]
    r = client.post("/api/runs", json={"source_id": row["id"], "name": "blocked"})
    assert r.status_code == 409
    body = r.json()["error"]
    assert "failed" in body["message"]
    assert "re-upload" in (body["hint"] or "").lower()


# ---------------------------------------------------------------------------
# Seeding: failure, stop, delete, resume
# ---------------------------------------------------------------------------

def test_seed_failure_pauses_instead_of_sticking_in_seeding(client, brief_run, monkeypatch):
    run_id, _ = brief_run

    def _boom(*args, **kwargs):
        raise AppError("401 from provider: key rejected", http_status=401,
                       error_type="provider_failed", hint="Re-save the API key.")

    monkeypatch.setattr(engine.seeding, "initial_edges", _boom)

    r = client.post(f"/api/runs/{run_id}/seed")
    assert r.status_code == 400
    assert "key rejected" in r.json()["error"]["message"]
    assert r.json()["error"]["hint"] == "Re-save the API key."
    row = db.query_one("SELECT status, error_json FROM runs WHERE id=?", (run_id,))
    assert row["status"] == "paused"  # not stuck at 'seeding'
    assert "Re-save" in (db.uj(row["error_json"], {}) or {}).get("hint", "")
    assert (db.scalar("SELECT COUNT(*) FROM agents WHERE run_id=?", (run_id,)) or 0) == 0

    # Recoverable: stop, then delete.
    assert client.post(f"/api/runs/{run_id}/stop").json()["status"] == "interrupted"
    assert client.delete(f"/api/runs/{run_id}").status_code == 200


def test_seed_hard_failure_marks_failed_and_is_deletable(client, brief_run, monkeypatch):
    run_id, _ = brief_run

    def _boom(*args, **kwargs):
        raise AppError("400 bad request", http_status=400)

    monkeypatch.setattr(engine, "persist_agents", _boom)
    r = client.post(f"/api/runs/{run_id}/seed")
    assert r.status_code == 400
    assert db.scalar("SELECT status FROM runs WHERE id=?", (run_id,)) == "failed"
    assert client.delete(f"/api/runs/{run_id}").status_code == 200


def test_seed_unexpected_exception_marks_failed(client, brief_run, monkeypatch):
    run_id, _ = brief_run

    def _boom(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(engine, "persist_agents", _boom)
    r = client.post(f"/api/runs/{run_id}/seed")
    assert r.status_code == 400
    body = r.json()["error"]
    assert "seeding failed" in body["message"]
    row = db.query_one("SELECT status, error_json FROM runs WHERE id=?", (run_id,))
    assert row["status"] == "failed"
    assert "boom" in (db.uj(row["error_json"], {}) or {}).get("message", "")


def test_delete_during_seeding_conflicts_with_a_hint(client, brief_run):
    run_id, _ = brief_run
    db.execute("UPDATE runs SET status='seeding' WHERE id=?", (run_id,))
    r = client.delete(f"/api/runs/{run_id}")
    assert r.status_code == 409
    assert "stop it first" in (r.json()["error"]["hint"] or "")
    db.execute("UPDATE runs SET status='interrupted' WHERE id=?", (run_id,))
    assert client.delete(f"/api/runs/{run_id}").status_code == 200


class _GatedGateway:
    """Holds the first persona call open so a stop can land mid-seed."""

    def __init__(self) -> None:
        self.entered = asyncio.Event()
        self.gate = asyncio.Event()

    async def complete(self, task, messages, **kwargs):
        self.entered.set()
        await self.gate.wait()
        return LLMResult(text="[]", parsed=[], model="mock", provider="mock", task=task)


@pytest.mark.asyncio
async def test_stop_during_seeding_interrupts_and_resume_finishes(brief_run, monkeypatch):
    run_id, _ = brief_run
    gated = _GatedGateway()
    task = asyncio.create_task(engine.seed_run_guarded(run_id, gated))
    deadline = asyncio.get_event_loop().time() + 10
    while not gated.entered.is_set():
        await asyncio.sleep(0.02)
        assert asyncio.get_event_loop().time() < deadline, "seeding never started"
    assert db.scalar("SELECT status FROM runs WHERE id=?", (run_id,)) == "seeding"

    engine.request_stop(run_id)
    gated.gate.set()
    await task
    assert db.scalar("SELECT status FROM runs WHERE id=?", (run_id,)) == "interrupted"
    # The population was committed whole, so resume does not reseed.
    assert (db.scalar("SELECT COUNT(*) FROM agents WHERE run_id=?", (run_id,)) or 0) > 0

    await engine.request_resume(run_id)
    worker = engine._tasks.get(run_id)
    assert worker is not None
    deadline = asyncio.get_event_loop().time() + 30
    while not worker.done():
        await asyncio.sleep(0.1)
        assert asyncio.get_event_loop().time() < deadline, "resume did not finish"
    assert db.scalar("SELECT status FROM runs WHERE id=?", (run_id,)) == "completed"
    assert (db.scalar("SELECT last_completed_tick FROM runs WHERE id=?", (run_id,)) or 0) == 3


@pytest.mark.asyncio
async def test_cancel_during_seeding_leaves_it_interrupted(brief_run):
    run_id, _ = brief_run
    gated = _GatedGateway()
    task = asyncio.create_task(engine.seed_run_guarded(run_id, gated))
    deadline = asyncio.get_event_loop().time() + 10
    while not gated.entered.is_set():
        await asyncio.sleep(0.02)
        assert asyncio.get_event_loop().time() < deadline
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert db.scalar("SELECT status FROM runs WHERE id=?", (run_id,)) == "interrupted"
    assert (db.scalar("SELECT COUNT(*) FROM agents WHERE run_id=?", (run_id,)) or 0) == 0


# ---------------------------------------------------------------------------
# Zero agents, no issues, no groups
# ---------------------------------------------------------------------------

def test_zero_agents_is_clamped_and_still_seeds(client, sample_source):
    r = client.post("/api/runs", json={
        "source_id": sample_source["source_id"], "name": "zero",
        "config": {"agents": 0, "ticks": 1, "writes_per_tick": 0, "seed": 5}})
    assert r.status_code == 200, r.text
    detail = r.json()
    assert detail["config"]["agents"] == 1
    run_id = detail["id"]
    s = client.post(f"/api/runs/{run_id}/seed")
    assert s.status_code == 200, s.text
    assert s.json()["agents"] == 1
    assert s.json()["status"] == "ready"


def test_brief_without_issues_or_groups_seeds_a_default_group(client, sample_source):
    brief = {"summary": "A bare brief.", "issues": [], "stakeholder_groups": [],
             "key_claims": [], "entities": []}
    db.execute("UPDATE sources SET brief_json=? WHERE id=?",
               (db.j(brief), sample_source["source_id"]))
    r = client.post("/api/runs", json={
        "source_id": sample_source["source_id"], "name": "bare",
        "config": {"agents": 4, "ticks": 1, "writes_per_tick": 0, "seed": 11}})
    run_id = r.json()["id"]
    s = client.post(f"/api/runs/{run_id}/seed")
    assert s.status_code == 200, s.text
    assert s.json()["agents"] == 4
    groups = {row["stakeholder_group"] for row in
              db.query("SELECT stakeholder_group FROM agents WHERE run_id=?", (run_id,))}
    assert groups == {"Members of the public"}
    # Empty stances are stored as an empty object, not a fabricated 0.0.
    stances = db.uj(db.scalar(
        "SELECT stances_json FROM agents WHERE run_id=? LIMIT 1", (run_id,)), {})
    assert stances == {}


# ---------------------------------------------------------------------------
# A provider that keeps rejecting the write calls
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_repeated_write_failures_pause_with_the_reason(brief_run, monkeypatch):
    """Most write calls failing must pause the run with an actionable reason.

    A bare pause (status 'paused', error_json NULL) looked like a healthy run that
    had stopped for no reason: nothing to read, nothing to fix. The pause must name
    the failure, keep every completed round, and stay resumable.
    """
    from app.llm.gateway import gateway

    run_id, _ = brief_run
    cfg = db.uj(db.scalar("SELECT config_json FROM runs WHERE id=?", (run_id,)), {}) or {}
    cfg["writes_per_tick"] = 4
    cfg["write_batch"] = 2
    db.execute("UPDATE runs SET config_json=? WHERE id=?", (db.j(cfg), run_id))
    await engine.seed_run_guarded(run_id, gateway)

    real = engine._write_batch_call
    fail = {"on": True}

    async def flaky(*args, **kwargs):
        if fail["on"]:
            raise RuntimeError("connection reset by provider")
        return await real(*args, **kwargs)

    monkeypatch.setattr(engine, "_write_batch_call", flaky)
    await engine.start_run(run_id)
    worker = engine._tasks[run_id]
    assert worker is not None

    deadline = asyncio.get_event_loop().time() + 30
    while (db.scalar("SELECT status FROM runs WHERE id=?", (run_id,)) or "") == "running":
        await asyncio.sleep(0.05)
        assert asyncio.get_event_loop().time() < deadline, "the run never paused"

    row = db.query_one("SELECT status, error_json, last_completed_tick FROM runs WHERE id=?",
                       (run_id,))
    assert row["status"] == "paused", "a repairable provider fault must not fail the run"
    err = db.uj(row["error_json"], {}) or {}
    message = err.get("message", "")
    assert "write calls failed" in message
    assert "connection reset by provider" in message
    assert "Resume" in (err.get("hint") or "")
    # State survives the pause: the population is kept and the round's fallbacks
    # are recorded rather than lost.
    assert (db.scalar("SELECT COUNT(*) FROM agents WHERE run_id=?", (run_id,)) or 0) > 0
    assert (db.scalar("SELECT COUNT(*) FROM posts WHERE run_id=?", (run_id,)) or 0) > 0

    # Removing the fault and resuming finishes the run.
    fail["on"] = False
    await engine.request_resume(run_id)
    resumed = engine._tasks[run_id]
    assert resumed is not None and resumed is not worker
    deadline = asyncio.get_event_loop().time() + 60
    while not resumed.done():
        await asyncio.sleep(0.1)
        assert asyncio.get_event_loop().time() < deadline, "resume did not finish"
    assert db.scalar("SELECT status FROM runs WHERE id=?", (run_id,)) == "completed"
