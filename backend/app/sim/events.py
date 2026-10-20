"""Scheduled + injected events, and knowledge discovery every 3 ticks."""
from __future__ import annotations

import random
from typing import Any

NEWSROOM = "newsroom"


def scheduled_events(scenario: dict) -> list[dict]:
    """scenario_json['events'] = [{tick: int, text: str}]."""
    raw = (scenario or {}).get("events") or []
    out = []
    for e in raw:
        if isinstance(e, dict):
            try:
                out.append({"tick": int(e.get("tick", 0)), "text": str(e.get("text", ""))[:500]})
            except (TypeError, ValueError):
                continue
    return sorted(out, key=lambda e: e["tick"])


def system_post(run_id: str, tick: int, text: str) -> dict:
    return {
        "id": _sys_id(tick, text), "run_id": run_id, "tick": tick,
        "agent_id": NEWSROOM, "kind": "system", "parent_id": None,
        "text": f"[Breaking] {text}", "stance": {}, "emotion": "urgency",
        "cited": [], "likes": 0, "reposts": 0, "replies": 0, "is_fallback": 0,
    }


def _sys_id(tick: int, text: str) -> str:
    import hashlib
    return "p_" + hashlib.sha1(f"sys|{tick}|{text}".encode()).hexdigest()[:8]


def discover_chunks(agents: list[dict], tick: int, rng: random.Random,
                    index_mod, share: float = 0.1) -> int:
    """Every few ticks some agents discover one new source chunk via BM25 on their interests."""
    n = 0
    for agent in agents:
        if rng.random() > share:
            continue
        query = " ".join(agent.get("interests", [])[:5]) or "issue evidence"
        known = set(agent.get("knowledge", []))
        try:
            matches = index_mod.search(agent["_source_id"], query, k=8)
        except Exception:
            matches = []
        fresh = [cid for cid, _score in matches if cid not in known]
        if not fresh:
            continue
        pick = rng.choice(fresh)
        agent.setdefault("knowledge", []).append(pick)
        from app.sim import memory
        memory.add_item(agent, tick, "discovered_chunk", f"Read a new document excerpt ({pick})",
                        refs=[pick])
        n += 1
    return n
