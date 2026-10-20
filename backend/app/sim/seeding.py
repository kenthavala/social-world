"""Persona seeding: stance mix -> LLM persona batches (5 per call) with template fallbacks."""
from __future__ import annotations

import hashlib
import random
import re
from typing import Any

from app import db
from app.sim import memory
from app.sim.models import PersonaOut

ARCHETYPES = ["ordinary user", "expert", "journalist", "activist", "skeptic", "official"]
GROUP_WEIGHTS = {"small": 0.6, "medium": 1.0, "large": 1.8}


def _stance_mix(config: dict) -> dict[str, float]:
    keys = ("pro", "con", "undecided")
    raw = config.get("pop_mix") or {}
    vals = []
    for k in keys:
        try:
            vals.append(min(0.95, max(0.0, float(raw.get(k, {"pro": 0.3, "con": 0.3, "undecided": 0.4}[k])))))
        except (TypeError, ValueError, KeyError):
            vals.append({"pro": 0.3, "con": 0.3, "undecided": 0.4}[k])
    total = sum(vals)
    if total <= 0:
        vals = [0.3, 0.3, 0.4]
        total = 1.0
    return dict(zip(keys, [v / total for v in vals]))


def assign_targets(agents_n: int, brief: dict, config: dict, rng: random.Random) -> list[dict]:
    """Deterministically assign each slot a stakeholder group and per-issue target stance."""
    issues: list[dict] = brief.get("issues") or []
    groups: list[dict] = brief.get("stakeholder_groups") or []
    if not groups:
        groups = [{"name": "Members of the public", "description": "Ordinary readers",
                   "size_hint": "large", "stance_by_issue": {i["id"]: 0.0 for i in issues}}]
    mix = _stance_mix(config)
    n_by_size: dict[str, int] = {}
    total_agents = agents_n
    slots: list[dict] = []
    # slot -> group by weighted sampling with replacement (size_hint biases share)
    weights = [GROUP_WEIGHTS.get(g.get("size_hint", "medium"), 1.0) for g in groups]
    group_names = [g["name"] for g in groups]
    for i in range(total_agents):
        cum = rng.random() * sum(weights)
        acc = 0.0
        gi = 0
        for j, w in enumerate(weights):
            acc += w
            if cum <= acc:
                gi = j
                break
        group = groups[gi]
        gname = group["name"]
        n_by_size[gname] = n_by_size.get(gname, 0) + 1
        targets: dict[str, float] = {}
        for issue in issues:
            iid = issue["id"]
            roll = rng.random()
            acc2 = 0.0
            bucket = "undecided"
            for k, frac in mix.items():
                acc2 += frac
                if roll <= acc2:
                    bucket = k
                    break
            gstance = float((group.get("stance_by_issue") or {}).get(iid, 0.0) or 0.0)
            if bucket == "pro":
                base = rng.uniform(0.5, 0.9)
            elif bucket == "con":
                base = rng.uniform(-0.9, -0.5)
            else:
                base = rng.uniform(-0.2, 0.2)
            targets[iid] = round(max(-1.0, min(1.0, 0.5 * base + 0.5 * gstance)), 3)
        slots.append({
            "ordinal": i, "group": group, "group_name": gname,
            "archetype": group.get("archetype") or None,
            "targets": targets,
        })
    return slots


FALLBACK_NAMES = ["Ana", "Boris", "Chen", "Dara", "Emeka", "Farah", "Gita", "Hugo",
                  "Iris", "Jonas", "Kira", "Liam", "Mina", "Nour", "Omar", "Pia",
                  "Quinn", "Rosa", "Sam", "Tomas", "Uma", "Vik", "Wren", "Xiu"]


def template_persona(slot: dict, issue_ids: list[str]) -> PersonaOut:
    group = slot["group"]
    name = f"{FALLBACK_NAMES[slot['ordinal'] % len(FALLBACK_NAMES)]} {slot['group_name'].split()[0]}"
    big5 = {"openness": 0.5, "conscientiousness": 0.5, "extraversion": 0.4 + (slot["ordinal"] % 3) * 0.1,
            "agreeableness": 0.5, "neuroticism": 0.3 + (slot["ordinal"] % 4) * 0.1}
    stances = {iid: slot["targets"].get(iid, 0.0) for iid in issue_ids}
    return PersonaOut(
        name=name, handle=f"user{slot['ordinal'] + 1:02d}",
        bio=f"{group.get('description', '')} A {group['name'].lower()} who follows this closely.",
        archetype=slot.get("archetype") or (ARCHETYPES[slot["ordinal"] % len(ARCHETYPES)]),
        big5=big5, goals=["follow the debate", "share informed views"],
        interests=["policy", "evidence", "community"], voice="plain and direct",
        stances=stances,
    )


