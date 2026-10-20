"""Agent memories: rule-scored items, recency + keyword retrieval, capped at 50."""
from __future__ import annotations

import math
from typing import Any

IMPORTANCE = {
    "own_post": 0.5, "reply_received": 0.7, "strong_disagreement": 0.8,
    "new_follower": 0.4, "discovered_chunk": 0.6,
}


def add_item(agent: dict, tick: int, kind: str, text: str, refs: list[str] | None = None,
             importance: float | None = None) -> None:
    items = agent.setdefault("memories", [])
    items.append({
        "tick": tick, "kind": kind, "text": str(text)[:280],
        "importance": importance if importance is not None else IMPORTANCE.get(kind, 0.4),
        "refs": refs or [],
    })
    items.sort(key=lambda m: m["tick"])
    if len(items) > 50:
        del items[:-50]


def keyword_overlap(mem: dict, query: str) -> float:
    """Fracfion of query words (lower-cased, >=4 chars) appearing in the memory text."""
    if not query:
        return 0.0
    words = [w.lower() for w in query.split() if len(w) >= 4]
    if not words:
        return 0.0
    low = mem.get("text", "").lower()
    return sum(1 for w in words if w in low) / len(words)


def retrieve(agent: dict, tick: int, query: str = "", k: int = 3) -> list[dict]:
    """Top-k by importance * recency decay + 0.3 * keyword overlap."""
    items = agent.get("memories", [])
    scored = []
    for m in items:
        score = m["importance"] * math.exp(-(tick - m["tick"]) / 10) + 0.3 * keyword_overlap(m, query)
        scored.append((score, m.get("tick", 0), m))
    scored.sort(key=lambda s: (-s[0], -s[1]))
    return [m for _s, _t, m in scored[:k]]
