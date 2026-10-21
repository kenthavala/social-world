"""SSE broker: replayable per-run events, monotonic IDs and heartbeat.

Every event emitted for an existing run is persisted in `stream_events` before
it reaches subscribers, so a reconnect with Last-Event-ID can catch up. Events
for unknown run ids are still delivered in-process (tests/tools) but not stored.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any, Optional

from sse_starlette.sse import EventSourceResponse

from app import db

_subscribers: dict[str, set[asyncio.Queue]] = {}
_fallback_id = 0


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _persist(run_id: str, kind: str, payload: dict) -> Optional[int]:
    """Store the event if the run exists; return its row id."""
    global _fallback_id
    try:
        if db.query_one("SELECT id FROM runs WHERE id=?", (run_id,)) is None:
            _fallback_id += 1
            return _fallback_id
        cur = db.execute(
            "INSERT INTO stream_events(run_id, kind, payload_json, created_at) VALUES(?,?,?,?)",
            (run_id, kind, json.dumps(payload, ensure_ascii=False), _now()))
        return int(cur.lastrowid)
    except Exception:
        # A logging/event path must never break a simulation.
        _fallback_id += 1
        return _fallback_id


def emit(run_id: str, kind: str, payload: dict[str, Any]) -> None:
    eid = _persist(run_id, kind, payload)
    message = {"event": kind, "data": json.dumps(payload, ensure_ascii=False), "id": str(eid)}
    for q in tuple(_subscribers.get(run_id, ())):
        try:
            q.put_nowait(message)
        except Exception:
            pass


async def _generator(run_id: str, last_event_id: Optional[str] = None):
    q: asyncio.Queue = asyncio.Queue()
    _subscribers.setdefault(run_id, set()).add(q)
    last = 0
    try:
        try:
            last = int(last_event_id or 0)
        except (TypeError, ValueError):
            last = 0
        yield {"event": "open", "data": json.dumps({"run_id": run_id, "replayed_from": last})}
        if last > 0:
            try:
                rows = db.query(
                    "SELECT id, kind, payload_json FROM stream_events"
                    " WHERE run_id=? AND id>? ORDER BY id", (run_id, last))
                for row in rows:
                    last = max(last, int(row["id"]))
                    yield {"event": row["kind"], "data": row["payload_json"],
                           "id": str(row["id"])}
            except Exception:
                pass
        while True:
            try:
                item = await asyncio.wait_for(q.get(), timeout=15)
                try:
                    if int(item.get("id") or 0) <= last:
                        continue
                    last = max(last, int(item.get("id") or 0))
                except (TypeError, ValueError):
                    pass
                yield item
            except asyncio.TimeoutError:
                yield {"comment": "heartbeat"}
    finally:
        _subscribers.get(run_id, set()).discard(q)


def stream_response(run_id: str, last_event_id: Optional[str] = None) -> EventSourceResponse:
    return EventSourceResponse(
        _generator(run_id, last_event_id),
        ping=15,
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
