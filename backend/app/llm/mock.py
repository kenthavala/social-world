"""Deterministic mock provider: offline demos + tests. Parses ids from the prompt text."""
from __future__ import annotations

import hashlib
import re
from typing import Any

AGENT_RE = re.compile(r'agent_id must be exactly "(agent_[a-z0-9_]+)"')
CHUNK_RE = re.compile(r"\[(c_[a-z0-9]+)\s+p\.?")
ISSUE_RE = re.compile(r'"(iss_[a-z0-9_]+)')
AGENTS_BULK_RE = re.compile(r"agent_id\w*:\"\s*\(agent_[a-z0-9_]+\)|\"agent_id\": \"(agent_[a-z0-9_]+)\"")
ANY_AGENT_RE = re.compile(r"agent_[a-z0-9_]+")
ANY_CHUNK_RE = re.compile(r"c_[a-z0-9]+")
ANY_ISSUE_RE = re.compile(r"iss_[a-z0-9_]+")


def _seed_of(text: str) -> int:
    return int(hashlib.sha256(text.encode("utf-8")).hexdigest()[:12], 16)


def _wobble(text: str) -> float:
    """Deterministic pseudo-random float in [-1, 1] derived from text."""
    h = _seed_of(text)
    return ((h % 2000) / 1000.0) - 1.0


_SKEW_SENTENCES = [
    "The evidence I have seen points the other way on this.",
    "This matches what I argued at the start.",
    "People keep missing the practical side of this.",
    "I have read the note on this and it changes little for me.",
    "My group has been saying this for days.",
    "That is a fair reading, but the costs are understated.",
    "The report cited here is clear enough for me.",
    "We should slow down and look at the numbers first.",
    "This is exactly the kind of thinking that got us here.",
    "I will keep an open mind if better data appears.",
]


