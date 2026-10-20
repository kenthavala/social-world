"""Feed construction: scored candidate posts for an agent this tick."""
from __future__ import annotations

import math
import random
from typing import Any, Optional


def interest_overlap(interests: list[str], text: str) -> float:
    if not interests:
        return 0.0
    low = text.lower()
    return min(1.0, sum(1 for k in interests if k.lower()[:4] in low) / max(1, len(interests) ** 0.5))


def score_post(post: dict, agent: dict, following: bool, tick: int,
               rng: random.Random, issue_ids: list[str]) -> float:
    p_tick = post["tick"]
    engagement = post.get("likes", 0) + 2 * post.get("reposts", 0)
    stance_diff = _mean_stance_diff(post, agent, issue_ids)
    score = (
        1.0 * following
        + 0.8 * math.exp(-(tick - p_tick) / 2)
        + 0.5 * math.log1p(engagement)
        + 0.6 * interest_overlap(agent.get("interests", []), post.get("text", ""))
        + 0.4 * (1 - abs(stance_diff) / 2)
        + 0.3 * rng.random()
    )
    return score


def _mean_stance_diff(post: dict, agent: dict, issue_ids: list[str]) -> float:
    """Mean |post stance - agent stance| across issues where both are known."""
    diffs: list[float] = []
    post_stance = post.get("stance") or {}
    agent_stances = agent.get("stances") or {}
    for iid in issue_ids:
        a = _stance_value(agent_stances, iid)
        p = _stance_value(post_stance, iid)
        if a is not None and p is not None:
            diffs.append(a - p)
    if not diffs:
        return 0.0
    return sum(abs(d) for d in diffs) / len(diffs)


def _stance_value(stances: Any, issue_id: str) -> Optional[float]:
    if isinstance(stances, dict):
        v = stances.get(issue_id)
        if isinstance(v, dict):
            try:
                return float(v.get("value", 0.0))
            except (TypeError, ValueError):
                return None
        if isinstance(v, (int, float)):
            return float(v)
    return None


def _agree_value(stances: Any, issue_id: str) -> float:
    v = _stance_value(stances, issue_id)
    return 0.0 if v is None else v


def feed_for_agent(agent: dict, post_pool: list[dict], edges: dict[str, dict],
                   tick: int, rng: random.Random, issue_ids: list[str],
                   limit: int = 10) -> list[dict]:
    """Top-scored recent posts. 20% of slots go to random exploration."""
    out: list[tuple[float, dict]] = []
    for post in post_pool:
        author = post.get("agent_id")
        if author == agent["id"]:
            continue
        edge = edges.get(f"{agent['id']}|{author}")
        following = bool(edge and edge.get("follows"))
        score = score_post(post, agent, following, tick, rng, issue_ids)
        out.append((score, post))
    out.sort(key=lambda sp: (-sp[0], sp[1]["id"]))
    k_keep = max(1, round(limit * 0.8)) if out else 0
    kept = [p for _s, p in out[:k_keep]]
    exploring = [p for _s, p in out[k_keep:]]
    rng.shuffle(exploring)
    n_explore = max(0, limit) - len(kept)
    return kept + exploring[:n_explore]


def provocation(feed: list[dict], agent: dict, issue_ids: list[str]) -> float:
    """Max over feed of |stance diff| * normalised engagement (0..1)."""
    worst = 0.0
    for post in feed:
        diff = abs(_mean_stance_diff(post, agent, issue_ids))
        engagement = post.get("likes", 0) + post.get("reposts", 0)
        norm = min(1.0, engagement / 10) + 0.2
        worst = max(worst, diff * norm)
    return min(1.0, worst)


def agreement(post: dict, agent: dict, issue_ids: list[str]) -> float:
    """1 = perfect agreement, 0 = total disagreement."""
    return 1.0 - _mean_stance_diff(post, agent, issue_ids) / 2


def salience(agent: dict, issue_ids: list[str]) -> float:
    """Mean confidence across issues, 0.2 floor."""
    vals = []
    for iid in issue_ids:
        v = ((agent.get("stances") or {}).get(iid) or {})
        try:
            vals.append(float(v.get("confidence", 0.5)) if isinstance(v, dict) else 0.5)
        except (TypeError, ValueError):
            vals.append(0.5)
    return max(0.2, sum(vals) / max(1, len(vals)))