def persona_prompt(batch: list[dict], brief: dict) -> list[dict]:
    """Batch prompt for 5 personas. Markers are parsed by the mock provider."""
    issues: list[dict] = brief.get("issues") or []
    group_lines: list[str] = []
    for g in brief.get("stakeholder_groups", []):
        group_lines.append(f"- {g['name']}: {g.get('description', '')}")
    spec = []
    for slot in batch:
        gs_txt = ", ".join(
            f"{i['id']}={float((slot['group'].get('stance_by_issue') or {}).get(i['id'], 0.0))}"
            for i in issues)
        stance_lines = "\n".join(
            f"target stance: {slot['targets'].get(i['id'], 0.0)} on issue {i['id']}"
            for i in issues)
        spec.append(
            f'"target_ordinal": {slot["ordinal"]}\n'
            f"target group: {slot['group_name']}\n"
            f"group stance by issue: {gs_txt}\n"
            f"{stance_lines}"
        )
    sys = (
        "You create fictional personas for a social simulation, grounded in the stakeholder groups of a real document. "
        "Return ONLY a JSON array of " + str(len(batch)) + " objects, in the order requested, exactly matching:\n"
        '[{"name": str, "handle": lowercase_alnum, "bio": str (<=25 words), "archetype": one of '
        '"ordinary user|expert|journalist|activist|skeptic|official", '
        '"big5": {"openness":0-1,"conscientiousness":0-1,"extraversion":0-1,"agreeableness":0-1,"neuroticism":0-1}, '
        '"goals": [1-3 short strings], "interests": [5-10 short lowercase keyword strings], "voice": str, '
        '"stances": {"' + '": number, "'.join(i["id"] for i in issues) + '": number}] \n'
        "Stances are the persona's initial position per issue in -1..1 (negative = opposes, positive = supports). "
        "Respect each requested target stance within +-0.15. Table values below give group membership and stance targets."
    )
    chunks = brief_chunk_context(brief)
    user = (
        f"World summary: {brief.get('summary', '')}\n\n"
        f"Stakeholder groups:\n" + "\n".join(group_lines) + "\n\n"
        + (f"Key claims: " + "; ".join(c.get("text", "") for c in brief.get("key_claims", [])[:5]) + "\n\n")
        + (f"Source excerpts:\n{chunks}\n\n" if chunks else "")
        + "Personas requested, in this order:\n\n"
        + "\n\n".join(spec)
    )
    return [{"role": "system", "content": sys}, {"role": "user", "content": user}]


def brief_chunk_context(brief: dict, limit: int = 3) -> str:
    out = []
    claim_chunks = [c.get("chunk_id") for c in (brief.get("key_claims") or []) if c.get("chunk_id")]
    evid = []
    for i in brief.get("issues", []):
        evid += i.get("evidence_chunk_ids", [])
    seen: set[str] = set()
    for cid in [c for c in claim_chunks + evid if isinstance(c, str)]:
        if cid in seen:
            continue
        seen.add(cid)
        row = db.query_one(
            "SELECT id, text, page_start, page_end, heading FROM chunks WHERE id=?", (cid,))
        if row is None:
            continue
        out.append(f"[{row['id']} p.{row['page_start']}-{row['page_end']}] {(row['heading'] or '')}\n{row['text'][:600]}")
        if len(out) >= limit:
            break
    return "\n\n".join(out)


