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


def _pct(n: float, d: float) -> Optional[int]:
    if d <= 0:
        return None
    return max(0, min(100, round(100.0 * n / d)))


def _dim(id_: str, label: str, group: str, weight: int, status: str,
         score: Optional[int], explanation: str, evidence: dict | None = None) -> dict:
    return {
        "id": id_, "label": label, "group": group, "weight": weight,
        "status": status, "score": score, "explanation": explanation,
        "evidence": evidence or {},
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
    return {
        "run": dict(run), "source": dict(source) if source else None, "brief": brief or {},
        "agents": agents, "posts": posts, "chunk_ids": [c["id"] for c in chunks],
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
