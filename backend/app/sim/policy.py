"""Deterministic reactions + follow/unfollow policy."""
from __future__ import annotations

import random
from typing import Any

from app.sim import feed as feed_mod
from app.sim import relations


def decide_reactions(agent: dict, feed: list[dict], edges: dict[str, dict],
                     rng: random.Random, issue_ids: list[str]) -> list[tuple[str, str]]:
    """Returns [(post_id, kind)] for likes/reposts, decided from agreement/trust."""
    out: list[tuple[str, str]] = []
    for post in feed:
        agree = feed_mod.agreement(post, agent, issue_ids)
        trust = relations.trust_in(edges, agent["id"], post.get("agent_id"))
        reactivity = agent["traits"]["reactivity"]
        p_like = reactivity * agree * (0.5 + 0.5 * trust)
        if rng.random() < p_like:
            out.append((post["id"], "like"))
            if rng.random() < 0.3 * agent["big5"]["extraversion"] and agree > 0.4:
                out.append((post["id"], "repost"))
    return out


def decide_follows(agent: dict, feed: list[dict], edges: dict[str, dict],
                   issue_ids: list[str]) -> list[tuple[str, str]]:
    """Follow/unfollow after repeated strong (dis)agreement. Returns [(target, action)]."""
    out: list[tuple[str, str]] = []
    tolerance = agent["traits"]["tolerance"]
    for post in feed:
        author = post.get("agent_id")
        if not author or author == agent["id"]:
            continue
        agree = feed_mod.agreement(post, agent, issue_ids)
        key = f"{agent['id']}|{author}"
        edge = edges.get(key)
        if edge and edge.get("follows"):
            if agree < 0.25 and tolerance < 0.5:
                # repeated strong disagreement
                edge.setdefault("_dis", []).append(agree)
                recent = [a for a in edge["_dis"] if True][-2:]
                if len(recent) >= 2:
                    out.append((author, "unfollow"))
                    edge["_dis"] = []
        else:
            if agree > 0.75:
                streaks = agent.setdefault("_follow_streaks", {})
                hits = streaks.get(author, 0) + 1
                streaks[author] = hits
                if hits >= 2:
                    out.append((author, "follow"))
                    streaks[author] = 0
    return out
