"""Realism Score: how well a simulation is *configured* to represent the world.

This is explicitly NOT prediction accuracy. Every dimension either counts something
that exists in the stored rows or reports "Not assessed" / "Not connected". The overall
value is a weighted average of the assessed dimensions only; unassessed dimensions are
listed and excluded, never filled in with a guess.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from app import db

NOT_ASSESSED = "not_assessed"
PARTIAL = "partial"
ASSESSED = "assessed"
NOT_CONNECTED = "not_connected"

_TARGET_CHUNKS = 6          # a source with at least this many cited chunks is well covered
_NETWORK_DENSITY_TARGET = 0.05

# Actionable guidance per dimension. Each entry says what to change and what that
# change would make measurable. This turns the panel from a score into a diagnostic;
# nothing here is a prediction.
_GUIDANCE: dict[str, dict[str, str]] = {
    "evidence_coverage": {
        "improve": "Raise the number of writing agents per round, or choose a source with "
                   "more distinct passages, so more posts can cite the document.",
        "requires": "More recorded posts that cite a chunk.",
    },
    "evidence_quality": {
        "improve": "Label the source's passages by authority or relevance, then connect those "
                   "labels as a validation dataset.",
        "requires": "A source-quality annotation scheme and a linked dataset.",
    },
    "agent_diversity": {
        "improve": "Add stakeholder groups with different archetypes, or raise the population "
                   "so more of the configured groups receive agents.",
        "requires": "More agents or more distinct archetypes recorded.",
    },
    "issue_coverage": {
        "improve": "Run at least one round with posting enabled so every issue receives "
                   "stance observations.",
        "requires": "Stance history rows for the missing issues.",
    },
    "stakeholder_representation": {
        "improve": "Raise the agent count to at least the number of configured groups so every "
                   "group receives one agent.",
        "requires": "One agent per configured group.",
    },
    "population_representation": {
        "improve": "Set an explicit population weight on every stakeholder group in the wizard.",
        "requires": "A population_weight on each configured group.",
    },
    "persona_grounding": {
        "improve": "Use a source with more extractable text so each persona has both a belief "
                   "summary and source chunks.",
        "requires": "At least one chunk in every agent's knowledge set.",
    },
    "behavioural_calibration": {
        "improve": "Link an observed behavioural dataset (for example a survey panel) and score "
                   "the update rule against it.",
        "requires": "Observed behaviour data and a calibration procedure.",
    },
    "starting_stance_calibration": {
        "improve": "Import a survey baseline and set each group's starting stance from it "
                   "rather than from the brief alone.",
        "requires": "Baseline survey data per stakeholder group.",
    },
    "information_exposure": {
        "improve": "Persist per-agent feed exposure so the panel can measure who saw what.",
        "requires": "Exposure event logging in the engine.",
    },
    "interaction_realism": {
        "improve": "Increase rounds or writes per round so agents have more chances to reply.",
        "requires": "More recorded replies and relationships.",
    },
    "network_realism": {
        "improve": "Adjust follow-graph seeding if the density is far from the target.",
        "requires": "A density closer to the sparse-graph target.",
    },
    "temporal_realism": {
        "improve": "Let the run complete, or resume it, so all configured rounds are recorded.",
        "requires": "last_completed_tick equal to the configured tick count.",
    },
    "stance_stability": {
        "improve": "Run more rounds to see whether positions settle or drift.",
        "requires": "Stance series spanning at least two rounds.",
    },
    "event_realism": {
        "improve": "Add a scheduled intervention in the wizard to test how the population "
                   "reacts to news.",
        "requires": "At least one scenario event.",
    },
    "provider_reliability": {
        "improve": "Use a faster or more reliable provider, or raise the timeout in Settings.",
        "requires": "Fewer failed provider calls in the audit log.",
    },
    "generation_quality": {
        "improve": "Choose a model that returns valid JSON more consistently, or lower the "
                   "temperature.",
        "requires": "More successful calls returning machine-valid structure.",
    },
    "configuration_completeness": {
        "improve": "Create runs through the wizard so the manifest is fully populated.",
        "requires": "All manifest fields recorded.",
    },
    "data_completeness": {
        "improve": "Generate a report after the run so every record layer exists.",
        "requires": "Agents, posts, stance history, relationships, metrics and a report.",
    },
    "replication_stability": {
        "improve": "Re-run this exact configuration with a different seed and compare the two "
                   "runs in Compare runs.",
        "requires": "A second run sharing this setup.",
    },
    "sensitivity_analysis": {
        "improve": "Sweep the key assumptions (weights, influence, activity, exposure, event "
                   "timing) and compare outcomes.",
        "requires": "An assumption-sweep harness.",
    },
    "historical_validation": {
        "improve": "Register an observed dataset and link predicted/observed pairs to this run.",
        "requires": "Rows in validation_datasets and validation_observations.",
    },
    "outcome_validation": {
        "improve": "Link an observed outcome for this scenario, then design an explicit "
                   "evaluation.",
        "requires": "An observed outcome dataset and an agreed error metric.",
    },
}


def _pct(n: float, d: float) -> Optional[int]:
    if d <= 0:
        return None
    return max(0, min(100, round(100.0 * n / d)))


def _dim(id_: str, label: str, group: str, weight: int, status: str,
         score: Optional[int], explanation: str, evidence: dict | None = None) -> dict:
    guide = _GUIDANCE.get(id_) or {}
    return {
        "id": id_, "label": label, "group": group, "weight": weight,
        "status": status, "score": score, "explanation": explanation,
        "evidence": evidence or {},
        # What to change, and what would become measurable if you did.
        "recommendation": guide.get("improve") or "",
        "requires": guide.get("requires") or "",
    }


def _load(run_id: str) -> dict:
    run = db.query_one("SELECT * FROM runs WHERE id=?", (run_id,))
    if run is None:
        raise ValueError(f"unknown run {run_id}")
    src_id = run["source_id"]
    source = db.query_one("SELECT * FROM sources WHERE id=?", (src_id,)) if src_id else None
    brief = db.uj(source["brief_json"], {}) if source and source["brief_json"] else {}
    agents = [dict(a) for a in db.query(
        "SELECT * FROM agents WHERE run_id=? ORDER BY id", (run_id,))]
    posts = [dict(p) for p in db.query(
        "SELECT id, tick, tick AS round, kind, agent_id, cited_chunk_ids_json FROM posts"
        " WHERE run_id=?", (run_id,))]
    for p in posts:
        p["cited"] = db.uj(p.pop("cited_chunk_ids_json"), []) or []
    chunks = db.query("SELECT id FROM chunks WHERE source_id=?", (src_id,)) if src_id else []
    calls = [dict(c) for c in db.query(
        "SELECT task, provider, model, status, parsed_ok, http_status, error FROM llm_calls"
        " WHERE run_id=?", (run_id,))]
    # Stance history is the only per-agent, per-issue time series in the database;
    # it lets stance stability be counted rather than guessed.
    stance_rows = db.query(
        "SELECT tick, agent_id, issue_id, value FROM stance_history WHERE run_id=?"
        " ORDER BY tick, agent_id, issue_id", (run_id,))
    return {
        "run": dict(run), "source": dict(source) if source else None, "brief": brief or {},
        "agents": agents, "posts": posts, "chunk_ids": [c["id"] for c in chunks],
        "calls": calls,
        "stance_rows": stance_rows,
        "edges": db.scalar("SELECT COUNT(*) FROM edges WHERE run_id=?", (run_id,)) or 0,
        "events": db.scalar(
            "SELECT COUNT(*) FROM events WHERE run_id=? AND kind IN ('scheduled','news')",
            (run_id,)) or 0,
        "observations": db.query(
            "SELECT dataset_id, metric, predicted, observed, error FROM validation_observations"
            " WHERE run_id=?", (run_id,)),
        "datasets": db.scalar("SELECT COUNT(*) FROM validation_datasets") or 0,
    }


def _group_shares(data: dict) -> tuple[list[dict], Optional[float]]:
    """Per-group population share, agent share and the largest deviation."""
    brief = data["brief"]
    groups = brief.get("stakeholder_groups") or []
    agents = data["agents"]
    out = []
    max_dev: Optional[float] = None
    weights = []
    for g in groups:
        w = g.get("population_weight")
        try:
            w = float(w) if w not in (None, "") else None
        except (TypeError, ValueError):
            w = None
        weights.append(w)
        count = sum(1 for a in agents if (a.get("stakeholder_group") or "") == (g.get("name") or ""))
        share = count / len(agents) if agents else 0.0
        out.append({"name": g.get("name") or "Unnamed group",
                    "population_weight": w, "agents": count, "agent_share": round(share, 3)})
    if weights and all(w is not None and w > 0 for w in weights) and agents:
        total_w = sum(weights)
        for row, w in zip(out, weights):
            pop_share = w / total_w
            dev = abs(pop_share - row["agent_share"])
            max_dev = dev if max_dev is None else max(max_dev, dev)
            row["population_share"] = round(pop_share, 3)
    return out, max_dev


def compute_realism(run_id: str) -> dict:
    data = _load(run_id)
    run = data["run"]
    cfg = db.uj(run["config_json"], {}) or {}
    manifest = db.uj(run["manifest_json"], {}) or {}
    agents = data["agents"]
    posts = data["posts"]
    brief = data["brief"]
    groups = brief.get("stakeholder_groups") or []
    issues = brief.get("issues") or []
    chunk_ids = set(data["chunk_ids"])
    dims: list[dict] = []

    # --- evidence ---------------------------------------------------------
    sourced = [p for p in posts if p["cited"]]
    cited = {c for p in sourced for c in p["cited"]}
    if posts:
        coverage = len(sourced) / len(posts)
        reach = min(1.0, len(cited) / max(1, min(_TARGET_CHUNKS, len(chunk_ids) or _TARGET_CHUNKS)))
        score = round(100 * (0.6 * coverage + 0.4 * reach))
        dims.append(_dim(
            "evidence_coverage", "Evidence coverage", "Evidence", 15, ASSESSED, score,
            f"{len(sourced)} of {len(posts)} posts cite a source chunk; "
            f"{len(cited)} of {len(chunk_ids)} extracted chunks are cited at least once.",
            {"posts": len(posts), "sourced_posts": len(sourced),
             "distinct_chunks_cited": len(cited), "chunks": len(chunk_ids)}))
    else:
        dims.append(_dim("evidence_coverage", "Evidence coverage", "Evidence", 15,
                         NOT_ASSESSED, None, "No posts recorded yet."))

    dims.append(_dim(
        "evidence_quality", "Evidence quality", "Evidence", 10, NOT_ASSESSED, None,
        "The system extracts text and page bounds but does not label source quality, "
        "authority or relevance. Connect a validation dataset to assess it."))

    # --- population -------------------------------------------------------
    if agents:
        # Agent diversity: how many distinct archetypes and stakeholder groups the
        # population actually contains, normalised against what was configured.
        archetypes = {a.get("archetype") or "" for a in agents}
        archetypes.discard("")
        agent_groups = {a.get("stakeholder_group") or "" for a in agents}
        agent_groups.discard("")
        target_arch = min(len(agents), max(1, len(agent_groups) * 2))
        arch_score = _pct(len(archetypes), target_arch)
        dims.append(_dim(
            "agent_diversity", "Agent diversity", "Population", 10, ASSESSED, arch_score,
            f"{len(agents)} agents span {len(archetypes)} archetype(s) across "
            f"{len(agent_groups)} stakeholder group(s). Diversity counts distinct recorded "
            "archetypes, not personality similarity.",
            {"agents": len(agents), "archetypes": sorted(archetypes),
             "groups": sorted(agent_groups), "target_archetypes": target_arch}))

        # Issue coverage: every configured issue should be observable in the record.
        if issues:
            stance_issue_ids = {r["issue_id"] for r in data["stance_rows"]}
            covered = [i["id"] for i in issues if i["id"] in stance_issue_ids]
            score = _pct(len(covered), len(issues))
            missing = [i["name"] for i in issues if i["id"] not in stance_issue_ids]
            dims.append(_dim(
                "issue_coverage", "Issue coverage", "Population", 10, ASSESSED, score,
                f"{len(covered)} of {len(issues)} configured issue(s) have recorded stance "
                "observations."
                + (f" No stance rows yet for: {', '.join(missing[:5])}." if missing else ""),
                {"issues": len(issues), "covered": covered, "missing": missing}))
        else:
            dims.append(_dim("issue_coverage", "Issue coverage", "Population", 10,
                             NOT_ASSESSED, None, "No issues configured."))

    if groups and agents:
        represented = 0
        for g in groups:
            if any((a.get("stakeholder_group") or "") == (g.get("name") or "") for a in agents):
                represented += 1
        score = _pct(represented, len(groups))
        rows, max_dev = _group_shares(data)
        note = ""
        if max_dev is not None and max_dev > 0.2:
            worst = max(rows, key=lambda r: abs((r.get("population_share") or 0) - r["agent_share"]))
            note = (f" Representation warning: {worst['name']} is "
                    f"{round(100 * worst['agent_share'])}% of agents but "
                    f"{round(100 * (worst.get('population_share') or 0))}% of the configured population.")
        dims.append(_dim(
            "stakeholder_representation", "Stakeholder representation", "Population", 15,
            ASSESSED, score,
            f"{represented} of {len(groups)} configured stakeholder groups have at least one "
            f"agent; {len(issues)} issue(s) are modelled.{note}",
            {"groups": len(groups), "groups_with_agents": represented,
             "rows": rows, "max_share_deviation": None if max_dev is None else round(max_dev, 3)}))
    else:
        dims.append(_dim("stakeholder_representation", "Stakeholder representation", "Population",
                         15, NOT_ASSESSED, None,
                         "No stakeholder groups or no agents are configured yet."))

    weights_ok = bool(groups) and all(
        g.get("population_weight") not in (None, "") for g in groups)
    pop_score = 100 if weights_ok else (50 if groups else None)
    pop_status = ASSESSED if weights_ok else (PARTIAL if groups else NOT_ASSESSED)
    rows, _ = _group_shares(data)
    dims.append(_dim(
        "population_representation", "Population weights", "Population", 10, pop_status, pop_score,
        ("Every stakeholder group has an explicit population weight."
         if weights_ok else
         "Some groups rely on a size hint instead of an explicit population weight; "
         "the sampling distribution is therefore approximate.")
        if groups else "No stakeholder groups configured.",
        {"rows": rows}))

    # --- personas and behaviour ------------------------------------------
    if agents:
        grounded = sum(1 for a in agents
                       if (a.get("belief_summary") or "").strip()
                       and len(db.uj(a.get("knowledge_json"), []) or []) > 0)
        score = _pct(grounded, len(agents))
        dims.append(_dim(
            "persona_grounding", "Persona grounding", "Behaviour", 10, ASSESSED, score,
            f"{grounded} of {len(agents)} agents have both a belief summary and at least one "
            "document chunk in their knowledge set.",
            {"agents": len(agents), "grounded": grounded}))
    else:
        dims.append(_dim("persona_grounding", "Persona grounding", "Behaviour", 10,
                         NOT_ASSESSED, None, "No agents seeded yet."))

    dims.append(_dim(
        "behavioural_calibration", "Behavioural calibration", "Behaviour", 10, NOT_ASSESSED, None,
        "Opinion updates use bounded-confidence rules, not parameters fitted to observed "
        "behaviour. No behavioural dataset is connected."))
    dims.append(_dim(
        "starting_stance_calibration", "Starting-stance calibration", "Behaviour", 5,
        NOT_ASSESSED, None,
        "Initial stances come from the scenario brief and the seed, not from a survey baseline."))
    dims.append(_dim(
        "information_exposure", "Information exposure", "Behaviour", 10, NOT_ASSESSED, None,
        "Feeds are scored per agent, but individual exposure events are not stored, so "
        "exposure realism cannot be measured from the database yet."))

    # --- interaction / network -------------------------------------------
    replies = sum(1 for p in posts if p["kind"] == "reply")
    if agents:
        edge_ratio = min(1.0, data["edges"] / len(agents))
        reply_ratio = min(1.0, replies / len(agents))
        score = round(100 * (0.5 * edge_ratio + 0.5 * reply_ratio))
        dims.append(_dim(
            "interaction_realism", "Interaction realism", "Network", 10, ASSESSED, score,
            f"{data['edges']} recorded relationships and {replies} replies for {len(agents)} agents.",
            {"edges": data["edges"], "replies": replies, "agents": len(agents)}))
        possible = len(agents) * (len(agents) - 1)
        density = (data["edges"] / possible) if possible else 0.0
        dims.append(_dim(
            "network_realism", "Network density", "Network", 5, ASSESSED,
            min(100, round(100 * density / _NETWORK_DENSITY_TARGET)),
            f"Relationship density is {density:.3f} "
            f"(target {_NETWORK_DENSITY_TARGET}; follow graphs are normally sparse).",
            {"density": round(density, 4)}))
    else:
        dims.append(_dim("interaction_realism", "Interaction realism", "Network", 10,
                         NOT_ASSESSED, None, "No agents yet."))
        dims.append(_dim("network_realism", "Network density", "Network", 5,
                         NOT_ASSESSED, None, "No agents yet."))

    # --- temporal / events ------------------------------------------------
    ticks = int(cfg.get("ticks") or 0)
    done = int(run["last_completed_tick"] or 0)
    if ticks:
        score = _pct(min(done, ticks), ticks)
        status = ASSESSED if done >= ticks else PARTIAL
        dims.append(_dim(
            "temporal_realism", "Round coverage", "Temporal", 10, status, score,
            f"{done} of {ticks} configured rounds completed."
            + ("" if done >= ticks else " The run is incomplete; later-round dynamics are not represented."),
            {"rounds_done": done, "rounds": ticks}))
    else:
        dims.append(_dim("temporal_realism", "Round coverage", "Temporal", 10,
                         NOT_ASSESSED, None, "No round count configured."))

    # Stance stability: how much agents actually moved, counted from stance_history.
    # Low movement is not automatically "good"; it is reported as a behaviour fact.
    rows = data["stance_rows"]
    if rows:
        by_agent_issue: dict[tuple[str, str], list[float]] = {}
        for r in rows:
            by_agent_issue.setdefault((r["agent_id"], r["issue_id"]), []).append(
                float(r["value"] or 0.0))
        deltas = []
        movers = 0
        for series in by_agent_issue.values():
            if len(series) < 2:
                continue
            span = abs(series[-1] - series[0])
            deltas.append(span)
            if span >= 0.2:
                movers += 1
        if deltas:
            avg_span = sum(deltas) / len(deltas)
            # Stability is high when movement stays modest; an entirely frozen
            # population would score 100 but is reported alongside the mover count.
            stability = max(0, min(100, round(100 * (1 - min(1.0, avg_span)))))
            dims.append(_dim(
                "stance_stability", "Stance stability", "Temporal", 10, ASSESSED, stability,
                f"{len(deltas)} agent-issue series; mean start-to-end change {avg_span:.3f} on a "
                f"-1..1 scale, {movers} series moved 0.2 or more. Stability measures persistence, "
                "not correctness.",
                {"series": len(deltas), "mean_span": round(avg_span, 4),
                 "movers": movers}))
        else:
            dims.append(_dim(
                "stance_stability", "Stance stability", "Temporal", 10, PARTIAL, None,
                "Stance history exists but no series spans two rounds yet."))
    else:
        dims.append(_dim(
            "stance_stability", "Stance stability", "Temporal", 10, NOT_ASSESSED, None,
            "No stance history recorded yet."))

    if data["events"]:
        dims.append(_dim(
            "event_realism", "Interventions", "Temporal", 5, ASSESSED, 100,
            f"{data['events']} intervention record(s) are present; each is stored with its round "
            "and audience.", {"interventions": data["events"]}))
    else:
        dims.append(_dim(
            "event_realism", "Interventions", "Temporal", 5, NOT_ASSESSED, None,
            "No interventions were configured. That is a scenario choice, not a quality failure."))

    # --- configuration ----------------------------------------------------
    checks = {
        "provider": bool((db.uj(run["provider_json"], {}) or {}).get("name")),
        "model": bool((db.uj(run["provider_json"], {}) or {}).get("model")),
        "seed": run["seed"] is not None,
        "source_sha256": bool(manifest.get("source_sha256")),
        "prompt_version": bool(manifest.get("prompt_version")),
        "app_version": bool(manifest.get("app_version")),
    }
    dims.append(_dim(
        "configuration_completeness", "Run manifest", "Configuration", 5, ASSESSED,
        _pct(sum(checks.values()), len(checks)),
        "Manifest fields recorded: " + ", ".join(k for k, v in checks.items() if v)
        + ("." if all(checks.values()) else " (missing: "
           + ", ".join(k for k, v in checks.items() if not v) + ")."),
        checks))

    # --- provider and generation health -----------------------------------
    # These come from the llm_calls audit log, so a failed call is visible rather
    # than hidden. They describe the transport, not the accuracy of the content.
    calls = data["calls"]
    if calls:
        attempted = len(calls)
        failed = sum(1 for c in calls if (c.get("status") or "") not in ("ok", "cached", "replay"))
        ok = attempted - failed
        ok_score = _pct(ok, attempted)
        dims.append(_dim(
            "provider_reliability", "Provider reliability", "Configuration", 10, ASSESSED, ok_score,
            f"{ok} of {attempted} recorded provider call(s) succeeded; {failed} failed. "
            "This counts transport outcomes, not answer quality.",
            {"calls": attempted, "ok": ok, "failed": failed,
             "providers": sorted({c.get("provider") or "" for c in calls if c.get("provider")})}))
        parsed = sum(1 for c in calls if c.get("parsed_ok"))
        scored = sum(1 for c in calls if (c.get("status") or "") == "ok")
        quality = _pct(parsed, scored) if scored else None
        dims.append(_dim(
            "generation_quality", "Generation quality", "Configuration", 10,
            ASSESSED if quality is not None else PARTIAL, quality,
            f"{parsed} of {scored} successful call(s) returned machine-valid structure; the rest "
            "fell back to a retry, a fallback model or a template."))
    else:
        dims.append(_dim(
            "provider_reliability", "Provider reliability", "Configuration", 10, NOT_ASSESSED, None,
            "No provider calls were recorded for this run."))
        dims.append(_dim(
            "generation_quality", "Generation quality", "Configuration", 10, NOT_ASSESSED, None,
            "No provider calls were recorded for this run."))

    # --- data completeness -------------------------------------------------
    # Presence, not quality: does each layer of the record actually exist?
    layer_checks = {
        "agents": bool(agents),
        "posts": bool(posts),
        "stance_history": bool(data["stance_rows"]),
        "relationships": data["edges"] > 0,
        "metrics": (db.scalar("SELECT COUNT(*) FROM metrics WHERE run_id=?", (run_id,)) or 0) > 0,
        "report": (db.scalar("SELECT COUNT(*) FROM reports WHERE run_id=?", (run_id,)) or 0) > 0,
    }
    dims.append(_dim(
        "data_completeness", "Data completeness", "Configuration", 5, ASSESSED,
        _pct(sum(layer_checks.values()), len(layer_checks)),
        "Recorded layers: " + ", ".join(k for k, v in layer_checks.items() if v)
        + ("." if all(layer_checks.values()) else " (empty: "
           + ", ".join(k for k, v in layer_checks.items() if not v) + ")."),
        layer_checks))

    # --- robustness -------------------------------------------------------
    comparable = db.scalar(
        "SELECT COUNT(*) FROM runs WHERE id<>? AND source_id=? AND config_json=?",
        (run_id, run["source_id"], run["config_json"])) or 0
    if comparable >= 2:
        dims.append(_dim(
            "replication_stability", "Replication stability", "Robustness", 10, PARTIAL, None,
            f"{comparable + 1} runs share this exact setup, but automated cross-run stability "
            "analysis is not implemented. Compare them manually in Compare runs."))
    else:
        dims.append(_dim(
            "replication_stability", "Replication stability", "Robustness", 10, NOT_ASSESSED, None,
            "Only one run exists for this setup. Re-run with a new seed and compare to assess stability."))
    dims.append(_dim(
        "sensitivity_analysis", "Sensitivity analysis", "Robustness", 5, NOT_ASSESSED, None,
        "Assumption sweeps (weights, influence, activity, exposure, event timing) are not "
        "implemented. Findings are therefore from one configuration."))

    # --- validation -------------------------------------------------------
    observations = list(data["observations"])
    if observations:
        errors = [abs(float(o["error"])) for o in observations if o["error"] is not None]
        dims.append(_dim(
            "historical_validation", "Historical validation", "Validation", 10, PARTIAL, None,
            f"{len(observations)} observed outcome(s) are connected; this panel does not compute "
            "prediction accuracy, and no accuracy claim is made.",
            {"observations": len(observations),
             "mean_absolute_error": (round(sum(errors) / len(errors), 4) if errors else None)}))
    else:
        dims.append(_dim(
            "historical_validation", "Historical validation", "Validation", 10, NOT_CONNECTED, None,
            "Validation data not connected. No observed outcomes are linked to this run."))
    dims.append(_dim(
        "outcome_validation", "Outcome validation", "Validation", 10, NOT_CONNECTED, None,
        "No observed outcome is linked, so predictive accuracy is not measured or claimed."))

    assessed = [d for d in dims if d["score"] is not None]
    total_weight = sum(d["weight"] for d in assessed)
    overall_score = (round(sum(d["score"] * d["weight"] for d in assessed) / total_weight)
                     if total_weight else None)
    if overall_score is None:
        label = "Not assessed"
    elif overall_score >= 80:
        label = "Strong configuration"
    elif overall_score >= 60:
        label = "Moderate configuration"
    elif overall_score >= 40:
        label = "Limited configuration"
    else:
        label = "Exploratory configuration"

    if observations:
        accuracy = {
            "status": "data_connected",
            "label": "Validation data connected",
            "observations": len(observations),
            "message": ("Observed outcomes are connected. Prediction accuracy is not computed or "
                        "claimed by this panel; a proper evaluation must be designed explicitly."),
        }
    else:
        accuracy = {
            "status": "not_validated",
            "label": "Not validated",
            "observations": 0,
            "message": ("No observed outcomes are connected. The Social World does not claim "
                        "predictive accuracy for real-world opinion or behaviour."),
        }

    # --- diagnostic summary: what is strong, what to fix, what cannot be assessed
    strong = [d for d in assessed if (d["score"] or 0) >= 75]
    weak = [d for d in assessed if (d["score"] or 0) < 60]
    unassessed = [d for d in dims if d["score"] is None]

    # Recommendations ordered by how much fixing them would move the score: weight
    # first, then how far the dimension is from a good score.
    ranked = sorted(
        weak,
        key=lambda d: (-(d["weight"] * (75 - (d["score"] or 0))), d["id"]),
    )
    actions = []
    for d in ranked[:5]:
        if not d["recommendation"]:
            continue
        actions.append({
            "dimension": d["id"],
            "label": d["label"],
            "group": d["group"],
            "score": d["score"],
            "recommendation": d["recommendation"],
            "requires": d["requires"],
        })

    summary = {
        "strong": [{"id": d["id"], "label": d["label"], "score": d["score"]} for d in strong],
        "attention": [{"id": d["id"], "label": d["label"], "score": d["score"]} for d in weak],
        "not_assessed": [{"id": d["id"], "label": d["label"], "status": d["status"],
                          "requires": d["requires"]} for d in unassessed],
        "actions": actions,
        "headline": (
            "This run is well configured and internally consistent."
            if overall_score is not None and overall_score >= 80 else
            "This run is usable but has gaps worth closing before relying on it."
            if overall_score is not None and overall_score >= 55 else
            "This run is exploratory: treat its findings as hypotheses, not results."
            if overall_score is not None else
            "Not enough recorded data to assess this run."
        ),
    }

    return {
        "run_id": run_id,
        "overall": {
            "score": overall_score,
            "label": label,
            "assessed_dimensions": len(assessed),
            "total_dimensions": len(dims),
            "method": ("Weighted average of assessed dimensions only. Unassessed dimensions are "
                       "listed and excluded. This is a configuration-quality score, not "
                       "predictive accuracy."),
        },
        "summary": summary,
        "predictive_accuracy": accuracy,
        "validation": {
            "connected": bool(observations),
            "datasets": data["datasets"],
            "observations": len(observations),
            "message": ("Validation data not connected."
                        if not observations else "Observed outcomes are connected."),
        },
        "dimensions": dims,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
