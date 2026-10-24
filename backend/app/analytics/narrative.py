"""Narrative findings: plain-language interpretation computed from counted rows.

Every sentence this module produces is derived from a number that exists in the
database for this run. There is no model call here and no invented content: the
text is deterministic given the rows, which is what makes it safe to present as
analysis rather than speculation.

If a statement cannot be supported the module says so ("Not enough evidence")
instead of producing a plausible-sounding claim.
"""
from __future__ import annotations

from datetime import datetime, timezone
from statistics import mean
from typing import Any, Optional

from app import db

# Thresholds are named so the UI and the report describe the same rule.
PRO = 0.15
CON = -0.15
STRONG_DELTA = 0.25
NOTABLE_DELTA = 0.10


def _f(v: Optional[float]) -> Optional[float]:
    return None if v is None else round(float(v), 3)


def _pct(n: float, d: float) -> Optional[int]:
    if not d:
        return None
    return round(100.0 * n / d)


def _mean(vals: list[float]) -> Optional[float]:
    return round(mean(vals), 3) if vals else None


def _label(share: Optional[float]) -> str:
    if share is None:
        return "unknown"
    if share >= 0.6:
        return "strongly"
    if share >= 0.45:
        return "moderately"
    if share >= 0.3:
        return "mildly"
    return "weakly"


def _stance_word(v: Optional[float]) -> str:
    if v is None:
        return "no recorded position"
    if v >= 0.5:
        return "strongly supportive"
    if v >= PRO:
        return "supportive"
    if v <= -0.5:
        return "strongly opposed"
    if v <= CON:
        return "opposed"
    return "undecided"


def _strength(sample: int, spread: Optional[float]) -> str:
    """How much weight a finding can bear, from sample size and agreement."""
    if sample >= 40 and (spread is None or spread < 0.5):
        return "strong"
    if sample >= 12:
        return "moderate"
    return "indicative"


def _strength_reason(sample: int, spread: Optional[float]) -> str:
    parts = [f"{sample} recorded observation{'s' if sample != 1 else ''}"]
    if spread is not None:
        parts.append(f"stance spread {spread:.2f} on a −1…+1 scale")
    return "; ".join(parts) + ". This is a strength-of-evidence label, not a probability."


def _load(run_id: str) -> dict:
    run = db.query_one("SELECT * FROM runs WHERE id=?", (run_id,))
    if run is None:
        raise ValueError(f"unknown run {run_id}")
    src_id = run["source_id"]
    source = db.query_one("SELECT * FROM sources WHERE id=?", (src_id,)) if src_id else None
    brief = db.uj(source["brief_json"], {}) if source and source["brief_json"] else {}
    agents = [dict(a) for a in db.query(
        "SELECT id, handle, name, bio, archetype, stakeholder_group, stances_json,"
        " state_json, belief_summary FROM agents WHERE run_id=? ORDER BY id", (run_id,))]
    for a in agents:
        a["stances"] = db.uj(a["stances_json"], {}) or {}
        a["group"] = a.get("stakeholder_group") or "Unassigned"
    posts = [dict(p) for p in db.query(
        "SELECT id, tick, agent_id, kind, text, stance_json, cited_chunk_ids_json,"
        " likes, reposts, replies FROM posts WHERE run_id=? ORDER BY tick, seq", (run_id,))]
    for p in posts:
        p["stance"] = db.uj(p["stance_json"], {}) or {}
        p["cited"] = db.uj(p["cited_chunk_ids_json"], []) or []
    history = [dict(h) for h in db.query(
        "SELECT tick, agent_id, issue_id, value FROM stance_history WHERE run_id=?"
        " ORDER BY tick, agent_id, issue_id", (run_id,))]
    changes = [dict(c) for c in db.query(
        "SELECT tick, agent_id, issue_id, before_value, after_value, trigger_kind,"
        " trigger_post_id, note FROM stance_changes WHERE run_id=? ORDER BY tick", (run_id,))]
    chunks = {c["id"]: dict(c) for c in db.query(
        "SELECT id, idx, page_start, page_end, heading, text FROM chunks WHERE source_id=?",
        (src_id,))} if src_id else {}
    edges = [dict(e) for e in db.query(
        "SELECT src, dst, weight, interactions FROM edges WHERE run_id=?", (run_id,))]
    return {
        "run": dict(run), "source": dict(source) if source else None, "brief": brief or {},
        "agents": agents, "posts": posts, "history": history, "changes": changes,
        "chunks": chunks, "edges": edges,
        "cfg": db.uj(run["config_json"], {}) or {},
    }


