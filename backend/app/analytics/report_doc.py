"""Professional report document renderer.

Turns one run's counted rows plus the computed narrative into a readable research
deliverable. Every number here is counted; every interpretive sentence is either
computed from those counts or explicitly labelled as a generated draft elsewhere.
"""
from __future__ import annotations

from typing import Any, Optional

from app import db


def _pct(n: Optional[float], d: Optional[float]) -> str:
    if not d:
        return "—"
    return f"{round(100.0 * n / d)}%"


def _signed(v: Optional[float]) -> str:
    return "—" if v is None else f"{v:+.2f}"


def _stance_phrase(v: Optional[float]) -> str:
    if v is None:
        return "no recorded position"
    if v >= 0.5:
        return "strongly supportive"
    if v >= 0.15:
        return "supportive"
    if v <= -0.5:
        return "strongly opposed"
    if v <= -0.15:
        return "opposed"
    return "undecided"


def _rule(title: str) -> list[str]:
    """A level-2 Markdown section heading with surrounding blank lines."""
    return ["", f"## {title}", ""]


def render(
    *,
    run: dict,
    cfg: dict,
    provider: dict,
    analytics: dict,
    issue_means: dict,
    issue_names: dict,
    groups: list[dict],
    narrative: dict,
    top_posts: list[dict],
    influencers: list[dict],
    shifts: list[dict],
    clusters: list[dict],
    usage: list[dict],
    narratives: list[dict],
    briefings: list[dict],
    scenario: dict,
    source: Optional[dict],
    counts: dict,
    quality: Optional[dict] = None,
) -> str:
    name = run.get("name") or run.get("id")
    started = str(run.get("started_at") or "—")[:19].replace("T", " ")
    finished = str(run.get("finished_at") or "—")[:19].replace("T", " ")
    scale = narrative.get("scale") or {}
    answers = narrative.get("answers") or {}
    key_findings = narrative.get("key_findings") or []
    issue_rows = narrative.get("issues") or []
    stakeholder_rows = narrative.get("stakeholders") or []

    L: list[str] = []

    # ------------------------------------------------------------------ cover
    L += [
        "# The Social World",
        "",
        "## Simulation Findings Report",
        "",
        f"### {name}",
        "",
        "|  |  |",
        "|---|---|",
        f"| **Scenario** | {name} |",
        f"| **Research question** | {scenario.get('question') or '_(not recorded)_'} |",
        f"| **Date** | {finished} UTC |",
        f"| **Source** | {source.get('filename') if source else '—'} |",
        f"| **Simulation window** | {started} → {finished} UTC |",
        # A mock run never calls a model, so naming one would imply it was used.
        f"| **Provider** | `{provider.get('name') or 'n/a'}` / "
        f"{'not used by mock' if (provider.get('name') == 'mock') else ('`' + str(provider.get('model') or 'n/a') + '`')} |",
        f"| **Scale** | {scale.get('agents', 0)} agents · "
        f"{scale.get('rounds_completed', 0)} rounds · {scale.get('posts', 0)} posts |",
        "",
        "> This report describes a simulation. It is not a survey, a forecast or a "
        "validated predictor of real-world opinion.",
        "",
        "---",
    ]

    # ------------------------------------------------------- executive summary
    L += ["", "## Executive summary", ""]
    cited_phrase = ("every one of which cited the source document"
                    if scale.get("posts") and scale.get("posts_with_source") == scale.get("posts")
                    else f"{scale.get('posts_with_source', 0)} of which cited the source document")
    L += [
        f"This simulation placed **{scale.get('agents', 0)} modelled agents** into "
        f"**{scale.get('groups', 0)} stakeholder groups** and let them discuss "
        f"**{scale.get('issues', 0)} issues** for **{scale.get('rounds_completed', 0)} rounds**, "
        f"producing **{scale.get('posts', 0)} posts**, {cited_phrase}.",
        "",
        f"**What happened.** {answers.get('what_happened', '')}",
        "",
        f"**Why it happened.** {answers.get('why', '')}",
        "",
        f"**Who drove it.** {answers.get('who_drove_it', '')}",
        "",
        f"**What changed.** {answers.get('what_changed', '')}",
        "",
        f"**Where the population agreed.** {answers.get('agreement', '')}",
        "",
        f"**Where it disagreed.** {answers.get('disagreement', '')}",
        "",
        f"**What to watch.** {answers.get('watch', '')}",
        "",
    ]
    if key_findings:
        L += ["### The findings that matter most", ""]
        for i, f in enumerate(key_findings[:5], 1):
            L.append(f"{i}. **{f['headline']}** — {f['explanation']}")
        L.append("")

    # ------------------------------------------------------------- scenario
    L += _rule("Scenario")
    L += [
        f"**Research question.** {scenario.get('question') or '_(not recorded)_'}",
        "",
    ]
    if source:
        L += [
            f"**Source material.** `{source.get('filename')}` — "
            f"{source.get('pages') or 0} page(s), extracted into the chunks the agents cite.",
            "",
        ]
    if counts.get("brief_summary"):
        L += [f"**Brief.** {counts['brief_summary']}", ""]
    L += ["**Issues simulated.**", ""]
    for i in issue_rows:
        L.append(f"- **{i['name']}** (`{i['issue_id']}`)"
                 + (f" — {i['question']}" if i.get("question") else ""))
    L += ["", "**Stakeholder groups configured.**", ""]
    for g in stakeholder_rows:
        L.append(f"- **{g['name']}** — {g['agents']} agent(s)"
                 + (f"; {g['description']}" if g.get("description") else ""))
    L.append("")

    # ---------------------------------------------------------- methodology
    L += _rule("Methodology")
    L += [
        "The Social World builds a small artificial society from a source document and "
        "observes how it talks about a set of contested issues.",
        "",
        "1. **Ingestion.** The uploaded document is extracted page by page, cleaned, and "
        "split into passages (chunks) that keep their page numbers. Every claim an agent "
        "makes can point back to one of these passages.",
        "2. **Brief.** The issues and stakeholder groups are drafted from the document, then "
        "reviewed and edited by the operator before the run starts.",
        f"3. **Agents.** {scale.get('agents', 0)} personas are generated, each assigned to a "
        "stakeholder group with its own stance on every issue, a personality profile, and a "
        "set of source passages it has read.",
        "4. **Rounds.** In each round, agents are activated with a probability driven by their "
        "personality, read a ranked feed of recent posts, react, and a small number post. "
        "Stances update under a bounded-confidence rule: agents move towards positions they "
        "find persuasive and resist positions too far from their own.",
        "5. **Recording.** Posts, reactions, stance changes, relationships and metrics are "
        "committed atomically. Nothing in this report is reconstructed after the fact.",
        "6. **Analysis.** Everything below is counted from those recorded rows. The narrative "
        "sentences are generated deterministically from the counts by rule, not by a language "
        "model.",
        "",
        "**What this method cannot do.** It does not sample real people, and it is not "
        "calibrated against observed opinion. It is a structured way to explore how a "
        "population *might* react under explicit, inspectable assumptions.",
        "",
    ]

    # --------------------------------------------------- stakeholder landscape
    L += _rule("Stakeholder landscape")
    L.append(
        "Each group below is described by what it actually did in the simulation — where it "
        "started, where it ended, and how central it was in the interaction network.")
    L.append("")
    L.append("| Group | Agents | Start | End | Change | Network role | Priority issues |")
    L.append("|---|---|---|---|---|---|---|")
    for g in stakeholder_rows:
        L.append(
            f"| {g['name']} | {g['agents']} | {_signed(g.get('initial_mean'))} | "
            f"{_signed(g.get('final_mean'))} | {_signed(g.get('delta'))} | "
            f"{g.get('network_role', '—')} | "
            f"{', '.join(g.get('priority_issues') or []) or '—'} |")
    L.append("")

    # -------------------------------------------------------- issue landscape
    L += _rule("Issue landscape")
    L.append("| Issue | Start | End | Change | Support | Undecided | Oppose | Spread |")
    L.append("|---|---|---|---|---|---|---|---|")
    for i in issue_rows:
        L.append(
            f"| {i['name']} | {_signed(i.get('initial_mean'))} | {_signed(i.get('final_mean'))} | "
            f"{_signed(i.get('delta'))} | {i['pro_agents']} | {i['neutral_agents']} | "
            f"{i['con_agents']} | {i.get('spread') if i.get('spread') is not None else '—'} |")
    L.append("")

    # --------------------------------------------------------------- findings
    L += _rule("Findings")
    if not key_findings:
        L += ["No finding met the reporting threshold for this run.", ""]
    for i, f in enumerate(key_findings, 1):
        L += [
            f"### Finding {i}: {f['headline']}",
            "",
            f["explanation"],
            "",
        ]
        if f.get("data"):
            L.append("**Supporting data.**")
            L.append("")
            for d in f["data"]:
                L.append(f"- {d['label']}: **{d['value']}**")
            L.append("")
        L.append(f"**Why it matters.** {f['why_it_matters']}")
        L.append("")
        L.append(f"**Strength of evidence.** {f['strength'].title()} — {f['strength_reason']}")
        L.append("")
        if f.get("evidence"):
            L.append("**Evidence cited.**")
            L.append("")
            for e in f["evidence"]:
                pages = (f"pages {e['page_start']}–{e['page_end']}"
                         if e.get("page_start") is not None else "page not recorded")
                L.append(f"- `{e['chunk_id']}` ({pages}), {e['citations']} citation(s)"
                         + (f" — {e['heading']}" if e.get("heading") else ""))
            L.append("")

    # ---------------------------------------------------------- issue analysis
    L += _rule("Issue analysis")
    for i in issue_rows:
        L += [f"### {i['name']}", ""]
        if i.get("question"):
            L += [f"*{i['question']}*", ""]
        L += [
            f"- **Initial landscape:** mean {_signed(i.get('initial_mean'))} across "
            f"{i['observed_agents']} agents.",
            f"- **Final landscape:** mean {_signed(i.get('final_mean'))} — "
            f"{_stance_phrase(i.get('final_mean'))}.",
            f"- **What changed:** {_signed(i.get('delta'))}"
            + (" — effectively stable." if (i.get("delta") or 0) == 0 else "."),
            f"- **Who supported it:** {', '.join(i['supporters']) or 'no group ended supportive'}.",
            f"- **Who opposed it:** {', '.join(i['opponents']) or 'no group ended opposed'}.",
            f"- **Who remained uncertain:** {', '.join(i['undecided']) or 'no group ended undecided'}.",
        ]
        if i.get("movement"):
            L.append("- **Group movements:** " + "; ".join(
                f"{m['group']} {m['direction']} ({_signed(m['delta'])})"
                for m in i["movement"]))
        if i.get("triggers"):
            L.append("- **Why it changed:** " + "; ".join(
                f"{n} change(s) from {k.replace('_', ' ')}"
                for k, n in sorted(i["triggers"].items(), key=lambda kv: -kv[1])))
        else:
            L.append("- **Why it changed:** no stance change on this issue was attributed to a "
                     "specific trigger.")
        if i.get("evidence"):
            L.append("- **Key evidence:** " + "; ".join(
                f"`{e['chunk_id']}` (p.{e['page_start']}, {e['citations']} citations)"
                for e in i["evidence"]))
        if i.get("top_agents"):
            L.append("- **Agents who spoke most:** " + ", ".join(
                f"@{a['handle'] or a['agent_id']} ({a['posts']})" for a in i["top_agents"]))
        L += ["", f"*How much weight this can bear: {i['strength_reason']}*", ""]

    # ----------------------------------------------------- stakeholder analysis
    L += _rule("Stakeholder analysis")
    for g in stakeholder_rows:
        L += [f"### {g['name']}", ""]
        if g.get("description"):
            L += [g["description"], ""]
        if g["agents"] == 0:
            L += ["This group was configured but received no agents, so it contributed nothing "
                  "to the result. Raise the population to include it.", ""]
            continue
        L += [
            f"- **Agents:** {g['agents']}",
            f"- **Influence / institutional power:** {g.get('influence', '—')} / "
            f"{g.get('institutional_power', '—')}",
            f"- **Position:** started {_signed(g.get('initial_mean'))}, ended "
            f"{_signed(g.get('final_mean'))} ({_stance_phrase(g.get('final_mean'))}); "
            f"change {_signed(g.get('delta'))}.",
            f"- **Network role:** {g.get('network_role', '—')}.",
        ]
        if g.get("priority_issues"):
            L.append(f"- **Issues that mattered most:** {', '.join(g['priority_issues'])}.")
        if g.get("concerns"):
            L.append(f"- **Key concerns:** {', '.join(g['concerns'])}.")
        if g.get("representatives"):
            L.append("- **Representative agents:** " + ", ".join(
                f"@{r['handle'] or r['agent_id']} ({r['posts']} posts)"
                for r in g["representatives"]))
        L += ["", f"*{g['strength_reason']}*", ""]

    # ------------------------------------------------------- network dynamics
    L += _rule("Network dynamics")
    L += [
        f"The run recorded **{analytics.get('relationships', 0)}** directed relationships and "
        f"**{analytics.get('follows', 0)}** follows.",
        "",
    ]
    if influencers:
        L.append("**Most connected agents.**")
        L.append("")
        for inf in influencers[:5]:
            L.append(f"- @{inf.get('handle') or inf.get('agent_id')} — "
                     f"{inf.get('degree', inf.get('followers', '—'))} connection(s)")
        L.append("")
    if clusters:
        L.append("**Conversation clusters.** Agents who interacted more with each other than "
                 "with the rest formed the following groups.")
        L.append("")
        for i, c in enumerate(clusters[:6], 1):
            handles = ", ".join(f"@{h}" for h in (c.get("handles") or [])[:6])
            L.append(f"- Cluster {i}: {c.get('size')} agent(s) — {handles}")
        L.append("")
    if narratives:
        L.append("**What each cluster talked about.**")
        L.append("")
        for nv in narratives[:6]:
            who = ", ".join(f"@{h}" for h in (nv.get("handles") or [])[:4])
            terms = ", ".join(nv.get("terms") or [])
            L.append(f"- {who}: {terms}")
        L.append("")

    # ---------------------------------------------------------------- evidence
    L += _rule("Evidence")
    L += [
        f"**{scale.get('posts_with_source', 0)} of {scale.get('posts', 0)} posts** cited at "
        f"least one source passage, drawing on **{scale.get('distinct_chunks_cited', 0)} "
        "distinct passages**.",
        "",
    ]
    if usage:
        L.append("| Passage | Pages | Citations |")
        L.append("|---|---|---|")
        for u in usage[:10]:
            pages = (f"{u['page_start']}–{u['page_end']}"
                     if u.get("page_start") is not None else "—")
            L.append(f"| `{u['chunk_id']}` {u.get('heading') or ''} | {pages} | {u['citations']} |")
        L.append("")
    L.append("Findings with a higher citation count are more directly grounded in the uploaded "
             "document; findings built mostly on agent-to-agent interaction are more dependent "
             "on the simulation's own rules.")
    L.append("")

    # ------------------------------------------------------- changes over time
    L += _rule("Changes over time")
    if shifts:
        L += ["### Biggest opinion shifts", ""]
        L += ["| Round | Issue | From | To | Change |", "|---|---|---|---|---|"]
        for s in shifts[:10]:
            label = issue_names.get(s.get("issue_id"), s.get("issue_id"))
            L.append(f"| {s.get('tick')} | {label} | {_signed(s.get('from'))} | "
                     f"{_signed(s.get('to'))} | {_signed(s.get('delta'))} |")
        L.append("")
    else:
        L += ["No stance change exceeded the reporting threshold, so opinion was stable across "
              "the run.", ""]
    if narrative.get("timeline"):
        L += ["**Moments that changed the conversation.**", ""]
        for t in narrative["timeline"][:10]:
            L.append(f"- Round {t['tick']}: {t['label']} — {t['detail']}")
        L.append("")

    # ---------------------------------------------------------------- outliers
    L += _rule("Outliers")
    agents_all = db.query(
        "SELECT id, handle, name, stakeholder_group FROM agents WHERE run_id=?",
        (run["id"],)) if run.get("id") else []
    if top_posts:
        L += ["**Most-engaged posts.** These are the messages that drew the most interactions "
              "and are where minority or unusual positions are most visible.", ""]
        for p in top_posts[:5]:
            L.append(f"- Round {p.get('tick')} @{p.get('handle') or p.get('agent_id')} "
                     f"({p.get('engagement')} interactions): “{p.get('text')}”")
        L.append("")
    else:
        L += ["No post drew enough engagement to be singled out as an outlier.", ""]

    # ------------------------------------------------------------- uncertainty
    L += _rule("Uncertainty")
    for u in narrative.get("uncertainty") or []:
        L.append(f"- {u}")
    L += [
        "- Predictive accuracy has not yet been externally validated. No observed dataset is "
        "linked to this run.",
        "",
    ]

    # -------------------------------------------------------------- validation
    L += _rule("Validation")
    L += [
        "**External validation: not available.** No observed survey, poll or outcome data is "
        "linked to this simulation, so no accuracy figure is reported and none should be "
        "inferred.",
        "",
        "The Quality panel reports *simulation quality* — how well the run is configured and "
        "how internally consistent its recorded data is. That is a different construct from "
        "predictive accuracy and must not be read as one.",
        "",
    ]

    # -------------------------------------------------------- quality assessment
    if quality:
        overall = quality.get("overall") or {}
        dims = quality.get("dimensions") or []
        assessed = [d for d in dims if d.get("status") == "assessed"]
        unassessed = [d for d in dims if d.get("status") != "assessed"]
        L += _rule("Quality assessment")
        L += [
            "This section describes the *quality of the simulation configuration and of its "
            "recorded data*. It is not predictive accuracy.",
            "",
        ]
        if overall.get("score") is not None:
            L += [f"**Configuration quality: {overall['score']}/100 — {overall.get('label', '')}.**",
                  "", f"{overall.get('method', '')}", ""]
            if overall.get("mock_provider"):
                L += [f"**Mock-provider run.** {overall.get('note') or ''}", ""]
        else:
            L += ["No configuration-quality score could be computed for this run.", ""]
        if assessed:
            L += ["| Dimension | Group | Status | Score |", "|---|---|---|---|"]
            for d in assessed:
                L.append(f"| {d['label']} | {d.get('group', '—')} | assessed | "
                         f"{d.get('score') if d.get('score') is not None else '—'} |")
            L.append("")
        if unassessed:
            L += ["**Not assessed** (excluded from the score, not counted as zero): "
                  + ", ".join(d["label"] for d in unassessed) + ".", ""]
        recs = [d for d in dims if d.get("recommendation") and d.get("status") != "assessed"][:3]
        if recs:
            L += ["**What would improve this run**", ""]
            for d in recs:
                L.append(f"- **{d['label']}** — {d['recommendation']}")
            L.append("")
        acc = quality.get("predictive_accuracy") or {}
        L += [f"**Predictive accuracy: {acc.get('label') or 'not validated'}.** "
              f"{acc.get('message') or ''}".strip(), ""]

    # ------------------------------------------------------------- limitations
    L += _rule("Limitations")
    L += [
        "- Agents are generated personas, not surveyed people.",
        "- Opinion updates use bounded-confidence heuristics that were not fitted to observed "
        "behaviour.",
        "- Model-written text varies even at a fixed seed; the structure is reproducible, the "
        "prose may not be.",
        "- Findings describe what happened inside this simulation, not what would happen in "
        "the world.",
        "- A configured group with no agents contributed nothing; the report says so where it "
        "applies.",
        "",
    ]

    # ------------------------------------------------------------- implications
    L += _rule("Implications")
    strongest = max((i for i in issue_rows if i.get("final_mean") is not None),
                    key=lambda i: i["final_mean"], default=None)
    weakest = min((i for i in issue_rows if i.get("final_mean") is not None),
                  key=lambda i: i["final_mean"], default=None)
    if strongest and weakest and strongest is not weakest:
        L += [
            f"Within this simulation, **{strongest['name']}** attracted the most support and "
            f"**{weakest['name']}** the least. If the simulated dynamics are a reasonable guide, "
            f"the second is where a real engagement effort would meet the most resistance — and "
            f"where the assumptions in this model most need checking against real evidence.",
            "",
        ]
    else:
        L += [
            "The run does not separate issues strongly enough to draw an implication about "
            "relative support. Increasing the population or the number of rounds would give "
            "the simulation more to work with.",
            "",
        ]
    L += [
        "**What would strengthen the next iteration:** link an observed dataset to this run so "
        "the predictions can be scored; run the same configuration with several seeds and "
        "compare; and add the stakeholder groups that received no agents.",
        "",
    ]

    # ---------------------------------------------------------------- appendix
    L += _rule("Appendix")
    L += ["### Recorded metrics", "", "| Metric | Value |", "|---|---|"]
    for k, v in analytics.items():
        L.append(f"| {k.replace('_', ' ')} | {v} |")
    L += ["", "### Agents", ""]
    if agents_all:
        L.append("| Handle | Name | Group |")
        L.append("|---|---|---|")
        for a in agents_all[:60]:
            L.append(f"| @{a['handle']} | {a['name']} | {a['stakeholder_group']} |")
        if len(agents_all) > 60:
            L.append(f"| … | {len(agents_all) - 60} more | |")
    else:
        L.append("No agents recorded.")
    L += ["", "### Evidence references", ""]
    if usage:
        for u in usage[:20]:
            L.append(f"- `{u['chunk_id']}` — pages {u.get('page_start')}–{u.get('page_end')}, "
                     f"{u['citations']} citation(s)")
    else:
        L.append("No source passages were cited.")
    L += ["", "### Technical information", ""]
    L += [
        f"- Run id: `{run.get('id')}`",
        f"- Status: `{run.get('status')}`",
        f"- Seed: `{run.get('seed')}`",
        f"- Prompt version: `{(db.uj(run.get('manifest_json'), {}) or {}).get('prompt_version', 'n/a')}`",
        f"- App version: `{(db.uj(run.get('manifest_json'), {}) or {}).get('app_version', 'n/a')}`",
        f"- Source SHA-256: `{(db.uj(run.get('manifest_json'), {}) or {}).get('source_sha256', 'n/a')}`",
        "",
    ]

    # ------------------------------------------------------------------ footer
    L += [
        "---",
        "",
        "_Every count in this report was computed from this run's recorded database rows. "
        "No AI wrote it: the narrative sentences are derived from those counts by rule. "
        "The only generated element is the optional executive-summary draft, which is stored "
        "and labelled separately. Export the full raw bundle as JSON or CSV for independent "
        "analysis._",
    ]
    return "\n".join(L)
