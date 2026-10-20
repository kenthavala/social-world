"""Wire adapter tests with respx: request shape, headers, system handling, fallbacks."""
from __future__ import annotations

import httpx
import pytest
import respx


@respx.mock
@pytest.mark.asyncio
async def test_openai_chat_request_shape():
    route = respx.post("https://mock.test/v1/chat/completions").mock(
        return_value=httpx.Response(200, json={
            "choices": [{"message": {"content": "hello"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 4},
            "model": "m-1"}))
    from app.llm import adapters
    resp = await adapters.openai_chat(
        "https://mock.test/v1", "m-1",
        [{"role": "system", "content": "sys"}, {"role": "user", "content": "hi"}],
        api_key="k-1", temperature=0.5, max_tokens=10, timeout=5)
    assert route.called
    req = route.calls.last.request
    assert req.headers["Authorization"] == "Bearer k-1"
    assert req.read()
    import json
    body = json.loads(req.content)
    assert body["messages"][0]["role"] == "system"
    assert resp.text == "hello"
    assert resp.finish_reason == "stop"


@respx.mock
@pytest.mark.asyncio
async def test_openai_reasoning_content_fallback():
    respx.post("https://mock.test/v1/chat/completions").mock(
        return_value=httpx.Response(200, json={
            "choices": [{"message": {"content": "", "reasoning_content": "because"},
                         "finish_reason": "stop"}],
            "usage": {}, "model": "m"}))
    from app.llm import adapters
    resp = await adapters.openai_chat(
        "https://mock.test/v1", "m", [{"role": "user", "content": "hi"}],
        api_key="k", temperature=0.5, max_tokens=10, timeout=5)
    assert resp.text == "because"
    assert resp.reasoning_seen


@respx.mock
@pytest.mark.asyncio
async def test_anthropic_messages_request_shape():
    route = respx.post("https://mock.test/v1/messages").mock(
        return_value=httpx.Response(200, json={
            "content": [{"type": "text", "text": "A"}],
            "usage": {"input_tokens": 1, "output_tokens": 1},
            "stop_reason": "end_turn", "model": "claude-t"}))
    from app.llm import adapters
    resp = await adapters.anthropic_messages(
        "https://mock.test/v1", "claude-t",
        [{"role": "system", "content": "be brief"},
         {"role": "user", "content": "hi"}],
        api_key="k-2", temperature=0.5, max_tokens=10, timeout=5)
    req = route.calls.last.request
    assert req.headers["x-api-key"] == "k-2"
    assert "2023-06-01" in str(req.headers.get("anthropic-version"))
    import json
    body = json.loads(req.content)
    assert body["system"] == "be brief"
    assert all(m["role"] != "system" for m in body["messages"])
    assert resp.text == "A"
    assert resp.finish_reason == "end_turn"


@respx.mock
@pytest.mark.asyncio
async def test_list_models():
    respx.get("https://mock.test/v1/models").mock(
        return_value=httpx.Response(200, json={"data": [{"id": "m-b"}, {"id": "m-a"}]}))
    from app.llm import adapters
    ids = await adapters.list_models("https://mock.test/v1", "k")
    assert ids == ["m-a", "m-b"]
