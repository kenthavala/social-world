"""Gateway reliability: retries, 429/Retry-After, 401, fallback, budget, cache, redaction."""
from __future__ import annotations

import httpx
import pytest
import respx

from app.config import config
from app.errors import AppError, BudgetExhausted
from app.llm.gateway import Gateway


def _user_msg(content: str):
    return [{"role": "user", "content": content}]


def _custom_env(monkeypatch, base: str, model="m-1", **extra):
    monkeypatch.setenv("LLM_PROVIDER", "custom")
    monkeypatch.setenv("LLM_BASE_URL", base)
    monkeypatch.setenv("LLM_WIRE_FORMAT", "openai_chat")
    monkeypatch.setenv("LLM_API_KEY", "sk-SECRETVALUE")
    monkeypatch.setenv("LLM_MODEL", model)
    for k, v in extra.items():
        monkeypatch.setenv(k, v)
    config.reload()


@respx.mock
@pytest.mark.asyncio
async def test_mock_provider_basic(fresh_db, fast_gateway):
    result = await fast_gateway.complete("test", _user_msg("hi"), no_cache=True)
    assert result.provider == "mock"
    assert result.parsed == {"ok": True, "n": 7}
    row = fresh_db.query_one("SELECT task, status FROM llm_calls WHERE task='test'")
    assert row["status"] == "ok"


@respx.mock
@pytest.mark.asyncio
async def test_429_retry_after_then_success(fresh_db, fast_gateway, monkeypatch):
    _custom_env(monkeypatch, "https://gw.test/v1")
    route = respx.post("https://gw.test/v1/chat/completions").mock(side_effect=[
        httpx.Response(429, headers={"Retry-After": "0"}),
        httpx.Response(200, json={
            "choices": [{"message": {"content": '{"ok": true, "n": 7}'}, "finish_reason": "stop"}],
            "usage": {}, "model": "m-1"})])
    g = fast_gateway
    result = await g.complete("test", _user_msg("hi"), no_cache=True)
    assert result.parsed == {"ok": True, "n": 7}
    assert route.call_count == 2
    ok_rows = fresh_db.query("SELECT status FROM llm_calls WHERE status IN ('ok','error')")
    assert any(r["status"] == "ok" for r in ok_rows)


@respx.mock
@pytest.mark.asyncio
async def test_401_no_retry_with_hint(fresh_db, fast_gateway, monkeypatch):
    _custom_env(monkeypatch, "https://gw401.test/v1")
    route = respx.post("https://gw401.test/v1/chat/completions").mock(
        return_value=httpx.Response(401, json={"error": "bad sk-SECRETVALUE key"}))
    with pytest.raises(AppError) as e:
        await fast_gateway.complete("test", _user_msg("hi"), no_cache=True)
    assert route.call_count == 1  # never retried
    assert e.value.http_status == 401
    assert e.value.hint  # readable hint present
    # key value must never leak into the stored error text
    stored = fresh_db.query("SELECT error FROM llm_calls WHERE error IS NOT NULL AND error != ''")
    for r in stored:
        assert "SECRETVALUE" not in r["error"]


@respx.mock
@pytest.mark.asyncio
async def test_500_then_fallback_model(fresh_db, fast_gateway, monkeypatch):
    _custom_env(monkeypatch, "https://gw500.test/v1", model="m-1",
                **{"LLM_FALLBACK_MODELS": "m-fb"})
    ok_body = httpx.Response(200, json={
        "choices": [{"message": {"content": '{"ok": true, "n": 7}'}, "finish_reason": "stop"}],
        "usage": {}, "model": "m-fb"})
    respx.post("https://gw500.test/v1/chat/completions").mock(side_effect=[
        httpx.Response(500), httpx.Response(500), httpx.Response(500),
        httpx.Response(500), httpx.Response(500), httpx.Response(500),
        ok_body])
    result = await fast_gateway.complete("test", _user_msg("hi"), no_cache=True)
    assert result.model == "m-fb"  # fell back after exhausting retries on m-1


@respx.mock
@pytest.mark.asyncio
async def test_repair_retry_once(fresh_db, fast_gateway, monkeypatch):
    _custom_env(monkeypatch, "https://gwr.test/v1")
    respx.post("https://gwr.test/v1/chat/completions").mock(side_effect=[
        httpx.Response(200, json={
            "choices": [{"message": {"content": "Sure! ```json\n{\"ok\": true, \"n\": 7,}\n```"},
                         "finish_reason": "stop"}], "usage": {}, "model": "m-1"})])
    result = await fast_gateway.complete("test", _user_msg("hi"), no_cache=True)
    # trailing comma is auto-repaired without a second call
    assert result.parsed == {"ok": True, "n": 7}


