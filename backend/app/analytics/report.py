"""Run reports — deterministic summaries computed from the database rows.

Every number counts something actually recorded (agents, posts, stance
history, edges, llm_calls, events). TF-IDF over each community's own posts
names what they talked about — again: counted, not generated. Reports are
stored in the reports table (INSERT OR REPLACE) so revisiting a run shows
its snapshot.

One OPTIONAL addition: generate_essay_report writes an LLM executive
summary THROUGH the gateway (recorded in llm_calls like every other call).
It is stored separately from the counted snapshot, clearly labeled as
generated prose, and is wiped whenever the report is regenerated.
"""
from __future__ import annotations

import math
import re
from datetime import datetime, timezone

from app import db

_STOPWORDS = frozenset(
    "a about after all also am an and any are as at be because been being below between both "
    "but by can cannot could did do does doing down during each few for from further had has "
    "have having he her here hers him his how i if in into is it its just like me more most my "
    "no nor not now of off on once only or other our ours out over own same she should so some "
    "such than that the their theirs them then there these they this those through to too "
    "under until up us very was we well were what when where which while who whom why will "
    "with would you your yours also may might must many much still one two three"
    .split())


def _tokens(text: str) -> list[str]:
    return [t for t in re.findall(r"[a-z][a-z'\-]{2,}", text.lower()) if t not in _STOPWORDS]


def _endorsement_counts(run_id: str) -> dict[str, int]:
    counts = {"pro": 0, "neutral": 0, "con": 0}
    for r in db.query("SELECT stances_json FROM agents WHERE run_id=?", (run_id,)):
        stances = db.uj(r["stances_json"], {}) or {}
        vals = [float(s.get("value", 0.0)) for s in stances.values() if isinstance(s, dict)]
        mean = sum(vals) / max(1, len(vals))
        counts["pro" if mean > 0.15 else "con" if mean < -0.15 else "neutral"] += 1
    return counts


def _last_tick_stances(run_id: str, last_tick: int) -> dict[str, float]:
    """Mean stance per issue at the last completed tick."""
    out: dict[str, float] = {}
    stances = db.query(
        "SELECT issue_id, AVG(value) v FROM stance_history WHERE run_id=? AND tick=?"
        " GROUP BY issue_id", (run_id, last_tick))
    for r in stances:
        out[r["issue_id"]] = round(r["v"], 3)
    return out


def _top_posts(run_id: str, k: int = 5) -> list[dict]:
    rows = db.query(
        "SELECT tick, agent_id, kind, text, likes, reposts, replies FROM posts"
        " WHERE run_id=? ORDER BY (likes+reposts+replies) DESC, tick LIMIT ?", (run_id, k))
    agents = {a["id"]: {"handle": a["handle"]} for a in db.query(
        "SELECT id, handle FROM agents WHERE run_id=?", (run_id,))}
    out = []
    for p in rows[:k]:
        if p["kind"] == "system":
            continue
        out.append({
            "tick": p["tick"],
            "handle": (agents.get(p["agent_id"]) or {}).get("handle") or p["agent_id"],
            "text": p["text"][:160],
            "engagement": (p["likes"] or 0) + (p["reposts"] or 0) + (p["replies"] or 0),
        })
    return out


def _influencers(run_id: str) -> list[dict]:
    try:
        from app.analytics.network import summary
        return summary(run_id, None).get("influencers") or []
    except Exception:
        return []


def _turning_points(run_id: str) -> list[dict]:
    """Biggest tick-to-tick shifts of the per-issue mean stance (top 3 by |delta|)."""
    rows = db.query(
        "SELECT tick, issue_id, ROUND(AVG(value), 4) AS m FROM stance_history"
        " WHERE run_id=? GROUP BY tick, issue_id ORDER BY issue_id, tick", (run_id,))
    per: dict[str, list[tuple[int, float]]] = {}
    for r in rows:
        per.setdefault(r["issue_id"], []).append((r["tick"], r["m"]))
    points: list[dict] = []
    for iid, series in per.items():
        series.sort()
        for (t1, m1), (t2, m2) in zip(series, series[1:]):
            points.append({"issue_id": iid, "tick": t2, "from": m1, "to": m2,
                           "delta": round(m2 - m1, 3)})
    points.sort(key=lambda p: (-abs(p["delta"]), p["issue_id"], p["tick"]))
    return points[:3]