def _series_key(tick: int, agent: str, issue: str) -> tuple[int, str, str]:
    return (tick, agent, issue)


def _initial_final(history: list[dict]) -> tuple[dict, dict]:
    """First and last recorded value per (agent, issue)."""
    first: dict[tuple[str, str], float] = {}
    last: dict[tuple[str, str], float] = {}
    for h in history:
        key = (h["agent_id"], h["issue_id"])
        if key not in first:
            first[key] = float(h["value"] or 0.0)
        last[key] = float(h["value"] or 0.0)
    return first, last


def _group_of(agents: list[dict]) -> dict[str, str]:
    return {a["id"]: a["group"] for a in agents}


def _post_stance_on(p: dict, issue_id: str) -> Optional[float]:
    st = (p.get("stance") or {}).get(issue_id)
    if isinstance(st, dict):
        return float(st.get("value") or 0.0)
    return None


def _evidence_for_issue(posts: list[dict], issue_id: str, chunks: dict,
                        limit: int = 3) -> list[dict]:
    counts: dict[str, int] = {}
    for p in posts:
        v = _post_stance_on(p, issue_id)
        if v is None or abs(v) < PRO:
            continue
        for cid in p["cited"]:
            counts[cid] = counts.get(cid, 0) + 1
    out = []
    for cid, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]:
        c = chunks.get(cid) or {}
        out.append({"chunk_id": cid, "citations": n,
                    "page_start": c.get("page_start"), "page_end": c.get("page_end"),
                    "heading": c.get("heading"),
                    "excerpt": (c.get("text") or "")[:220]})
    return out


def _top_agents_for_issue(posts: list[dict], agents: list[dict], issue_id: str,
                          limit: int = 3) -> list[dict]:
    per: dict[str, list[float]] = {}
    for p in posts:
        v = _post_stance_on(p, issue_id)
        if v is None:
            continue
        per.setdefault(p["agent_id"], []).append(v)
    by_id = {a["id"]: a for a in agents}
    rows = []
    for aid, vals in per.items():
        a = by_id.get(aid)
        if not a:
            continue
        rows.append({"agent_id": aid, "handle": a.get("handle"), "name": a.get("name"),
                     "group": a["group"], "posts": len(vals),
                     "mean_stance": round(mean(vals), 3)})
    rows.sort(key=lambda r: (-r["posts"], abs(r["mean_stance"])))
    return rows[:limit]