@respx.mock
@pytest.mark.asyncio
async def test_garbage_exactly_one_repair(fresh_db, fast_gateway, monkeypatch):
    _custom_env(monkeypatch, "https://gwgarbage.test/v1")
    route = respx.post("https://gwgarbage.test/v1/chat/completions").mock(side_effect=[
        httpx.Response(200, json={
            "choices": [{"message": {"content": "no json here at all"},
                         "finish_reason": "stop"}], "usage": {}, "model": "m-1"}),
        httpx.Response(200, json={
            "choices": [{"message": {"content": '{"fixed": true}'},
                         "finish_reason": "stop"}], "usage": {}, "model": "m-1"})])
    result = await fast_gateway.complete("test", _user_msg("hi"), no_cache=True)
    assert result.parsed == {"fixed": True}
    assert route.call_count == 2  # original + exactly one repair


@pytest.mark.asyncio
async def test_budget_exhausted(brief_run, fresh_db, fast_gateway):
    run_id, _ = brief_run
    fresh_db.execute("UPDATE runs SET llm_calls_used=10, config_json=? WHERE id=?",
                     (fresh_db.j({"agents": 6, "ticks": 2, "writes_per_tick": 1,
                                  "max_llm_calls": 5, "pop_mix": {"pro": 0.3, "con": 0.3, "undecided": 0.4}}), run_id))
    with pytest.raises(BudgetExhausted):
        await fast_gateway.complete("test", _user_msg("hi"), run_id=run_id, no_cache=True)


@pytest.mark.asyncio
async def test_cache_hit(fresh_db, fast_gateway):
    msg = _user_msg("cache-me")
    first = await fast_gateway.complete("test", msg)
    second = await fast_gateway.complete("test", msg)
    assert not first.from_cache
    assert second.from_cache


# --- replay mode: serve ONLY from recorded llm_calls (spec §6, KNOWN_LIMITS #12) ---

_WRITE_OK = ('[{"agent_id": "agent_x", "action": "post", "text": "recorded replay text",'
             ' "stance": {}, "emotion": "neutral"}]')


def _record_write_call(run_id: str, messages: list[dict], text: str = _WRITE_OK) -> None:
    from app.llm.gateway import _record, _request_hash
    rhash = _request_hash("mock", "mock-1", "write", messages)
    _record(run_id, "write", "mock", "mock-1", rhash, "{}",
            text, 1, "ok", None, None, None, None, 43)


@pytest.mark.asyncio
async def test_replay_serves_recorded_call(fresh_db, fast_gateway, monkeypatch):
    from app.sim.models import WriteItem
    monkeypatch.setattr(config, "_file", {"llm_replay": True})
    msgs = [{"role": "user", "content": "write batch"}]
    _record_write_call("run_rep", msgs)
    result = await fast_gateway.complete("write", msgs, expect=WriteItem,
                                         run_id="run_rep", max_items=3)
    assert result.from_cache is True
    assert result.text == _WRITE_OK
    assert result.parsed and result.parsed[0].text == "recorded replay text"
    # replay never calls a provider and never writes a new llm_calls row
    assert fresh_db.scalar("SELECT COUNT(*) FROM llm_calls") == 1


@pytest.mark.asyncio
async def test_replay_miss_is_assertive(fresh_db, fast_gateway, monkeypatch):
    from app.sim.models import WriteItem
    monkeypatch.setattr(config, "_file", {"llm_replay": True})
    with pytest.raises(AppError) as e:
        await fast_gateway.complete("write", [{"role": "user", "content": "unrecorded"}],
                                    expect=WriteItem, run_id="run_rep", max_items=3)
    assert e.value.error_type == "replay_miss"
    assert "replay" in e.value.message.lower()


@pytest.mark.asyncio
async def test_replay_rejected_when_recorded_text_invalid(fresh_db, fast_gateway, monkeypatch):
    """A recorded 'ok' row whose text no longer parses must fail loudly, not degrade."""
    from app.sim.models import WriteItem
    monkeypatch.setattr(config, "_file", {"llm_replay": True})
    msgs = [{"role": "user", "content": "write batch two"}]
    _record_write_call("run_rep2", msgs, text="The model wrote plain prose, no JSON here.")
    with pytest.raises(AppError) as e:
        await fast_gateway.complete("write", msgs, expect=WriteItem,
                                    run_id="run_rep2", max_items=3)
    assert e.value.error_type == "replay_invalid"
