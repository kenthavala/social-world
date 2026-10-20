"""Opinion updates: bounded confidence + optional backfire. Pure functions over agent dicts."""
from __future__ import annotations

from typing import Any

RATE = 0.12
BACKFIRE_RATE = 0.03


def _v(stance: Any, issue_id: str) -> float | None:
    if isinstance(stance, dict):
        val = stance.get(issue_id)
        if isinstance(val, dict):
            try:
                return float(val.get("value", 0.0))
            except (TypeError, ValueError):
                return None
        if isinstance(val, (int, float)):
            return float(val)
    return None


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def update_from_post(agent: dict, author: dict | None, post: dict, issue_ids: list[str],
                     liked: bool, replied: bool, backfire_enabled: bool,
                     edge_weight: float) -> bool:
    """Bounded-confidence update for one seen post. Mutates agent; returns True if changed."""
    changed = False
    w = 1.0 if (liked or replied) else 0.4
    trust = 0.5 + 0.5 * max(0.0, edge_weight)
    post_stance = post.get("stances_json") or post.get("stance") or {}
    for iid in issue_ids:
        cur = _v(agent["stances"], iid)
        pv = _v(post_stance, iid)
        if cur is None or pv is None:
            continue
        d = pv - cur
        conf = agent["stances"][iid].get("confidence", 0.5)
        tolerance = agent["traits"]["tolerance"]
        gate = tolerance + (1.2 - tolerance) * (1.0 - agent["traits"]["stubbornness"])
        if abs(d) <= gate:
            delta = RATE * w * trust * (1 - agent["traits"]["stubbornness"]) * d
            cur = cur + delta
            conf = clamp(conf + 0.03, 0, 1)
            changed = True
        elif backfire_enabled and abs(d) > 1.2 and edge_weight < -0.3:
            cur = cur - BACKFIRE_RATE * (1 if d > 0 else -1)
            changed = True
        else:
            conf = clamp(conf - 0.04 if abs(pv) > 0.6 else conf, 0, 1)
        agent["stances"][iid] = {"value": clamp(round(cur, 4), -1, 1),
                                 "confidence": round(conf, 4)}
    return changed


def apply_author_shift(agent: dict, post: dict, issue_ids: list[str]) -> None:
    """Authors move 30% toward their post's self-labelled stance."""
    post_stance = post.get("stance") or {}
    for iid in issue_ids:
        cur = _v(agent["stances"], iid)
        sv = _v(post_stance, iid)
        if cur is None or sv is None or abs(sv - cur) < 1e-9:
            continue
        conf = agent["stances"][iid].get("confidence", 0.5)
        new = cur + 0.3 * (sv - cur)
        agent["stances"][iid] = {"value": clamp(round(new, 4), -1, 1),
                                 "confidence": round(conf, 4)}
