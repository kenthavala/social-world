"""End-to-end acceptance run against the real HTTP API surface.

Drives the exact request sequence the wizard and run room issue, with the mock
provider, and asserts the acceptance criteria from the brief. Run with:

    python tools/e2e_acceptance.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path

DATA = Path(tempfile.mkdtemp(prefix="tsw-e2e-"))
os.environ["OASIS_DATA_DIR"] = str(DATA)
os.environ["LLM_PROVIDER"] = "mock"
os.environ["LLM_MODEL"] = "mock-1"

BACKEND = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

PASS, FAIL = [], []


def check(name: str, ok: bool, detail: str = "") -> None:
    (PASS if ok else FAIL).append(name)
    print(f"{'PASS' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")


SOURCE_TEXT = (
    "Transport policy is contested. Supporters say the congestion charge cuts emissions "
    "and funds public transport. Opponents say it raises costs for households and hurts "
    "small business. Residents near the centre are divided, while commuters from the "
    "suburbs are more supportive. Environmental groups want a higher charge; trade bodies "
    "want exemptions for local firms. The council must decide before the budget review. "
) * 30

ISSUES = [
    ("iss_1", "Congestion charge level", "policy.transport"),
    ("iss_2", "Revenue use", "policy.infrastructure"),
    ("iss_3", "Small business exemptions", "business.regulation"),
    ("iss_4", "Air quality impact", "policy.environment"),
    ("iss_5", "Implementation timeline", "policy.urban_planning"),
]
GROUPS = [
    "Inner-city residents", "Suburban commuters", "Small businesses",
    "Environmental groups", "Local government", "Trade bodies",
]


def main() -> int:
    with TestClient(app, raise_server_exceptions=False) as client:
        # --- health / settings -------------------------------------------------
        h = client.get("/api/health")
        check("health responds", h.status_code == 200, str(h.status_code))
        s = client.get("/api/settings")
        check("settings exposes provider", s.status_code == 200
              and s.json()["settings"]["llm_provider"] == "mock")
        check("settings never leaks keys", "API_KEY=" not in s.text and "sk-" not in s.text)

        # --- wizard step 1: upload source -------------------------------------
        up = client.post("/api/sources", data={"text": SOURCE_TEXT, "filename": "policy.txt"})
        check("upload source", up.status_code == 200, up.text[:120])
        src = up.json()
        source_id = src["source_id"]
        check("source extracted", src["status"] == "extracted", src["status"])
        check("source has chunks", src["chunks"] > 0, str(src["chunks"]))

        # --- wizard step 2: generate brief ------------------------------------
        gb = client.post(f"/api/sources/{source_id}/brief", json={
            "scenario": "How will residents and businesses respond to the congestion charge?",
            "max_issues": 5, "max_groups": 6,
        })
        check("generate brief", gb.status_code == 200, gb.text[:160])
        brief = gb.json()["brief"]
        check("brief has issues", len(brief["issues"]) >= 1, str(len(brief["issues"])))
        check("brief has groups", len(brief["stakeholder_groups"]) >= 1,
              str(len(brief["stakeholder_groups"])))

        # --- wizard step 3/4: user edits 5 issues and 6 groups ----------------
        edited = {
            "summary": "Congestion charge consultation.",
            "issues": [
                {
                    "id": iid, "name": name,
                    "question": f"What should happen about {name.lower()}?",
                    "pro_label": "Supports", "con_label": "Opposes",
                    "evidence_chunk_ids": [],
                    "category": cat,
                    "detailed_context": f"Context for {name}",
                    "importance": 0.8,
                    "keywords": ["transport", "cost"],
                }
                for iid, name, cat in ISSUES
            ],
            "stakeholder_groups": [
                {
                    "name": g,
                    "description": f"{g} perspective",
                    "size_hint": ["small", "medium", "large"][i % 3],
                    "stance_by_issue": {
                        iid: round(((j * 7 + i * 3) % 5 - 2) / 2, 2)
                        for j, (iid, _n, _c) in enumerate(ISSUES)
                    },
                    "population_weight": 1.0 + i * 0.1,
                    "interests": ["cost", "reliability"],
                    "concerns": ["implementation"],
                    "influence": 2 + i % 4,
                    "trust_level": 0.4 + 0.1 * (i % 3),
                }
                for i, g in enumerate(GROUPS)
            ],
            "key_claims": [], "entities": [],
        }
        put = client.put(f"/api/sources/{source_id}/brief", json={"brief": edited})
        check("save edited brief", put.status_code == 200, put.text[:160])
        saved = put.json()["brief"]
        check("all 5 issues persisted", len(saved["issues"]) == 5, str(len(saved["issues"])))
        check("all 6 groups persisted", len(saved["stakeholder_groups"]) == 6,
              str(len(saved["stakeholder_groups"])))
        check("extended issue fields persist",
              saved["issues"][0].get("category") == "policy.transport",
              str(saved["issues"][0].get("category")))
        check("extended group fields persist",
              saved["stakeholder_groups"][0].get("interests") == ["cost", "reliability"],
              str(saved["stakeholder_groups"][0].get("interests")))

        # --- wizard step 5-8: create and launch the run -----------------------
        created = client.post("/api/runs", json={
            "source_id": source_id,
            "name": "E2E congestion charge",
            "scenario_json": {"question": "How will people respond?", "events": []},
            "config": {"agents": 24, "ticks": 10, "writes_per_tick": 4, "seed": 777,
                       "pop_mix": {"pro": 0.3, "con": 0.3, "undecided": 0.4}},
        })
        check("create run", created.status_code == 200, created.text[:160])
        run = created.json()
        run_id = run["id"]
        check("run starts as draft", run["status"] == "draft", run["status"])

        started = client.post(f"/api/runs/{run_id}/start")
        check("start run", started.status_code == 200, started.text[:160])

        status = None
        deadline = time.time() + 240
        while time.time() < deadline:
            detail = client.get(f"/api/runs/{run_id}").json()
            status = detail["status"]
            if status in ("completed", "interrupted", "failed"):
                break
            time.sleep(1.0)
        check("run completed", status == "completed", str(status))

        detail = client.get(f"/api/runs/{run_id}").json()
        check("24 agents seeded", detail["agents"] == 24, str(detail["agents"]))
        check("posts recorded", detail["posts"] > 0, str(detail["posts"]))
        check("10 rounds done", detail["last_completed_tick"] == 10,
              str(detail["last_completed_tick"]))

        # --- agents ------------------------------------------------------------
        agents = client.get(f"/api/runs/{run_id}/agents").json()["agents"]
        groups_seen = {a["group"] for a in agents}
        check("every stakeholder group has an agent", groups_seen == set(GROUPS),
              f"{len(groups_seen)}/{len(GROUPS)}")
        expected = frozenset(iid for iid, _n, _c in ISSUES)
        issue_keys = [frozenset(a["stances"].keys()) for a in agents]
        check("every agent holds all 5 issues",
              set(issue_keys) == {expected},
              str({tuple(sorted(k)) for k in set(issue_keys)}))
        one = client.get(f"/api/runs/{run_id}/agents/{agents[0]['id']}")
        check("agent detail loads", one.status_code == 200, str(one.status_code))

        # --- graph / connections ----------------------------------------------
        graph = client.get(f"/api/runs/{run_id}/graph")
        check("graph responds", graph.status_code == 200, str(graph.status_code))
        g = graph.json()
        check("graph has nodes", len(g.get("nodes", [])) > 0, str(len(g.get("nodes", []))))
        check("graph has edges", len(g.get("edges", [])) > 0, str(len(g.get("edges", []))))

        # --- findings ----------------------------------------------------------
        f = client.get(f"/api/runs/{run_id}/findings")
        check("findings respond", f.status_code == 200, str(f.status_code))
        fd = f.json()
        by_id = {x["id"]: x for x in fd["findings"]}
        check("findings include issues", "issues" in by_id)
        check("findings cover all 5 issues",
              len(by_id.get("issues", {}).get("rows", [])) == 5,
              str(len(by_id.get("issues", {}).get("rows", []))))
        check("findings cover all 6 groups",
              len(by_id.get("groups", {}).get("rows", [])) == 6,
              str(len(by_id.get("groups", {}).get("rows", []))))

        # --- quality -----------------------------------------------------------
        q = client.get(f"/api/runs/{run_id}/realism")
        check("quality responds", q.status_code == 200, str(q.status_code))
        qd = q.json()
        ids = {d["id"] for d in qd["dimensions"]}
        required = {"evidence_coverage", "agent_diversity", "issue_coverage",
                    "stakeholder_representation", "stance_stability",
                    "provider_reliability", "generation_quality", "data_completeness",
                    "historical_validation", "outcome_validation"}
        check("quality covers required dimensions", required <= ids,
              str(sorted(required - ids)))
        check("quality labels itself configuration quality",
              "not predictive accuracy" in qd["overall"]["method"].lower())
        check("quality disclaims predictive accuracy",
              qd["predictive_accuracy"]["status"] == "not_validated")
        for d in qd["dimensions"]:
            if d["status"] in ("not_assessed", "not_connected"):
                assert d["score"] is None, d["id"]
        check("no score invented for unassessed dimensions", True)
        summary = qd.get("summary") or {}
        check("quality offers actionable guidance",
              isinstance(summary.get("actions"), list) and summary.get("headline"),
              str(list(summary.keys())))
        check("quality separates strong / attention / unassessed",
              all(k in summary for k in ("strong", "attention", "not_assessed")))

        # --- narrative (computed interpretation) -------------------------------
        nv = client.get(f"/api/runs/{run_id}/narrative")
        check("narrative responds", nv.status_code == 200, str(nv.status_code))
        nd = nv.json()
        check("narrative is marked computed, not generated",
              nd["provenance"]["kind"] == "computed"
              and "No model call" in nd["provenance"]["method"])
        check("narrative covers every issue", len(nd["issues"]) == len(ISSUES),
              str(len(nd["issues"])))
        check("narrative covers every stakeholder group",
              len(nd["stakeholders"]) == len(GROUPS), str(len(nd["stakeholders"])))
        check("narrative answers all eight reader questions",
              all(nd["answers"].get(k, "").strip() for k in (
                  "what_happened", "why", "who_drove_it", "what_evidence",
                  "agreement", "disagreement", "what_changed", "watch")))
        check("key findings carry a strength label and evidence text",
              all(f["strength"] in ("strong", "moderate", "indicative")
                  and "not a probability" in f["strength_reason"].lower()
                  for f in nd["key_findings"]),
              str(len(nd["key_findings"])))
        check("narrative states uncertainty",
              any("persona" in u.lower() for u in nd["uncertainty"]))

        # --- agents carry group attributes -------------------------------------
        first_agent = agents[0]
        check("agents expose configured influence",
              "influence" in first_agent, str(first_agent.keys()))
        names = [a["name"] for a in agents]
        check("agent display names are unique", len(names) == len(set(names)),
              f"{len(names) - len(set(names))} duplicate(s)")

        # --- documents: evidence library --------------------------------------
        ev = client.get(f"/api/sources/{source_id}/evidence")
        check("source evidence responds", ev.status_code == 200, str(ev.status_code))
        ed = ev.json()
        check("evidence lists configured issues", len(ed["issues"]) == 5,
              str(len(ed["issues"])))
        check("evidence lists configured groups", len(ed["stakeholder_groups"]) == 6,
              str(len(ed["stakeholder_groups"])))
        check("evidence reports the run that used it", len(ed["usage"]) == 1,
              str(len(ed["usage"])))
        check("evidence reports citation coverage",
              ed["coverage"]["citation_total"] > 0
              and ed["coverage"]["chunks_cited"] > 0,
              str(ed["coverage"]))
        real_chunks = {c["id"] for c in client.get(
            f"/api/sources/{source_id}/chunks").json()["chunks"]}
        check("every evidence passage is a stored chunk",
              all(c["id"] in real_chunks for c in ed["chunks"]),
              f"{len(ed['chunks'])} passages")

        # --- report ------------------------------------------------------------
        rep = client.post(f"/api/runs/{run_id}/report")
        check("generate report", rep.status_code == 200, rep.text[:160])
        rd = rep.json()
        md = rd.get("report_md") or rd.get("report", {}).get("report_md") or ""
        check("report is substantial", len(md) > 1500, f"{len(md)} chars")
        for _iid, name, _cat in ISSUES:
            check(f"report names issue '{name}'", name in md)
        for gname in GROUPS:
            check(f"report names group '{gname}'", gname in md)
        check("report states validation status",
              "has not yet been externally validated" in md.lower())
        check("report includes limitations", "## limitations" in md.lower())

        # --- exports -----------------------------------------------------------
        for fmt in ("json", "md", "csv"):
            ex = client.get(f"/api/runs/{run_id}/export?format={fmt}")
            check(f"export {fmt}", ex.status_code == 200 and len(ex.content) > 100,
                  f"{ex.status_code} {len(ex.content)}B")

        # --- regeneration must not change counted data ------------------------
        before = client.get(f"/api/runs/{run_id}/findings").json()
        rep2 = client.post(f"/api/runs/{run_id}/report")
        after = client.get(f"/api/runs/{run_id}/findings").json()
        check("report regeneration keeps findings identical",
              json.dumps(before, sort_keys=True) == json.dumps(after, sort_keys=True))
        check("report regenerates", rep2.status_code == 200)

        # --- log / provenance ---------------------------------------------------
        log = client.get(f"/api/runs/{run_id}/llm-calls")
        check("llm call log responds", log.status_code == 200, str(log.status_code))
        errors = client.get(f"/api/runs/{run_id}/errors")
        check("error log responds", errors.status_code == 200, str(errors.status_code))
        metrics = client.get(f"/api/runs/{run_id}/metrics")
        check("metrics respond", metrics.status_code == 200, str(metrics.status_code))
        groups_ep = client.get(f"/api/runs/{run_id}/groups")
        check("groups endpoint responds", groups_ep.status_code == 200,
              str(groups_ep.status_code))
        changes = client.get(f"/api/runs/{run_id}/stance-changes")
        check("stance changes respond", changes.status_code == 200,
              str(changes.status_code))
        validation = client.get(f"/api/runs/{run_id}/validation")
        check("per-run validation responds", validation.status_code == 200,
              str(validation.status_code))
        stats = client.get(f"/api/runs/{run_id}/stats")
        check("run stats respond", stats.status_code == 200, str(stats.status_code))

        # --- compare: counted diffs and the honest empty-side path --------------
        br = client.post(f"/api/runs/{run_id}/branch", json={
            "text": "A half-price monthly pass is announced.", "audience": "all"})
        check("branch creates an intervention run", br.status_code == 200, str(br.status_code))
        cmp = client.get(f"/api/runs/{run_id}/compare?other={br.json()['id']}")
        check("compare responds", cmp.status_code == 200, str(cmp.status_code))
        d = cmp.json()
        check("compare reports per-round stance mix key", "rounds_mix" in d["diffs"])
        check("compare reports per-issue stances key", "issues" in d["diffs"])
        check("compare notes the re-run has no stance history yet",
              any("stance-history" in n.lower() for n in d["diffs"].get("notes", [])),
              str(d["diffs"].get("notes"))[:110])
        check("compare is labelled a counted comparison",
              "counted" in d["label"])

    print()
    print(f"RESULT: {len(PASS)} passed, {len(FAIL)} failed")
    if FAIL:
        print("failed:", ", ".join(FAIL))
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
