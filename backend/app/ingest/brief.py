"""World brief: LLM-generated issues + stakeholder groups from selected chunks, with fallback."""
from __future__ import annotations

import re
from typing import Any

from app import db
from app.errors import AppError
from app.ingest import index as index_mod

BRIEF_SYSTEM = (
    "You are building a simulation brief from a source document. "
    "Contested issues you identify will be argued by simulated personas. "
    "Return ONLY JSON matching this schema exactly:\n"
    '{"summary": str, "issues": [{"id": "iss_N", "name": str, "question": str, '
    '"pro_label": str, "con_label": str, "evidence_chunk_ids": [str...]}], '
    '"stakeholder_groups": [{"name": str, "description": str, "size_hint": "small|medium|large", '
    '"stance_by_issue": {"iss_N": -1.0..1.0}}], '
    '"key_claims": [{"text": str, "chunk_id": str}], "entities": [str]}\n'
    "Rules: identify every distinct contested issue the source raises — there is no "
    "artificial upper bound on the number of issues or stakeholder groups. "
    "Every stakeholder group must get a stance for every issue. "
    "Use the chunk ids you were given verbatim. Issue ids must be iss_1, iss_2... in order."
)


def select_chunks(source_id: str, scenario: str, limit: int = 12) -> list[dict]:
    """First 2 chunks + chunks with headings + top BM25 matches for the scenario."""
    rows = db.query(
        "SELECT id, idx, text, page_start, page_end, heading, n_words FROM chunks"
        " WHERE source_id=? ORDER BY idx", (source_id,))
    if not rows:
        return []
    chunks = [dict(r) for r in rows]
    by_id = {c["id"]: c for c in chunks}
    selected: dict[str, Any] = {}
    order: list[str] = []
    for c in chunks[:2]:
        selected[c["id"]] = c
        order.append(c["id"])
    for c in chunks:
        if c["heading"] and len(order) < limit:
            if c["id"] not in selected:
                selected[c["id"]] = c
                order.append(c["id"])
    if scenario:
        try:
            matches = index_mod.search(source_id, scenario, k=limit)
        except Exception:
            matches = []
        for cid, _score in matches:
            if cid in by_id and cid not in selected and len(order) < limit:
                selected[cid] = by_id[cid]
                order.append(cid)
    while len(order) < limit and chunks:
        nxt = next((c for c in chunks if c["id"] not in selected), None)
        if nxt is None:
            break
        selected[nxt["id"]] = nxt
        order.append(nxt["id"])
    return [selected[i] for i in order[:limit]]


def _chunk_repr(c: dict, chars: int = 700) -> str:
    head = f"[{c['id']} p.{c['page_start']}-{c['page_end']}]"
    if c.get("heading"):
        head += f" {c['heading']}"
    return head + "\n" + c["text"][:chars]


def _map_prompts(source_id: str, scenario: str) -> list[list[dict]]:
    """For long docs: 3 groups of chunks -> brief bullet summaries."""
    rows = db.query(
        "SELECT id, idx, text, page_start, page_end, heading FROM chunks"
        " WHERE source_id=? ORDER BY idx", (source_id,))
    texts = [f"[{r['id']} p.{r['page_start']}] {(r['heading'] or '')}\n{r['text'][:400]}"
             for r in rows]
    groups = [texts[i::3] for i in range(3)]
    out = []
    for i, g in enumerate([g for g in groups if g]):
        joined = "\n\n".join(g)[:14000]
        out.append([
            {"role": "system", "content": "Summarise the positions, groups and key claims in these document excerpts in under 250 words. Plain text only."},
            {"role": "user", "content": f"Scenario question: {scenario}\n\nExcerpts:\n{joined}"},
        ])
    return out


async def build_brief(source_id: str, scenario: str, gateway,
                      max_issues: int = 1, max_groups: int = 3) -> dict:
    """Generate the world brief. Costs 1-4 calls. Never raises: falls back deterministically.

    max_issues/max_groups are only used by the deterministic fallback when the LLM
    cannot produce a valid brief; they let the fallback honour the user's requested
    issue/group counts instead of silently defaulting to 1 issue / 3 groups.
    """
    chunks = select_chunks(source_id, scenario)
    maps: list[str] = []
    n_chunks = db.scalar("SELECT COUNT(*) FROM chunks WHERE source_id=?", (source_id,)) or 0
    try:
        if n_chunks > 60:
            for msgs in _map_prompts(source_id, scenario)[:3]:
                result = await gateway.complete("brief", msgs)
                maps.append((result.text or "").strip()[:1200])
        context = "\n\n".join(_chunk_repr(c) for c in chunks) if not maps else \
            "\n\n".join(f"## Excerpt group {i + 1}\n{m}" for i, m in enumerate(maps))
        messages = [
            {"role": "system", "content": BRIEF_SYSTEM},
            {"role": "user",
             "content": f"Scenario: {scenario}\n\nSource chunks:\n{context}"},
        ]
        result = await gateway.complete("brief", messages)
        brief = _sanitize_brief(result.parsed if isinstance(result.parsed, dict) else result.text)
        if _looks_valid(brief):
            brief["generated_by"] = {
                "provider": getattr(result, "provider", "") or "",
                "model": getattr(result, "model", "") or "",
                "from_cache": bool(getattr(result, "from_cache", False)),
            }
            return brief
    except Exception as e:  # noqa: BLE001 — never fail ingestion on brief problems
        fallback_error = str(e)[:200]
    return _fallback_brief(scenario, source_id, n_issues=max_issues, n_groups=max_groups)


