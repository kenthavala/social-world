"""SSE broker: per-run subscriber queues; emit() is safe from anywhere in-process."""
from __future__ import annotations

import asyncio
import json
from typing import Any

from sse_starlette.sse import EventSourceResponse

_subscribers: dict[str, set[asyncio.Queue]] = {}


def emit(run_id: str, kind: str, payload: dict[str, Any]) -> None:
    for q in tuple(_subscribers.get(run_id, ())):
        try:
            q.put_nowait({"event": kind, "data": json.dumps(payload, ensure_ascii=False)})
        except Exception:
            pass


async def _generator(run_id: str):
    q: asyncio.Queue = asyncio.Queue()
    _subscribers.setdefault(run_id, set()).add(q)
    try:
        yield {"event": "open", "data": json.dumps({"run_id": run_id})}
        while True:
            try:
                item = await asyncio.wait_for(q.get(), timeout=10)
                yield item
            except asyncio.TimeoutError:
                yield {"comment": "hb"}
    finally:
        _subscribers.get(run_id, set()).discard(q)


def stream_response(run_id: str) -> EventSourceResponse:
    return EventSourceResponse(_generator(run_id), ping=10)
