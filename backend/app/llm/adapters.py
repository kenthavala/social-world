"""Wire adapters: the only two HTTP shapes we speak (OpenAI chat / Anthropic messages)."""
from __future__ import annotations

from typing import Any, Optional

import httpx


class WireResponse:
    def __init__(self, text: str, reasoning_seen: bool, finish_reason: Optional[str],
                 tokens_in: Optional[int], tokens_out: Optional[int], model: Optional[str]):
        self.text = text
        self.reasoning_seen = reasoning_seen
        self.finish_reason = finish_reason
        self.tokens_in = tokens_in
        self.tokens_out = tokens_out
        self.model = model


def _join_system(messages: list[dict]) -> tuple[Optional[str], list[dict]]:
    system_parts = [m["content"] for m in messages if m.get("role") == "system"]
    rest = [m for m in messages if m.get("role") != "system"]
    system = "\n\n".join(system_parts) if system_parts else None
    return system, rest


async def openai_chat(base_url: str, model: str, messages: list[dict], *,
                      api_key: str, temperature: float, max_tokens: int,
                      timeout: int, extra_headers: dict | None = None) -> WireResponse:
    headers = {"Authorization": f"Bearer {api_key}", **(extra_headers or {})}
    body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    url = base_url.rstrip("/") + "/chat/completions"
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, headers=headers, json=body)
        if resp.status_code >= 400:
            detail = resp.text[:500]
            raise httpx.HTTPStatusError(
                f"HTTP {resp.status_code} from {base_url}: {detail}",
                request=resp.request, response=resp,
            )
        data = resp.json()
    choice = (data.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    text = message.get("content") or ""
    reasoning = ""
    if not text:
        reasoning = message.get("reasoning_content") or message.get("reasoning") or ""
        text = reasoning
    usage = data.get("usage") or {}
    return WireResponse(
        text=text, reasoning_seen=bool(reasoning), finish_reason=choice.get("finish_reason"),
        tokens_in=usage.get("prompt_tokens"), tokens_out=usage.get("completion_tokens"),
        model=data.get("model"),
    )


async def anthropic_messages(base_url: str, model: str, messages: list[dict], *,
                             api_key: str, temperature: float, max_tokens: int,
                             timeout: int) -> WireResponse:
    system, rest = _join_system(messages)
    body: dict[str, Any] = {
        "model": model,
        "messages": rest,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if system:
        body["system"] = system
    headers = {
        "x-api-key": api_key,
        "Authorization": f"Bearer {api_key}",  # proxies differ in what they accept
        "anthropic-version": "2023-06-01",
    }
    url = base_url.rstrip("/") + "/messages"
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, headers=headers, json=body)
        if resp.status_code >= 400:
            detail = resp.text[:500]
            raise httpx.HTTPStatusError(
                f"HTTP {resp.status_code} from {base_url}: {detail}",
                request=resp.request, response=resp,
            )
        data = resp.json()
    content = data.get("content") or []
    text = "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    reasoning = "".join(
        b.get("thinking", "") for b in content
        if isinstance(b, dict) and b.get("type") == "thinking"
    )
    if not text:
        text = reasoning
    usage = data.get("usage") or {}
    stop = data.get("stop_reason")
    return WireResponse(
        text=text, reasoning_seen=bool(reasoning), finish_reason=stop,
        tokens_in=usage.get("input_tokens"), tokens_out=usage.get("output_tokens"),
        model=data.get("model"),
    )


async def list_models(base_url: str, api_key: str, timeout: int = 20) -> list[str]:
    """GET {base}/models; works for OpenAI-compatible endpoints (most providers)."""
    headers = {"Authorization": f"Bearer {api_key}"}
    url = base_url.rstrip("/") + "/models"
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(url, headers=headers)
        if resp.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"HTTP {resp.status_code} listing models at {base_url}",
                request=resp.request, response=resp,
            )
        data = resp.json()
    items = data.get("data") or data.get("models") or []
    ids = []
    for item in items:
        mid = item.get("id") or item.get("name") if isinstance(item, dict) else item
        if mid:
            ids.append(str(mid))
    return sorted(set(ids))