def _conversation_clusters(run_id: str) -> list[dict]:
    """Louvain communities over the follow graph, named by their agent handles."""
    try:
        from app.analytics.network import communities, graph_for_run
        g = graph_for_run(run_id, None)
        comms = communities(g)
    except Exception:
        return []
    agents = {a["id"]: dict(a) for a in db.query(
        "SELECT id, handle FROM agents WHERE run_id=?", (run_id,))}
    out = []
    for c in comms[:5]:
        out.append({"size": c["size"], "nodes": sorted(c["nodes"]),
                    "handles": [agents.get(n, {}).get("handle") or n for n in c["nodes"][:6]]})
    return out


def _community_narratives(run_id: str, clusters: list[dict]) -> list[dict]:
    """For each cluster: TF-IDF top terms over that community's own posts + its
    most-engaged post. Purely counted from recorded text; no generation."""
    if not clusters:
        return []
    cluster_of = {n: i for i, c in enumerate(clusters) for n in c["nodes"]}
    per = [{"tf": {}, "total": 0, "top": None} for _ in clusters]
    rows = db.query(
        "SELECT agent_id, text, likes, reposts, replies FROM posts WHERE run_id=?"
        " AND kind IN ('post', 'reply')", (run_id,))
    for r in rows:
        i = cluster_of.get(r["agent_id"])
        if i is None:
            continue
        toks = _tokens(r["text"] or "")
        p = per[i]
        if toks:
            for t in toks:
                p["tf"][t] = p["tf"].get(t, 0) + 1
            p["total"] += len(toks)
        eng = (r["likes"] or 0) + (r["reposts"] or 0) + (r["replies"] or 0)
        prev = p["top"]
        text = r["text"] or ""
        if prev is None or (eng, ) > (prev["engagement"], ) or (
                eng == prev["engagement"] and text < prev["text"]):
            p["top"] = {"engagement": eng, "agent_id": r["agent_id"], "text": text}
    docs = [p for p in per if p["total"] > 0]
    n_docs = max(1, len(docs))
    df: dict[str, int] = {}
    for p in docs:
        for t in p["tf"]:
            df[t] = df.get(t, 0) + 1
    out = []
    for i, p in enumerate(per):
        if p["total"] == 0:
            continue
        scored = [((p["tf"][t] / p["total"]) * (math.log((1 + n_docs) / (1 + df[t])) + 1), t)
                  for t in p["tf"]]
        scored.sort(key=lambda st: (-st[0], st[1]))
        terms = [t for _score, t in scored[:6]]
        out.append({"cluster_index": i, "size": clusters[i]["size"],
                    "handles": clusters[i]["handles"], "terms": terms,
                    "top_post": (p["top"]["text"][:200] if p["top"] else None)})
    return out


def _source_usage(run_id: str) -> list[dict]:
    """Which of the document's chunks the posts actually cite, with page bounds."""
    counts: dict[str, int] = {}
    for p in db.query(
            "SELECT cited_chunk_ids_json FROM posts WHERE run_id=?"
            " AND kind IN ('post', 'reply')", (run_id,)):
        for cid in db.uj(p["cited_chunk_ids_json"], []) or []:
            counts[cid] = counts.get(cid, 0) + 1
    out = []
    for cid, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:5]:
        row = db.query_one("SELECT heading, page_start, page_end FROM chunks WHERE id=?", (cid,))
        out.append({"chunk_id": cid, "citations": n,
                    "heading": row["heading"] if row else None,
                    "page_start": row["page_start"] if row else None,
                    "page_end": row["page_end"] if row else None})
    return out


