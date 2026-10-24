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


def _allocate_slots(weights: list[float], total: int) -> list[int]:
    """Apportion `total` agent slots across groups so none is silently dropped.

    Pure weighted sampling with replacement can leave small groups with zero agents
    even when there are more agents than groups — the operator configured the group,
    so it must be represented. This uses largest-remainder apportionment with a
    floor of one agent per group, which is deterministic for a given weight vector.
    When there are fewer agents than groups the heaviest groups are chosen and the
    caller reports the ones that could not be represented instead of hiding it.
    """
    m = len(weights)
    if m == 0 or total <= 0:
        return [0] * m
    if total <= m:
        # Cannot cover every group: represent the heaviest, ties broken by order.
        order = sorted(range(m), key=lambda j: (-weights[j], j))[:total]
        alloc = [0] * m
        for j in order:
            alloc[j] = 1
        return alloc
    total_w = sum(weights) or float(m)
    remaining = total - m
    raw = [remaining * w / total_w for w in weights]
    floors = [int(x) for x in raw]
    alloc = [1 + f for f in floors]
    left = remaining - sum(floors)
    order = sorted(range(m), key=lambda j: (-(raw[j] - floors[j]), j))
    for j in order[:max(0, left)]:
        alloc[j] += 1
    return alloc


def group_coverage(brief: dict, agents_n: int) -> tuple[list[str], list[str]]:
    """Return (represented, unrepresented) configured group names for a population size."""
    groups = brief.get("stakeholder_groups") or []
    names = [g.get("name") or "" for g in groups]
    weights = [GROUP_WEIGHTS.get(g.get("size_hint", "medium"), 1.0) for g in groups]
    alloc = _allocate_slots(weights, agents_n)
    return ([n for n, a in zip(names, alloc) if a > 0],
            [n for n, a in zip(names, alloc) if a == 0])


def assign_targets(agents_n: int, brief: dict, config: dict, rng: random.Random) -> list[dict]:
    """Deterministically assign each slot a stakeholder group and per-issue target stance."""
    issues: list[dict] = brief.get("issues") or []
    groups: list[dict] = brief.get("stakeholder_groups") or []
    if not groups:
        groups = [{"name": "Members of the public", "description": "Ordinary readers",
                   "size_hint": "large", "stance_by_issue": {i["id"]: 0.0 for i in issues}}]
    mix = _stance_mix(config)
    total_agents = agents_n
    slots: list[dict] = []
    weights = [GROUP_WEIGHTS.get(g.get("size_hint", "medium"), 1.0) for g in groups]
    # Guarantee representation: apportion slots so every configured group receives at
    # least one agent whenever the population is large enough.
    alloc = _allocate_slots(weights, total_agents)
    scheduled: list[int] = []
    for gi, count in enumerate(alloc):
        scheduled.extend([gi] * count)
    # Shuffle so group identity is not correlated with agent ordinal, while the
    # counts above stay exact. The seed makes the shuffle reproducible.
    rng.shuffle(scheduled)
    for i, gi in enumerate(scheduled):
        group = groups[gi]
        gname = group["name"]
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
    """Follow graph: homophily 0.6 / shared group 0.2 / random 0.2 + preferential attachment.

    The lookups below are precomputed: the original implementation called
    `_stance_dist`/`_group_of`/`_archetype_rank` inside the sort key, and each of
    those scanned the whole agent list, making seeding O(n^3 log n). Stance
    distances for the current agent are computed once (O(n)) and the RNG calls are
    made in exactly the same order, so the graph is byte-identical for a seed.
    """
    edges: dict[str, dict] = {}
    from app.sim import relations
    ids = [a["id"] for a in agents]
    by_id = {a["id"]: a for a in agents}
    rank = {i: (1.0 if by_id[i]["archetype"] in ("expert", "journalist", "official") else 0.0)
            for i in ids}
    in_degree = {i: 0 for i in ids}
    for a in agents:
        k = 3 + round(5 * a["big5"]["extraversion"])
        k = min(k, len(ids) - 1)
        picks: set[str] = set()
        others = [b for b in ids if b != a["id"]]
        # One pass over this agent's stances instead of one scan per comparison.
        dist: dict[str, float] = {}
        for b in others:
            tot, cnt = 0.0, 0
            b_stances = by_id[b]["stances"]
            for iid, sv in a["stances"].items():
                bv = b_stances.get(iid, {}).get("value", 0.0)
                tot += abs(sv["value"] - bv)
                cnt += 1
            dist[b] = tot / max(1, cnt)
        while len(picks) < k and others:
            mode = rng.random()
            if mode < 0.6:
                # stance-similarity sampling: pick by smallest |diff| with noise.
                # The key list is built in `others` order so the RNG sequence is the
                # same one the scan-based implementation consumed.
                keyed = [(dist[b] + 0.1 * rng.random(), b) for b in others]
                keyed.sort(key=lambda kv: kv[0])
                target = next((b for _k, b in keyed if b not in picks), None)
            elif mode < 0.8:
                same_group = [b for b in others if by_id[b]["group"] == a["group"]
                              and b not in picks]
                target = rng.choice(same_group) if same_group else None
            else:
                pool = [b for b in others if b not in picks]
                target = rng.choice(pool) if pool else None
            if target is None:
                continue
            # preferential attachment boost for visible archetypes
            if rank[target] and rng.random() < 0.3 * rank[target]:
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
