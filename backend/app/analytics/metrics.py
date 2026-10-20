"""Per-tick metrics snapshots. All deterministic; no LLM."""
from __future__ import annotations

import math
from typing import Any


def issue_from_stances(agents: list[dict], issue_id: str) -> list[float]:
    vals = []
    for a in agents:
        v = (a.get("stances") or {}).get(issue_id) or {}
        try:
            vals.append(float(v.get("value", 0.0)))
        except (TypeError, ValueError):
            vals.append(0.0)
    return vals


def _mean(xs: list[float]) -> float:
    return sum(xs) / max(1, len(xs))


def _var(xs: list[float]) -> float:
    if not xs:
        return 0.0
    m = _mean(xs)
    return sum((x - m) ** 2 for x in xs) / len(xs)


def compute(agents: list[dict], issue_ids: list[str], posts_this_tick: list[dict],
            reactions_this_tick: int, follows_gained: int, follows_lost: int,
            fallback_count: int, active_count: int, llm_calls: int,
            edge_count: int, tick: int) -> dict:
    by_issue: dict[str, dict[str, float]] = {}
    for iid in issue_ids:
        vals = issue_from_stances(agents, iid)
        by_issue[iid] = {
            "mean": round(_mean(vals), 4),
            "variance": round(_var(vals), 4),
            "polarization": round(sum(1 for v in vals if abs(v) > 0.6) / max(1, len(vals)), 4),
            "undecided": round(sum(1 for v in vals if abs(v) < 0.2) / max(1, len(vals)), 4),
        }
    posts = [p for p in posts_this_tick if p.get("kind") != "system"]
    return {
        "tick": tick,
        "agents": len(agents),
        "active_agents": active_count,
        "posts": len(posts),
        "replies": sum(1 for p in posts if p.get("kind") == "reply"),
        "reposts": sum(len(p.get("reposted_by", [])) for p in posts_this_tick),
        "likes": reactions_this_tick,
        "follows_gained": follows_gained,
        "follows_lost": follows_lost,
        "fallback_count": fallback_count,
        "llm_calls": llm_calls,
        "edge_count": edge_count,
        "by_issue": by_issue,
    }


def stance_series(history: list[tuple[int, str, float]]) -> dict[str, list[dict]]:
    """stance_history rows (tick, issue, mean) -> {issue_id: [{tick, value}]} for charts."""
    out: dict[str, list[dict]] = {}
    for tick, iid, value in history:
        out.setdefault(iid, []).append({"tick": tick, "value": round(value, 4)})
    return out