def generate_report(run_id: str) -> dict:
    """Build (or rebuild) the report snapshot for a run. Any state allowed."""
    r = db.query_one("SELECT * FROM runs WHERE id=?", (run_id,))
    if r is None:
        raise ValueError(f"unknown run {run_id}")
    cfg = db.uj(r["config_json"], {}) or {}
    provider_hint = db.uj(r["provider_json"], {}) or {}
    now = datetime.now(timezone.utc).isoformat()

    n_agents = db.scalar("SELECT COUNT(*) FROM agents WHERE run_id=?", (run_id,)) or 0
    n_posts = db.scalar("SELECT COUNT(*) FROM posts WHERE run_id=?", (run_id,)) or 0
    n_sys = db.scalar("SELECT COUNT(*) FROM posts WHERE run_id=? AND kind='system'", (run_id,)) or 0
    n_fallback = db.scalar("SELECT COUNT(*) FROM posts WHERE run_id=? AND is_fallback=1",
                           (run_id,)) or 0
    n_calls = db.scalar("SELECT COUNT(*) FROM llm_calls WHERE run_id=?", (run_id,)) or 0
    n_edges = db.scalar("SELECT COUNT(*) FROM edges WHERE run_id=?", (run_id,)) or 0
    follows = db.scalar("SELECT COUNT(*) FROM edges WHERE run_id=? AND follows=1",
                        (run_id,)) or 0
    last_tick = r["last_completed_tick"] or 0

    endorsements = _endorsement_counts(run_id) if n_agents else {"pro": 0, "neutral": 0, "con": 0}
    issue_means = _last_tick_stances(run_id, last_tick) if last_tick else {}
    top = _top_posts(run_id)
    influencers = _influencers(run_id)[:3]
    shifts = _turning_points(run_id)
    clusters = _conversation_clusters(run_id)
    usage = _source_usage(run_id)
    narratives = _community_narratives(run_id, clusters)
    # One row per authored event: injected events live in kind='scheduled' rows
    # (marked fired when delivered); scenario-authored events log as kind='news'
    # WITHOUT a "live" flag. Live "news" copies of injected events are duplicates.
    sched_rows = db.query("SELECT tick, payload_json FROM events WHERE run_id=?"
                          " AND kind='scheduled' ORDER BY tick, id", (run_id,))
    briefings = [{"tick": e["tick"], "payload": db.uj(e["payload_json"], {})}
                 for e in sched_rows
                 if db.uj(e["payload_json"], {}).get("audience") not in (None, "all")]
    public_events = [{"tick": e["tick"], "payload": db.uj(e["payload_json"], {})}
                     for e in sched_rows
                     if db.uj(e["payload_json"], {}).get("audience") in (None, "all")]
    scenario_news = db.query("SELECT tick, payload_json FROM events WHERE run_id=?"
                             " AND kind='news' ORDER BY tick, id", (run_id,))
    for e in scenario_news:
        p = db.uj(e["payload_json"], {})
        if not p.get("live"):  # scenario-authored broadcast (not an injected copy)
            public_events.append({"tick": e["tick"], "payload": p})

    analytics = {
        "agents": n_agents,
        "posts": n_posts,
        "newsroom_posts": n_sys,
        "fallback_posts": n_fallback,
        "llm_calls": n_calls,
        "relationships": n_edges,
        "follows": follows,
        "pro_agents": endorsements["pro"],
        "neutral_agents": endorsements["neutral"],
        "con_agents": endorsements["con"],
        "public_events": len(public_events),
        "private_briefings": len(briefings),
        "clusters": len(clusters),
        "citation_counts": sum(u["citations"] for u in usage),
    }

    md = _report_md(r, cfg, provider_hint, analytics, issue_means, top,
                    influencers, briefings, shifts, clusters, usage, narratives)

    db.execute("INSERT OR REPLACE INTO reports(run_id, created_at, analytics_json,"
               " report_md, report_json) VALUES(?,?,?,?,?)",
               (run_id, now, db.j(analytics), md, db.j({
                   "stances_at_last_tick": issue_means, "top_posts": top,
                   "influencers": influencers, "turning_points": shifts,
                   "clusters": [{"size": c["size"], "handles": c["handles"]} for c in clusters],
                   "source_usage": usage, "narratives": narratives})))
    return {"report_md": md, "available": True, "analytics": analytics, "created_at": now}