def _issue_section(issue: dict, data: dict) -> dict:
    iid = issue["id"]
    agents = data["agents"]
    posts = data["posts"]
    first, last = _initial_final(data["history"])
    group_of = _group_of(agents)

    pairs = [(first.get((a["id"], iid)), last.get((a["id"], iid))) for a in agents]
    initial_vals = [p[0] for p in pairs if p[0] is not None]
    final_vals = [p[1] for p in pairs if p[1] is not None]
    initial_mean = _mean(initial_vals)
    final_mean = _mean(final_vals)
    delta = (None if initial_mean is None or final_mean is None
             else round(final_mean - initial_mean, 3))

    pro = sum(1 for v in final_vals if v >= PRO)
    con = sum(1 for v in final_vals if v <= CON)
    neu = len(final_vals) - pro - con
    spread = (round(max(final_vals) - min(final_vals), 3) if final_vals else None)

    # Per-group final position and movement.
    by_group: dict[str, list[float]] = {}
    by_group_delta: dict[str, list[float]] = {}
    for a in agents:
        f = last.get((a["id"], iid))
        if f is not None:
            by_group.setdefault(a["group"], []).append(f)
        i0 = first.get((a["id"], iid))
        if i0 is not None and f is not None:
            by_group_delta.setdefault(a["group"], []).append(f - i0)
    groups = []
    for g in (data["brief"].get("stakeholder_groups") or []):
        name = g.get("name")
        vals = by_group.get(name) or []
        dl = by_group_delta.get(name) or []
        groups.append({
            "name": name,
            "agents": len(vals),
            "final_mean": _mean(vals),
            "delta": _mean(dl),
            "position": ("support" if vals and mean(vals) >= PRO
                         else "oppose" if vals and mean(vals) <= CON
                         else "undecided"),
            "influence": g.get("influence"),
        })

    supporters = [g["name"] for g in groups if g["position"] == "support"]
    opponents = [g["name"] for g in groups if g["position"] == "oppose"]
    undecided = [g["name"] for g in groups if g["position"] == "undecided"]

    # What moved it: count the recorded triggers for this issue.
    triggers: dict[str, int] = {}
    for c in data["changes"]:
        if c["issue_id"] != iid:
            continue
        kind = c.get("trigger_kind") or "unrecorded"
        triggers[kind] = triggers.get(kind, 0) + 1

    movement = []
    for g in sorted(groups, key=lambda x: -(abs(x["delta"] or 0))):
        if g["delta"] is not None and abs(g["delta"]) >= NOTABLE_DELTA:
            movement.append({
                "group": g["name"],
                "delta": g["delta"],
                "direction": "towards support" if g["delta"] > 0 else "towards opposition",
            })

    return {
        "issue_id": iid,
        "name": issue.get("name") or iid,
        "question": issue.get("question") or "",
        "category": issue.get("category"),
        "initial_mean": initial_mean,
        "final_mean": final_mean,
        "delta": delta,
        "spread": spread,
        "pro_agents": pro,
        "neutral_agents": neu,
        "con_agents": con,
        "observed_agents": len(final_vals),
        "supporters": supporters,
        "opponents": opponents,
        "undecided": undecided,
        "groups": sorted(groups, key=lambda g: -(g["final_mean"] or 0)),
        "movement": movement,
        "triggers": triggers,
        "evidence": _evidence_for_issue(posts, iid, data["chunks"]),
        "top_agents": _top_agents_for_issue(posts, agents, iid),
        "strength": _strength(len(final_vals), spread),
        "strength_reason": _strength_reason(len(final_vals), spread),
    }


def _stakeholder_section(g: dict, data: dict, issues: list[dict], first: dict,
                         last: dict) -> dict:
    name = g.get("name")
    agents = [a for a in data["agents"] if a["group"] == name]
    issue_ids = [i["id"] for i in issues]
    initial_vals, final_vals, deltas = [], [], []
    per_issue = []
    for iid in issue_ids:
        iv = [first.get((a["id"], iid)) for a in agents]
        fv = [last.get((a["id"], iid)) for a in agents]
        iv = [v for v in iv if v is not None]
        fv = [v for v in fv if v is not None]
        if not fv:
            continue
        per_issue.append({"issue_id": iid, "initial": _mean(iv), "final": _mean(fv),
                          "delta": (None if not iv else round(mean(fv) - mean(iv), 3)),
                          "agents": len(fv)})
        initial_vals.extend(iv)
        final_vals.extend(fv)
        deltas.extend([f - i for i, f in zip(iv, fv)])

    posts_by_agent: dict[str, int] = {}
    for p in data["posts"]:
        posts_by_agent[p["agent_id"]] = posts_by_agent.get(p["agent_id"], 0) + 1
    reps = sorted(agents, key=lambda a: -posts_by_agent.get(a["id"], 0))[:3]

    degree: dict[str, int] = {}
    for e in data["edges"]:
        degree[e["src"]] = degree.get(e["src"], 0) + 1
    group_degree = sum(degree.get(a["id"], 0) for a in agents)
    network_role = ("central" if group_degree >= 3 * max(1, len(agents))
                    else "connected" if group_degree > 0 else "peripheral")

    priority = sorted(per_issue, key=lambda x: -(abs(x["final"] or 0)))[:2]
    return {
        "name": name,
        "description": g.get("description") or "",
        "agents": len(agents),
        "influence": g.get("influence"),
        "institutional_power": g.get("institutional_power"),
        "trust_level": g.get("trust_level"),
        "initial_mean": _mean(initial_vals),
        "final_mean": _mean(final_vals),
        "delta": _mean(deltas),
        "per_issue": per_issue,
        "priority_issues": [p["issue_id"] for p in priority],
        "concerns": g.get("concerns") or [],
        "interests": g.get("interests") or [],
        "representatives": [{"agent_id": a["id"], "handle": a.get("handle"),
                             "name": a.get("name"),
                             "posts": posts_by_agent.get(a["id"], 0)} for a in reps],
        "network_role": network_role,
        "strength": _strength(len(final_vals), None),
        "strength_reason": _strength_reason(len(final_vals), None),
    }