def clamp_persona(out: PersonaOut, slot: dict, issue_ids: list[str]) -> dict:
    """Clamp all fields, apply target stances (allow +-0.25 drift from LLM)."""
    stances: dict[str, dict] = {}
    for iid in issue_ids:
        target = slot["targets"].get(iid, 0.0)
        try:
            raw = float((out.stances or {}).get(iid, target))
        except (TypeError, ValueError):
            raw = target
        val = max(target - 0.25, min(target + 0.25, max(-1.0, min(1.0, raw))))
        stances[iid] = {"value": round(val, 3), "confidence": 0.5}
    handle = re.sub(r"[^a-z0-9_]", "", (out.handle or f"user{slot['ordinal']:02d}").lower())[:20] or f"user{slot['ordinal']:02d}"
    interests = [re.sub(r"[^a-z0-9 -]", "", i.lower())[:20] for i in (out.interests or [])] or ["policy", "debate"]
    interests = list(dict.fromkeys(interests))[:10]
    big5 = out.big5.model_dump()
    return {
        "name": (out.name or "Unnamed")[:60],
        "handle": handle,
        "bio": (out.bio or "")[:200],
        "archetype": out.archetype if out.archetype in ARCHETYPES else "ordinary user",
        "group": slot["group_name"],
        "big5": big5,
        "goals": (out.goals or ["follow the debate"])[:3],
        "interests": (interests + ["policy", "debate"])[:10],
        "voice": (out.voice or "plain")[:80],
        "stances": stances,
        "group_description": slot["group"].get("description", ""),
    }


def derived_traits(big5: dict) -> dict:
    return {
        "activity": 0.2 + 0.6 * big5["extraversion"],
        "reactivity": 0.3 + 0.5 * big5["neuroticism"],
        "tolerance": 0.3 + 0.6 * big5["openness"],
        "stubbornness": 0.2 + 0.5 * (1 - big5["openness"]),
    }


def agent_id(ordinal: int, run_key: str = "") -> str:
    salt = run_key if run_key else str(ordinal)
    return "agent_" + hashlib.sha1(f"{salt}|{ordinal}".encode()).hexdigest()[:6]


def initial_edges(agents: list[dict], rng: random.Random) -> dict[str, dict]:
    """Follow graph: homophily 0.6 / shared group 0.2 / random 0.2 + preferential attachment."""
    edges: dict[str, dict] = {}
    from app.sim import relations, feed as feed_mod
    ids = [a["id"] for a in agents]
    in_degree = {i: 0 for i in ids}
    for a in agents:
        k = 3 + round(5 * a["big5"]["extraversion"])
        k = min(k, len(ids) - 1)
        picks: set[str] = set()
        others = [b for b in ids if b != a["id"]]
        while len(picks) < k and others:
            mode = rng.random()
            if mode < 0.6:
                # stance-similarity sampling: pick by smallest |diff| with noise
                by_sim = sorted(others, key=lambda b: _stance_dist(a, b, agents) + 0.1 * rng.random())
                target = next((b for b in by_sim if b not in picks), None)
            elif mode < 0.8:
                same_group = [b for b in others if _group_of(b, agents) == a["group"] and b not in picks]
                target = rng.choice(same_group) if same_group else None
            else:
                pool = [b for b in others if b not in picks]
                target = rng.choice(pool) if pool else None
            if target is None:
                continue
            # preferential attachment boost for visible archetypes
            if _archetype_rank(target, agents) and rng.random() < 0.3 * _archetype_rank(target, agents):
                # add another label to highly-followed accounts proportionally
                popular = sorted(in_degree.items(), key=lambda kv: -kv[1])
                candidates = [b for b, d in popular if d > 0 and b not in picks and b != a["id"]]
                if candidates and rng.random() < 0.5:
                    target = candidates[0]
            if target in picks:
                continue
            picks.add(target)
            relations.set_follow(edges, a["id"], target, True)
            in_degree[target] += 1
    return edges


def _stance_dist(a: dict, b_id: str, agents: list[dict]) -> float:
    b = next((x for x in agents if x["id"] == b_id), None)
    if not b:
        return 1.0
    tot, n = 0.0, 0
    for iid, sv in a["stances"].items():
        bv = b["stances"].get(iid, {}).get("value", 0.0)
        tot += abs(sv["value"] - bv)
        n += 1
    return tot / max(1, n)


def _group_of(agent_id: str, agents: list[dict]) -> str:
    a = next((x for x in agents if x["id"] == agent_id), None)
    return a["group"] if a else ""


def _archetype_rank(agent_id: str, agents: list[dict]) -> float:
    a = next((x for x in agents if x["id"] == agent_id), None)
    if not a:
        return 0.0
    return 1.0 if a["archetype"] in ("expert", "journalist", "official") else 0.0


def _post_like(values: dict[str, float]) -> dict[str, float]:
    return values