# --- LLM executive summary (the only generated part of the report) ---------

_ESSAY_SYSTEM = (
    "You write the executive summary of a finished social-media simulation study. "
    "The user message is JSON of recorded, counted facts only: no external data exists. "
    "Write plain, precise prose grounded ONLY in those facts — never invent numbers, "
    "quotes, events or outcomes, and do not restate data that is not present. "
    "If the data for a section is empty or zero, say so briefly rather than padding. "
    "Keep any thinking brief; your message MUST END with a pure JSON object (optionally "
    "fenced) with exactly these string keys: executive_summary, opinion_shifts, "
    "emerging_narratives, influential_agents, communities, key_events, contradictions, "
    "unexpected_outcomes, limitations. Each value 1-3 sentences; keep the total under 220 words."
)

_ESSAY_LABELS: tuple[tuple[str, str], ...] = (
    ("executive_summary", "Headline"),
    ("opinion_shifts", "Where opinion moved"),
    ("emerging_narratives", "Narrative threads"),
    ("influential_agents", "Influential voices"),
    ("communities", "Communities"),
    ("key_events", "Events"),
    ("contradictions", "Contradictions"),
    ("unexpected_outcomes", "Unexpected"),
    ("limitations", "Limits"),
)


def _essay_snapshot(run_id: str, r, row) -> dict:
    """Compact JSON of counted facts only, for the essay prompt. No new queries
    beyond cheap header rows: the essay summarizes the STORED counted snapshot."""
    from app.errors import AppError
    a = db.uj(row["analytics_json"], {}) or {}
    rj = db.uj(row["report_json"], {}) or {}
    cfg = db.uj(r["config_json"], {}) or {}
    scenario = db.uj(r["scenario_json"], {}) or {}
    snap: dict = {
        "report_snapshot_utc": row["created_at"],
        "run": {"name": r["name"], "status": r["status"], "seed": r["seed"],
                "agents": cfg.get("agents"), "ticks": cfg.get("ticks"),
                "writes_per_tick": cfg.get("writes_per_tick"),
                "feedback": cfg.get("backfire"), "inject_events": cfg.get("inject_events")},
        "question": (scenario.get("question") or "")[:400],
        "counted": {k: a.get(k) for k in
                    ("agents", "posts", "newsroom_posts", "fallback_posts", "llm_calls",
                     "relationships", "follows", "pro_agents", "neutral_agents", "con_agents",
                     "public_events", "private_briefings", "clusters", "citation_counts")},
    }
    if rj.get("stances_at_last_tick"):
        snap["stance_at_last_completed_tick"] = {
            k: round(v, 3) for k, v in rj["stances_at_last_tick"].items()}
    if rj.get("turning_points"):
        snap["biggest_opinion_shifts"] = [
            {k: p[k] for k in ("issue_id", "tick", "from", "to", "delta")}
            for p in rj["turning_points"][:3]]
    if rj.get("clusters"):
        snap["conversation_clusters"] = [
            {"size": c["size"], "agents": [f"@{h}" for h in c["handles"][:4]]}
            for c in rj["clusters"][:4]]
    if rj.get("narratives"):
        snap["community_terms"] = [
            {"who": [f"@{h}" for h in nv["handles"][:3]], "terms": nv["terms"],
             "top_post": (nv.get("top_post") or "")[:140]}
            for nv in rj["narratives"][:4]]
    if rj.get("top_posts"):
        snap["top_posts"] = [
            {"tick": p.get("tick"), "agent": f"@{p.get('handle')}" if p.get("handle") else p.get("agent_id"),
             "engagement": p.get("engagement"), "text": (p.get("text") or "")[:160]}
            for p in rj["top_posts"][:3]]
    if rj.get("source_usage"):
        snap["cited_sources"] = [
            {"heading": u.get("heading") or "(no heading recorded)",
             "pages": f"{u.get('page_start')}-{u.get('page_end')}",
             "citations": u.get("citations")} for u in rj["source_usage"][:4]]
    return snap