def build_narrative(run_id: str) -> dict:
    data = _load(run_id)
    run, cfg, brief = data["run"], data["cfg"], data["brief"]
    issues = brief.get("issues") or []
    groups = brief.get("stakeholder_groups") or []
    agents, posts = data["agents"], data["posts"]
    first, last = _initial_final(data["history"])

    issue_sections = [_issue_section(i, data) for i in issues]
    stakeholder_sections = [_stakeholder_section(g, data, issues, first, last)
                            for g in groups]

    total_stance = len(last)
    overall_final = _mean(list(last.values()))
    overall_initial = _mean(list(first.values()))
    overall_delta = (None if overall_initial is None or overall_final is None
                     else round(overall_final - overall_initial, 3))
    sourced = [p for p in posts if p["cited"]]
    cited_chunks = {c for p in sourced for c in p["cited"]}
    fallback_posts = sum(1 for p in posts if p.get("is_fallback"))

    # --- key findings, chosen deterministically from the data -----------------
    findings: list[dict] = []

    moved = [s for s in issue_sections if s["delta"] is not None]
    biggest = max(moved, key=lambda s: abs(s["delta"]), default=None) if moved else None
    if biggest and abs(biggest["delta"]) >= NOTABLE_DELTA:
        direction = "towards support" if biggest["delta"] > 0 else "towards opposition"
        findings.append({
            "id": "biggest_shift",
            "headline": f"Opinion on “{biggest['name']}” moved {direction}",
            "explanation": (
                f"Across {biggest['observed_agents']} agents the mean position on "
                f"“{biggest['name']}” moved from {biggest['initial_mean']:+.2f} to "
                f"{biggest['final_mean']:+.2f} — a change of {biggest['delta']:+.2f} on a "
                f"−1…+1 scale. "
                + (f"The largest movement came from {biggest['movement'][0]['group']} "
                   f"({biggest['movement'][0]['delta']:+.2f}). "
                   if biggest["movement"] else "")
                + (f"{len(biggest['supporters'])} group(s) ended supportive and "
                   f"{len(biggest['opponents'])} ended opposed."
                   if biggest["supporters"] or biggest["opponents"]
                   else "No group ended clearly on one side.")
            ),
            "why_it_matters": (
                "This is the issue where the simulated conversation changed minds most. "
                "It is the best place to look for what the population found persuasive."),
            "strength": biggest["strength"],
            "strength_reason": biggest["strength_reason"],
            "issue_ids": [biggest["issue_id"]],
            "groups": [g["name"] for g in biggest["groups"] if g["agents"]],
            "agents": [a["handle"] for a in biggest["top_agents"] if a.get("handle")],
            "data": [{"label": "Mean stance at first round", "value": f"{biggest['initial_mean']:+.2f}"},
                     {"label": "Mean stance at last round", "value": f"{biggest['final_mean']:+.2f}"},
                     {"label": "Change", "value": f"{biggest['delta']:+.2f}"}],
            "evidence": biggest["evidence"],
            "post_ids": [],
        })

    polar = [s for s in issue_sections if s["spread"] is not None]
    most_split = max(polar, key=lambda s: s["spread"], default=None) if polar else None
    if most_split and (most_split["spread"] or 0) >= 0.8:
        findings.append({
            "id": "most_contested",
            "headline": f"“{most_split['name']}” stayed the most contested issue",
            "explanation": (
                f"Final positions ranged {most_split['spread']:.2f} points apart on this "
                f"issue — from strongly opposed to strongly supportive. "
                f"{most_split['pro_agents']} agents ended supportive, "
                f"{most_split['con_agents']} opposed and {most_split['neutral_agents']} "
                "undecided. The population did not converge."),
            "why_it_matters": (
                "Contested issues are where a real consultation would need the most work; "
                "they are also where this simulation is least able to predict an outcome."),
            "strength": most_split["strength"],
            "strength_reason": most_split["strength_reason"],
            "issue_ids": [most_split["issue_id"]],
            "groups": [g["name"] for g in most_split["groups"] if g["agents"]],
            "agents": [a["handle"] for a in most_split["top_agents"] if a.get("handle")],
            "data": [{"label": "Spread between most pro and most con agent",
                      "value": f"{most_split['spread']:.2f}"},
                     {"label": "Support / undecided / oppose",
                      "value": f"{most_split['pro_agents']} / {most_split['neutral_agents']} / {most_split['con_agents']}"}],
            "evidence": most_split["evidence"],
            "post_ids": [],
        })

    active_groups = [s for s in stakeholder_sections if s["agents"] > 0 and s["delta"] is not None]
    biggest_group = max(active_groups, key=lambda s: abs(s["delta"]), default=None)
    if biggest_group and abs(biggest_group["delta"]) >= NOTABLE_DELTA:
        findings.append({
            "id": "group_movement",
            "headline": f"{biggest_group['name']} shifted most of any stakeholder group",
            "explanation": (
                f"This group's average position moved {biggest_group['delta']:+.2f} across "
                f"the simulation, ending at {biggest_group['final_mean']:+.2f}. "
                f"It is represented by {biggest_group['agents']} agent(s) and its network "
                f"role is {biggest_group['network_role']}."),
            "why_it_matters": (
                "A group that moves together suggests a shared reaction to the same evidence "
                "or to each other. Groups that do not move are equally informative."),
            "strength": biggest_group["strength"],
            "strength_reason": biggest_group["strength_reason"],
            "issue_ids": biggest_group["priority_issues"],
            "groups": [biggest_group["name"]],
            "agents": [r["handle"] for r in biggest_group["representatives"] if r["handle"]],
            "data": [{"label": "Group mean at first round",
                      "value": f"{biggest_group['initial_mean']:+.2f}" if biggest_group["initial_mean"] is not None else "—"},
                     {"label": "Group mean at last round",
                      "value": f"{biggest_group['final_mean']:+.2f}" if biggest_group["final_mean"] is not None else "—"},
                     {"label": "Agents in group", "value": str(biggest_group["agents"])}],
            "evidence": [],
            "post_ids": [],
        })

    if sourced:
        coverage = _pct(len(sourced), len(posts))
        findings.append({
            "id": "evidence_use",
            "headline": "Every claim was tied back to the source document"
            if (coverage or 0) >= 99 else
            ("Most claims were tied back to the source document"
             if (coverage or 0) >= 50 else "Many posts were not tied to the source document"),
            "explanation": (
                f"{len(sourced)} of {len(posts)} posts ({coverage}%) cited at least one "
                f"passage, drawing on {len(cited_chunks)} distinct chunk(s) of the source. "
                "A post without a citation is the agent's own framing rather than a "
                "document-grounded claim."),
            "why_it_matters": (
                "Evidence coverage is what makes the findings traceable. Lower coverage means "
                "more of the conversation is persona behaviour rather than document response."),
            "strength": _strength(len(posts), None),
            "strength_reason": _strength_reason(len(posts), None),
            "issue_ids": [],
            "groups": [],
            "agents": [],
            "data": [{"label": "Posts citing a source passage", "value": f"{len(sourced)} / {len(posts)}"},
                     {"label": "Distinct passages used", "value": str(len(cited_chunks))}],
            "evidence": [],
            "post_ids": [],
        })

    # When nothing moved, stability IS the finding — say it rather than showing an
    # almost-empty page. This is a counted statement about the recorded series.
    if len(findings) < 3 and moved:
        stable = [s for s in moved if abs(s["delta"]) < NOTABLE_DELTA]
        if stable:
            findings.append({
                "id": "stability",
                "headline": "Positions held steady across the run",
                "explanation": (
                    f"{len(stable)} of {len(moved)} issues changed by less than 0.10 on the "
                    "−1…+1 stance scale. The conversation produced activity without "
                    "rearranging the population's positions."),
                "why_it_matters": (
                    "Stable opinion under argument is itself a result: it suggests the "
                    "positions were firmly held, or that the discussion did not introduce "
                    "persuasive new evidence."),
                "strength": _strength(total_stance, None),
                "strength_reason": _strength_reason(total_stance, None),
                "issue_ids": [s["issue_id"] for s in stable[:5]],
                "groups": [g["name"] for g in stakeholder_sections if g["agents"]],
                "agents": [],
                "data": [{"label": "Issues with a change under 0.10", "value": f"{len(stable)} of {len(moved)}"},
                         {"label": "Stance observations recorded", "value": str(total_stance)}],
                "evidence": [],
                "post_ids": [],
            })

    # Network structure is a finding in its own right: it explains how far ideas could travel.
    if data["edges"] and agents:
        per_agent = len(data["edges"]) / len(agents)
        findings.append({
            "id": "network",
            "headline": "The population formed a connected discussion network",
            "explanation": (
                f"{len(data['edges'])} directed relationships connect {len(agents)} agents — "
                f"about {per_agent:.1f} per agent. Ideas could travel across the population "
                "rather than staying inside isolated pairs."),
            "why_it_matters": (
                "Opinion change depends on who sees whom. A sparse network limits how far "
                "one agent's argument can spread, so this bounds what the run can show."),
            "strength": _strength(len(agents), None),
            "strength_reason": _strength_reason(len(agents), None),
            "issue_ids": [],
            "groups": [g["name"] for g in stakeholder_sections if g["agents"]],
            "agents": [],
            "data": [{"label": "Relationships", "value": str(len(data["edges"]))},
                     {"label": "Per agent", "value": f"{per_agent:.1f}"}],
            "evidence": [],
            "post_ids": [],
        })

    if fallback_posts:
        findings.append({
            "id": "fallbacks",
            "headline": "Some posts fell back to deterministic templates",
            "explanation": (
                f"{fallback_posts} post(s) were produced by the fallback path rather than the "
                "provider. They are still counted, but the prose is templated."),
            "why_it_matters": (
                "Fallback posts preserve the run's structure but should not be read as model "
                "reasoning."),
            "strength": "indicative",
            "strength_reason": "A count of recorded fallback flags, not an estimate.",
            "issue_ids": [], "groups": [], "agents": [],
            "data": [{"label": "Fallback posts", "value": str(fallback_posts)}],
            "evidence": [], "post_ids": [],
        })

    findings = findings[:5]

    # --- timeline ------------------------------------------------------------
    timeline = []
    for c in data["changes"]:
        if abs(float(c["after_value"]) - float(c["before_value"])) < STRONG_DELTA:
            continue
        a = next((x for x in agents if x["id"] == c["agent_id"]), None)
        issue = next((i for i in issues if i["id"] == c["issue_id"]), None)
        timeline.append({
            "tick": c["tick"],
            "kind": "stance_change",
            "label": f"{a['name'] if a else c['agent_id']} moved on {issue['name'] if issue else c['issue_id']}",
            "detail": (f"{float(c['before_value']):+.2f} → {float(c['after_value']):+.2f} "
                       f"({c.get('trigger_kind') or 'unrecorded trigger'})"),
        })
    timeline = sorted(timeline, key=lambda t: t["tick"])[:12]

    # --- answers to the eight questions --------------------------------------
    strongest = max(issue_sections, key=lambda s: s["final_mean"] or -9, default=None)
    weakest = min(issue_sections, key=lambda s: s["final_mean"] or 9, default=None)
    movers = sorted(issue_sections, key=lambda s: -(abs(s["delta"] or 0)))[:2]
    movers = [m for m in movers if m["delta"] is not None and abs(m["delta"]) >= NOTABLE_DELTA]

    def _names(xs: list[str]) -> str:
        if not xs:
            return "no group"
        if len(xs) == 1:
            return xs[0]
        return ", ".join(xs[:-1]) + " and " + xs[-1]

    answers = {
        "what_happened": (
            f"The simulation ran {run['last_completed_tick']} of {cfg.get('ticks')} rounds with "
            f"{len(agents)} agents and produced {len(posts)} posts. The overall mean stance "
            f"ended at {overall_final:+.2f} on a −1…+1 scale"
            + (" and was effectively unchanged from the opening round."
               if overall_delta is not None and abs(overall_delta) < 0.05
               else f", a change of {overall_delta:+.2f} from the start."
               if overall_delta is not None else ".")
        ) if overall_final is not None else "Not enough evidence: no stance history was recorded.",
        "why": (
            ("The largest recorded movements came from " +
             ", ".join(f"“{m['name']}” ({m['delta']:+.2f})" for m in movers) + ". ")
            if movers else "No issue moved enough to attribute a cause. "
        ) + (
            "Stance changes are recorded with their trigger where the engine attributed one; "
            "unattributed changes are not explained here."),
        "who_drove_it": (
            _names([g["name"] for g in stakeholder_sections
                    if g["agents"] and abs(g["delta"] or 0) >= NOTABLE_DELTA])
            + " showed the largest movement between rounds."
            if any(abs(g["delta"] or 0) >= NOTABLE_DELTA for g in stakeholder_sections)
            else "No stakeholder group moved enough to be singled out."),
        "what_evidence": (
            f"{len(cited_chunks)} distinct source passage(s) were cited across "
            f"{len(sourced)} of {len(posts)} posts."
            if posts else "No posts recorded yet."),
        "agreement": (
            f"“{strongest['name']}” drew the most support (mean {strongest['final_mean']:+.2f}), "
            f"with {len(strongest['supporters'])} group(s) ending supportive."
            if strongest and strongest["final_mean"] is not None and strongest["supporters"]
            else "No issue reached clear agreement across groups."),
        "disagreement": (
            f"“{most_split['name']}” stayed split (spread {most_split['spread']:.2f}); "
            f"{most_split['con_agents']} agent(s) ended opposed while "
            f"{most_split['pro_agents']} ended supportive."
            if most_split and most_split["spread"] is not None
            else "No issue showed a wide spread in final positions."),
        "what_changed": (
            (f"{len(movers)} issue(s) moved by 0.10 or more. " if movers else "No issue moved by 0.10 or more. ")
            + (f"The biggest was “{movers[0]['name']}” at {movers[0]['delta']:+.2f}."
               if movers else "Positions were largely stable across the run.")),
        "watch": (
            (f"Watch “{weakest['name']}” — it ended least supportive "
             f"({weakest['final_mean']:+.2f}) and is the likeliest source of resistance."
             if (weakest["final_mean"] or 0) < PRO else
             f"Nothing is in outright opposition: the weakest issue, “{weakest['name']}”, still "
             f"ended slightly positive ({weakest['final_mean']:+.2f}). The risk here is "
             "indifference rather than resistance — a population that does not engage is as "
             "hard to read as one that objects.")
            if weakest and weakest["final_mean"] is not None
            else "There is not enough recorded data to flag a specific risk."),
    }

    uncertainty = [
        "Agents are generated personas. Their reactions are plausible under the configured "
        "rules, not observed human behaviour.",
        "Stance updates use bounded-confidence heuristics that were not fitted to survey data.",
    ]
    if len(posts) < 20:
        uncertainty.append(
            f"Only {len(posts)} posts were recorded. Findings based on small samples are "
            "indicative and may not reproduce with a different seed.")
    if any(s["agents"] == 0 for s in stakeholder_sections):
        missing = [s["name"] for s in stakeholder_sections if s["agents"] == 0]
        uncertainty.append(
            "These configured groups received no agents and therefore contributed nothing to "
            "the result: " + ", ".join(missing) + ".")
    if fallback_posts:
        uncertainty.append(
            f"{fallback_posts} post(s) came from the deterministic fallback path rather than "
            "the provider.")
    if not cited_chunks:
        uncertainty.append(
            "No post cited the source document, so these findings are not grounded in the "
            "uploaded material.")

    return {
        "run_id": run_id,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "provenance": {
            "kind": "computed",
            "method": ("Derived from recorded rows only: agents, stance_history, posts, "
                       "stance_changes, edges and chunks. No model call produced this text."),
            "predictive_accuracy": "not_validated",
        },
        "scale": {
            "agents": len(agents),
            "posts": len(posts),
            "rounds_completed": run["last_completed_tick"] or 0,
            "rounds_configured": cfg.get("ticks"),
            "issues": len(issues),
            "groups": len(groups),
            "stance_observations": total_stance,
            "overall_initial": overall_initial,
            "overall_final": overall_final,
            "overall_delta": overall_delta,
            "posts_with_source": len(sourced),
            "distinct_chunks_cited": len(cited_chunks),
        },
        "answers": answers,
        "key_findings": findings,
        "issues": issue_sections,
        "stakeholders": stakeholder_sections,
        "timeline": timeline,
        "uncertainty": uncertainty,
    }