def complete_mock(task: str, messages: list[dict], max_items: int = 20) -> str:
    """Return a JSON string appropriate to the task, derived only from the prompt."""
    prompt = "\n".join(str(m.get("content", "")) for m in messages)
    if task == "test":
        return '{"ok": true, "n": 7}'
    if task == "brief":
        issue_ids = sorted(set(ANY_ISSUE_RE.findall(prompt))) or ["iss_1"]
        issues = []
        for i, iid in enumerate(issue_ids):
            issues.append({
                "id": iid, "name": f"Issue {i + 1}", "question": prompt.strip()[:120] or "The main question",
                "pro_label": "Supports", "con_label": "Opposes", "evidence_chunk_ids": [],
            })
        groups = [
            {"name": "Members of the public", "description": "Ordinary readers with mixed views",
             "size_hint": "large", "stance_by_issue": {i["id"]: _wobble("g0" + i["id"]) for i in issues}},
            {"name": "Concerned professionals", "description": "People close to the subject",
             "size_hint": "medium", "stance_by_issue": {i["id"]: 0.3 for i in issues}},
            {"name": "Organised opponents", "description": "Sceptics of the main claims",
             "size_hint": "small", "stance_by_issue": {i["id"]: -0.5 for i in issues}},
        ]
        return _dumps({
            "summary": "The source raises contested questions that people will disagree about.",
            "issues": issues,
            "stakeholder_groups": groups,
            "key_claims": [],
            "entities": [],
        })
    if task == "persona":
        any_group_re = re.compile(r"target group: (.+)")
        found_groups = [m.group(1).strip() for m in any_group_re.finditer(prompt)]
        issue_ids = sorted(set(ANY_ISSUE_RE.findall(prompt))) or ["iss_1"]
        n = max(1, min(5, prompt.count('"target_ordinal"')))
        out = []
        archetypes = ["ordinary user", "expert", "journalist", "activist", "skeptic"]
        big5_template = [0.5, 0.4, 0.6, 0.3, 0.7]
        for i in range(n):
            group = found_groups[i] if i < len(found_groups) else "Members of the public"
            stance = 0.0
            m = re.search(rf"target stance: ([-\d.]+) on issue {re.escape(issue_ids[0])}", prompt)
            if m:
                try:
                    stance = float(m.group(1))
                except ValueError:
                    stance = 0.0
            noise = _wobble(f"p{i}:{prompt}") * 0.15
            stances = {iid: {"value": round(max(-1.0, min(1.0, stance + noise)), 3),
                             "confidence": 0.5} for iid in issue_ids}
            out.append({
                "name": f"Persona {i + 1}",
                "handle": f"persona_{i + 1:02d}",
                "bio": f"{archetypes[i % len(archetypes)]} interested in the scenario topic.",
                "archetype": archetypes[i % len(archetypes)],
                "big5": {"openness": big5_template[0], "conscientiousness": big5_template[1],
                         "extraversion": big5_template[2], "agreeableness": big5_template[3],
                         "neuroticism": big5_template[4]},
                "goals": ["understand the issue", "share informed views"],
                "interests": ["policy", "evidence", "debate"],
                "voice": "plain and direct",
                "stances": stances,
            })
        return _dumps(out)
    if task == "write":
        agent_ids = re.findall(r'agent_id must be exactly "(agent_[a-z0-9_]+)"', prompt)
        chunk_ids = list(dict.fromkeys(ANY_CHUNK_RE.findall(prompt)))[:4]
        issue_ids = sorted(set(ANY_ISSUE_RE.findall(prompt))) or ["iss_1"]
        batch_seed = _seed_of(prompt)
        out = []
        for i, aid in enumerate(agent_ids[:max_items]):
            sentence = _SKEW_SENTENCES[(batch_seed + i) % len(_SKEW_SENTENCES)]
            # stance from the agent's own persona card if present, else batch seed
            m = re.search(
                r'agent_id must be exactly "' + re.escape(aid) +
                r'"[\s\S]*?stances on the issues: ([^\n]+)', prompt)
            stance = {}
            if m:
                for pair in re.findall(r"(iss_[A-Za-z0-9_]+)=([+-][\d.]+)", m.group(1)):
                    try:
                        stance[pair[0]] = max(-1.0, min(1.0, float(pair[1])))
                    except ValueError:
                        pass
            if not stance:
                stance = {iid: round(_wobble(_SKEW_SENTENCES[(batch_seed + i) % len(_SKEW_SENTENCES)] + iid), 3)
                          for iid in issue_ids}
            item: dict[str, Any] = {
                "agent_id": aid,
                "action": "reply" if "action: reply" in prompt else "post",
                "reply_to": None,
                "text": f"{sentence[:1].upper()}{sentence[1:]}",
                "stance": stance,
                "emotion": "neutral",
                "cited_chunk_ids": (chunk_ids[(_seed_of(str(stance)) + i) % max(1, len(chunk_ids)):][:1]
                                    if chunk_ids else []),
            }
            out.append(item)
        return _dumps(out)
    if task == "reflect":
        agent_ids = ANY_AGENT_RE.findall(prompt)
        summaries = []
        seen: set[str] = set()
        for aid in agent_ids:
            if aid in seen:
                continue
            seen.add(aid)
            summaries.append({"agent_id": aid,
                              "belief_summary": "Still mostly undecided, moved slightly by recent debate."})
        return _dumps(summaries[:5] or [{"agent_id": "agent_1", "belief_summary": "No change."}])
    if task in ("report", "essay"):
        return _dumps({
            "executive_summary": "Simulated discussion produced modest opinion movement.",
            "opinion_shifts": "Stances drifted slightly; no issue flipped majority.",
            "emerging_narratives": "The dominant thread repeated source claims.",
            "influential_agents": "Highly followed accounts drew the most engagement.",
            "communities": "Two loose clusters formed around the pro and con sides.",
            "key_events": "No scheduled events fired in this segment.",
            "contradictions": "A few agents held conflicting stances across issues.",
            "unexpected_outcomes": "None recorded.",
            "limitations": "Synthetic simulation using the mock provider; treat every statement as generated, not factual.",
        })
    return "{}"


def _dumps(value: dict | list) -> str:
    import json
    return json.dumps(value, ensure_ascii=False)