def _looks_valid(brief: dict) -> bool:
    return bool(brief.get("issues")) and bool(brief.get("stakeholder_groups"))


_HARNESS_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)


def _sanitize_brief(raw: Any) -> dict:
    """Accept dict or text; clamp ids, stances and counts to the schema."""
    if isinstance(raw, str):
        from app.llm.parsing import extract_json
        try:
            raw = extract_json(raw)
        except Exception:
            return {}
    if not isinstance(raw, dict):
        return {}
    issues = []
    for i, issue in enumerate((raw.get("issues") or [])):
        if not isinstance(issue, dict):
            continue
        iid = issue.get("id") or f"iss_{i + 1}"
        if not re.fullmatch(r"iss_[A-Za-z0-9_]+", str(iid)):
            iid = f"iss_{i + 1}"
        issues.append({
            "id": iid,
            "name": str(issue.get("name") or f"Issue {i + 1}")[:80],
            "question": str(issue.get("question") or issue.get("name") or "")[:300],
            "pro_label": str(issue.get("pro_label") or "Supports")[:40],
            "con_label": str(issue.get("con_label") or "Opposes")[:40],
            "evidence_chunk_ids": [c for c in (issue.get("evidence_chunk_ids") or [])
                                   if isinstance(c, str)],
        })
    groups = []
    for g in (raw.get("stakeholder_groups") or []):
        if not isinstance(g, dict):
            continue
        stance = {}
        for issue in issues:
            v = (g.get("stance_by_issue") or {}).get(issue["id"], 0.0)
            try:
                stance[issue["id"]] = round(max(-1.0, min(1.0, float(v))), 3)
            except (TypeError, ValueError):
                stance[issue["id"]] = 0.0
        groups.append({
            "name": str(g.get("name") or "Unnamed group")[:60],
            "description": str(g.get("description") or "")[:200],
            "size_hint": g.get("size_hint") if g.get("size_hint") in ("small", "medium", "large") else "medium",
            "stance_by_issue": stance,
        })
    claims = []
    for c in (raw.get("key_claims") or [])[:10]:
        if isinstance(c, dict) and c.get("text"):
            claims.append({"text": str(c["text"])[:300], "chunk_id": str(c.get("chunk_id") or "")[:64]})
    meta = raw.get("generated_by")
    if not isinstance(meta, dict):
        meta = None
    else:
        meta = {"provider": str(meta.get("provider") or "")[:80],
                "model": str(meta.get("model") or "")[:120],
                "from_cache": bool(meta.get("from_cache"))}
    return {
        "summary": str(raw.get("summary") or "")[:1000],
        "issues": issues or [{"id": "iss_1", "name": "Main question", "question": "What should be done?",
                              "pro_label": "Supports", "con_label": "Opposes", "evidence_chunk_ids": []}],
        "stakeholder_groups": groups or [
            {"name": "Members of the public", "description": "Ordinary readers with mixed views",
             "size_hint": "large", "stance_by_issue": {(issues[0]["id"] if issues else "iss_1"): 0.0}}],
        "key_claims": claims,
        "entities": [str(e)[:40] for e in (raw.get("entities") or [])[:10]],
        "fallback": False,
        "generated_by": meta,
    }


def _fallback_brief(scenario: str, source_id: str, n_issues: int = 1,
                    n_groups: int = 3) -> dict:
    """Create a fallback brief used when LLM brief generation fails completely.

    Supports arbitrary issue/group counts via n_issues/n_groups so the fallback
    never silently truncates a user's requested configuration. Defaults match
    the previous behaviour (1 issue, 3 groups).
    """
    n_issues = max(1, int(n_issues or 1))
    n_groups = max(1, int(n_groups or 1))
    iids = [f"iss_{i + 1}" for i in range(n_issues)]
    issues = []
    for idx, iid in enumerate(iids):
        issues.append({
            "id": iid,
            "name": "Main question" if idx == 0 else f"Issue {idx + 1}",
            "question": str(scenario)[:300],
            "pro_label": "Supports",
            "con_label": "Opposes",
            "evidence_chunk_ids": [],
        })
    groups = []
    for gidx in range(n_groups):
        stance_by_issue = {}
        if gidx == 0:
            for iid in iids:
                stance_by_issue[iid] = 0.0
        elif gidx == 1 and len(iids) > 0:
            stance_by_issue = {iids[0]: 0.5}
            for iid in iids[1:]:
                stance_by_issue[iid] = 0.0
        elif gidx == 2 and len(iids) > 0:
            stance_by_issue = {iids[0]: -0.5}
            for iid in iids[1:]:
                stance_by_issue[iid] = 0.0
        else:
            for iid in iids:
                stance_by_issue[iid] = 0.0
        size_hint = "large" if gidx == 0 else ("medium" if gidx < 4 else "small")
        groups.append({
            "name": {0: "Members of the public", 1: "Engaged supporters",
                     2: "Sceptics"}.get(gidx, f"Group {gidx + 1}"),
            "description": "Ordinary readers with mixed views",
            "size_hint": size_hint,
            "stance_by_issue": stance_by_issue,
        })
    return {
        "summary": str(scenario)[:500],
        "issues": issues,
        "stakeholder_groups": groups,
        "key_claims": [],
        "entities": [],
        "fallback": True,
        "generated_by": None,
    }
