"""Counted findings with denominators and the records behind each count.

Every number here comes from stored rows. No sentence in this module is written
by a model; the optional executive summary lives in analytics/report.py and is
kept separate.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any

from app import db


def _bucket(stances: dict) -> str:
    vals = [float(v.get("value", 0.0)) for v in (stances or {}).values()
            if isinstance(v, dict)]
    mean = sum(vals) / max(1, len(vals)) if vals else 0.0
    return "pro" if mean > 0.15 else "con" if mean < -0.15 else "neu"


def build_findings(run_id: str) -> dict:
    run = db.query_one("SELECT * FROM runs WHERE id=?", (run_id,))
    if run is None:
        raise ValueError(f"unknown run {run_id}")
    source_id = run["source_id"]
    posts = db.query(
        "SELECT id, tick, agent_id, stance_json, cited_chunk_ids_json"
        " FROM posts WHERE run_id=? ORDER BY seq", (run_id,))
    agents = db.query(
        "SELECT id, handle, name, stakeholder_group FROM agents WHERE run_id=?", (run_id,))
    agent_by_id = {a["id"]: dict(a) for a in agents}
    posts_total = len(posts)
    sourced = [p for p in posts if db.uj(p["cited_chunk_ids_json"], [])]
    posts_with_source = len(sourced)

    rounds: dict[int, dict] = {}
    agent_posts: dict[str, list[str]] = defaultdict(list)
    group_posts: dict[str, int] = defaultdict(int)
    issue_posts: dict[str, int] = defaultdict(int)
    group_agents: dict[str, set] = defaultdict(set)
    group_post_ids: dict[str, list[str]] = defaultdict(list)
    cites: dict[str, list[str]] = defaultdict(list)
    page_posts: dict[int, set] = defaultdict(set)
    page_chunks: dict[int, set] = defaultdict(set)

    chunk_info: dict[str, dict] = {}
    if source_id:
        for c in db.query("SELECT id, page_start, page_end, heading FROM chunks"
                          " WHERE source_id=?", (source_id,)):
            chunk_info[c["id"]] = dict(c)

    for p in posts:
        b = _bucket(db.uj(p["stance_json"], {}))
        r = rounds.setdefault(p["tick"], {"tick": p["tick"], "pro": 0, "neu": 0,
                                          "con": 0, "total": 0, "post_ids": []})
        r[b] += 1
        r["total"] += 1
        r["post_ids"].append(p["id"])
        agent_posts[p["agent_id"]].append(p["id"])
        group = (agent_by_id.get(p["agent_id"]) or {}).get("stakeholder_group") or "unassigned"
        group_posts[group] += 1
        group_agents[group].add(p["agent_id"])
        group_post_ids[group].append(p["id"])
        for iid in (db.uj(p["stance_json"], {}) or {}):
            issue_posts[iid] += 1
        for cid in db.uj(p["cited_chunk_ids_json"], []) or []:
            cites[cid].append(p["id"])
            page = (chunk_info.get(cid) or {}).get("page_start")
            if page is not None:
                page_posts[page].add(p["id"])
                page_chunks[page].add(cid)
    for a in agents:
        group = a["stakeholder_group"] or "unassigned"
        group_agents[group].add(a["id"])

    round_rows = [rounds[k] for k in sorted(rounds)]
    most_cited = []
    for cid, pids in sorted(cites.items(), key=lambda kv: (-len(kv[1]), kv[0]))[:12]:
        info = chunk_info.get(cid, {})
        most_cited.append({
            "chunk_id": cid,
            "page_start": info.get("page_start"),
            "page_end": info.get("page_end"),
            "heading": info.get("heading"),
            "citations": len(pids),
            "post_ids": pids,
        })

    agent_rows = []
    for aid, pids in sorted(agent_posts.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        a = agent_by_id.get(aid, {})
        agent_rows.append({
            "agent_id": aid,
            "handle": a.get("handle") or aid,
            "name": a.get("name") or aid,
            "group": a.get("stakeholder_group") or "unassigned",
            "posts": len(pids),
            "post_ids": pids,
        })

    group_rows = [
        {"group": g, "posts": group_posts.get(g, 0), "agents": len(group_agents[g]),
         "agent_ids": sorted(group_agents[g]), "post_ids": group_post_ids.get(g, [])}
        for g in sorted(group_agents, key=lambda g: (-group_posts.get(g, 0), g))
    ]

    page_rows = [
        {"page": page, "posts": len(page_posts[page]),
         "chunks": sorted(page_chunks[page]), "post_ids": sorted(page_posts[page])}
        for page in sorted(page_posts, key=lambda p: (-len(page_posts[p]), p))
    ]

    # Stance changes: first vs last recorded value per agent/issue.
    hist: dict[tuple[str, str], list[tuple[int, float]]] = defaultdict(list)
    for h in db.query(
            "SELECT tick, agent_id, issue_id, value FROM stance_history"
            " WHERE run_id=? ORDER BY tick, id", (run_id,)):
        hist[(h["agent_id"], h["issue_id"])].append((h["tick"], float(h["value"])))
    changes = []
    changed_agents: set[str] = set()
    for (aid, iid), pts in hist.items():
        if len(pts) < 2:
            continue
        delta = round(pts[-1][1] - pts[0][1], 3)
        if abs(delta) <= 0.05:
            continue
        changed_agents.add(aid)
        a = agent_by_id.get(aid, {})
        changes.append({
            "agent_id": aid,
            "handle": a.get("handle") or aid,
            "name": a.get("name") or aid,
            "issue_id": iid,
            "first": round(pts[0][1], 3),
            "last": round(pts[-1][1], 3),
            "delta": delta,
            "post_ids": agent_posts.get(aid, []),
        })
    changes.sort(key=lambda c: (-abs(c["delta"]), c["agent_id"], c["issue_id"]))

    # The configured issues and groups, under the names the user gave them (the id
    # stays the key). `posts` counts the posts that recorded a stance on that issue.
    brief: dict[str, Any] = {}
    if source_id:
        src = db.query_one("SELECT brief_json FROM sources WHERE id=?", (source_id,))
        brief = db.uj(src["brief_json"], {}) if src else {}

    issue_rows: list[dict[str, Any]] = []
    for i in (brief.get("issues") or []):
        if i.get("id"):
            issue_rows.append({"issue_id": i["id"], "name": i.get("name") or i["id"],
                               "posts": issue_posts.get(i["id"], 0)})
    known = {r["issue_id"] for r in issue_rows}
    for iid in sorted(set(issue_posts) - known):
        issue_rows.append({"issue_id": iid, "name": iid, "posts": issue_posts[iid]})

    # A configured group that received no agents still appears, with zeros — the
    # finding is built from agents that acted, which would otherwise drop a group
    # the operator defined as though it had never existed.
    have = {r["group"] for r in group_rows}
    for g in (brief.get("stakeholder_groups") or []):
        if g.get("name") and g["name"] not in have:
            group_rows.append({"group": g["name"], "posts": 0, "agents": 0,
                               "agent_ids": [], "post_ids": []})
    group_rows.sort(key=lambda r: (-r["posts"], r["group"]))

    findings: list[dict[str, Any]] = [
        {"id": "issues", "title": "Issues, and the posts recording a stance on each",
         "denominator": posts_total, "unit": "posts", "rows": issue_rows},
        {"id": "round_stance", "title": "Posts by round and stance",
         "denominator": posts_total, "unit": "posts", "rows": round_rows},
        {"id": "most_cited", "title": "Most-cited passages",
         "denominator": posts_with_source, "unit": "sourced posts", "rows": most_cited},
        {"id": "agents", "title": "Posts per agent",
         "denominator": posts_total, "unit": "posts", "rows": agent_rows},
        {"id": "groups", "title": "Posts per stakeholder group",
         "denominator": posts_total, "unit": "posts", "rows": group_rows},
        {"id": "pages", "title": "Share of sourced posts citing each page",
         "denominator": posts_with_source, "unit": "sourced posts", "rows": page_rows},
    ]
    if hist:
        findings.append({
            "id": "stance_changes", "title": "Recorded stance changes",
            "denominator": len(agents), "unit": "agents",
            "summary": f"{len(changed_agents)} of {len(agents)} agents changed a stance by more than 0.05",
            "rows": changes,
        })
    return {
        "run_id": run_id,
        "posts_total": posts_total,
        "posts_with_source": posts_with_source,
        "agents_total": len(agents),
        "calls_total": db.scalar("SELECT COUNT(*) FROM llm_calls WHERE run_id=?", (run_id,)) or 0,
        "findings": findings,
    }