async def generate_essay_report(run_id: str) -> dict:
    """Write (or rewrite) the report's executive summary with the configured
    provider through the gateway. One call, recorded in llm_calls; NOT counted
    against the run's simulation budget (operator action after the run)."""
    from app.llm.gateway import gateway
    from app.sim.models import EssayOut

    r = db.query_one("SELECT * FROM runs WHERE id=?", (run_id,))
    if r is None:
        raise ValueError(f"unknown run {run_id}")
    row = db.query_one(
        "SELECT created_at, analytics_json, report_json FROM reports WHERE run_id=?", (run_id,))
    if row is None:
        raise ValueError("no counted report yet: generate the report before asking for a summary")

    snap = _essay_snapshot(run_id, r, row)
    messages = [{"role": "system", "content": _ESSAY_SYSTEM},
                {"role": "user", "content": db.j(snap)}]
    res = await gateway.complete("essay", messages, expect=EssayOut,
                                 run_id=run_id, check_budget=False)
    now = datetime.now(timezone.utc).isoformat()
    meta = {"provider": res.provider or "", "model": res.model or "",
            "from_cache": res.from_cache, "created_at": now,
            "report_created_at": row["created_at"],
            "latency_ms": res.latency_ms, "attempts": res.attempts}
    sections = res.parsed.model_dump() if isinstance(res.parsed, EssayOut) else {}
    db.execute("UPDATE reports SET essay_json=?, essay_meta_json=? WHERE run_id=?",
               (db.j(sections), db.j(meta), run_id))
    return {"essay": {"sections": sections, "meta": meta},
            "run_llm_calls_used": db.scalar("SELECT llm_calls_used FROM runs WHERE id=?",
                                            (run_id,))}


def essay_markdown(meta: dict, sections: dict) -> str:
    """Render the stored essay as labeled markdown with an honesty header.
    Used by the md/csv exports so any essay leaves with its label attached."""
    how = "cache hit \u2014 no new call" if meta.get("from_cache") else "1 new LLM call"
    when = str(meta.get("created_at") or "")[:19].replace("T", " ")
    pinned = str(meta.get("report_created_at") or "")[:19].replace("T", " ")
    lines = ["## Executive summary (LLM draft \u2014 generated, not counted data)", "",
             f"Provider {meta.get('provider') or '?'}/{meta.get('model') or '?'} \u00b7 \u2014 {when} UTC \u00b7 {how}"
             f" \u00b7 pinned to counted snapshot {pinned} UTC", ""]
    for key, label in _ESSAY_LABELS:
        v = str(sections.get(key) or "").strip()
        if v:
            lines += [f"**{label}:** {v}", ""]
    return "\n".join(lines).rstrip()


def _fmt_engagement(nodes: list[dict]) -> str:
    parts = []
    for n in nodes[:3]:
        parts.append(f"@{n.get('handle') or n.get('agent_id')} "
                     f"(pagerank {n.get('pagerank', 0):.3f}, {n.get('followers', 0)} followers)")
    return "\n".join(f"- {p}" for p in parts) if nodes else "- —"


def _report_md(r, cfg: dict, provider_hint: dict, a: dict, issue_means: dict,
               top: list[dict], influencers: list[dict], briefings: list[dict],
               shifts: list[dict] | None = None, clusters: list[dict] | None = None,
               usage: list[dict] | None = None, narratives: list[dict] | None = None) -> str:
    started = r["started_at"] or "—"
    finished = r["finished_at"] or "—"
    lines = [
        f"# Simulation report — {r['name']}",
        "",
        f"- **Status**: `{r['status']}` · **Seed**: `{r['seed']}` · **Provider**: "
        f"`{provider_hint.get('name') or 'n/a'} / {provider_hint.get('model') or 'n/a'}`",
        f"- **Window**: {started} → {finished} (UTC)",
        f"- **World**: {a['agents']} agents · ticks {cfg.get('ticks')} · "
        f"writes/tick {cfg.get('writes_per_tick')}",
        "",
        "## Question",
        "",
        (db.uj(r["scenario_json"], {}) or {}).get("question") or "_(none recorded)_",
        "",
        "## Where opinion landed (last completed tick)",
        "",
    ]
    if issue_means:
        for iid, v in issue_means.items():
            lines.append(f"- **{iid}**: mean stance {v:+.2f} — {a['pro_agents']} agents lean "
                         f"pro, {a['neutral_agents']} neutral, {a['con_agents']} lean con")
    else:
        lines.append("- No completed ticks to read opinion from.")
    lines += [
        "",
        "## What happened",
        "",
        f"- {a['posts']} posts recorded ({a['newsroom_posts']} newsroom, "
        f"{a['fallback_posts']} fallback templates when the call budget ran out)",
        f"- {a['relationships']} recorded relationships ({a['follows']} active follows)",
        f"- {a['public_events']} public events · {a['private_briefings']} private briefings",
    ]
    if briefings:
        for e in briefings:
            p = e["payload"]
            lines.append(f"  - Private briefing → “{p.get('audience')}” (tick {e['tick']}):"
                         f" {p.get('text', '')[:100]}")
    if shifts:
        lines += ["", "## Biggest opinion shifts (turning points)", ""]
        for s in shifts:
            arrow = "+" if s["delta"] >= 0 else "−"
            lines.append(f"- **{s['issue_id']}** at tick {s['tick']}: mean moved "
                         f"{s['from']:+.2f} → {s['to']:+.2f} ({arrow}{abs(s['delta']):.2f})")
    if clusters:
        lines += ["", "## Conversation clusters (Louvain communities)", ""]
        for c in clusters:
            who = ", ".join(f"@{h}" for h in c["handles"])
            lines.append(f"- {c['size']} agents: {who}")
    if narratives:
        lines += ["", "## What each cluster talked about (TF-IDF over its own posts)", ""]
        for nv in narratives:
            who = ", ".join(f"@{h}" for h in nv["handles"][:3])
            terms = ", ".join(nv["terms"]) if nv["terms"] else "—"
            quote = f" — “{nv['top_post'][:120]}”" if nv.get("top_post") else ""
            lines.append(f"- {who}: {terms}{quote}")
    if usage:
        lines += ["", "## What the agents leaned on (source usage)", ""]
        for u in usage:
            title = u.get("heading") or u.get("chunk_id")
            pages = f", pages {u['page_start']}–{u['page_end']}" if u.get("page_start") else ""
            lines.append(f"- “{title}”{pages} — cited {u['citations']}×"
                         f" ({u['chunk_id']})")
    if influencers:
        lines += ["", "## Most-connected agents", "",
                  _fmt_engagement(influencers)]
    if top:
        lines += ["", "## Most-engaged posts", ""]
        for p in top:
            lines.append(f"- tick {p['tick']} @{p['handle']} ({p['engagement']} interactions):"
                         f" “{p['text']}”")
    lines += [
        "",
        "---",
        "",
        "_Every count in this report was computed from this run's recorded database rows."
        " No AI wrote it. Export the full raw bundle as JSON/CSV for deeper analysis._",
    ]
    return "\n".join(lines)
