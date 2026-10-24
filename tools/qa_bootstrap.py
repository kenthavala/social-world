"""Build a QA dataset against a *running* backend (not TestClient).

Used to give the visual/bug-hunt harnesses a real, fully-populated run to
inspect: one source, a generated-then-edited brief (5 issues / 6 groups) and a
completed run. Matches the request shapes in tools/e2e_acceptance.py.

    python tools/qa_bootstrap.py [base_url]

Prints the run id as the last line.
"""
from __future__ import annotations

import sys
import time

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"

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
    with httpx.Client(base_url=BASE, timeout=600.0) as c:
        h = c.get("/api/health")
        h.raise_for_status()
        print("health:", h.json().get("status"))

        up = c.post("/api/sources", data={"text": SOURCE_TEXT, "filename": "policy.txt"})
        up.raise_for_status()
        src = up.json()
        source_id = src["source_id"]
        print("source:", source_id, src["status"], "chunks", src["chunks"])

        gb = c.post(f"/api/sources/{source_id}/brief", json={
            "scenario": "How will residents and businesses respond to the congestion charge?",
            "max_issues": 5, "max_groups": 6,
        })
        gb.raise_for_status()
        print("generated brief:",
              len(gb.json()["brief"]["issues"]), "issues",
              len(gb.json()["brief"]["stakeholder_groups"]), "groups")

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
        put = c.put(f"/api/sources/{source_id}/brief", json={"brief": edited})
        put.raise_for_status()
        saved = put.json()["brief"]
        assert len(saved["issues"]) == 5, len(saved["issues"])
        assert len(saved["stakeholder_groups"]) == 6, len(saved["stakeholder_groups"])
        print("saved brief: 5 issues / 6 groups")

        created = c.post("/api/runs", json={
            "source_id": source_id,
            "name": "QA congestion charge",
            "scenario_json": {"question": "How will people respond?", "events": []},
            "config": {"agents": 24, "ticks": 10, "writes_per_tick": 4, "seed": 777,
                       "pop_mix": {"pro": 0.3, "con": 0.3, "undecided": 0.4}},
        })
        created.raise_for_status()
        run_id = created.json()["id"]
        print("run:", run_id, created.json()["status"])

        st = c.post(f"/api/runs/{run_id}/start")
        st.raise_for_status()

        deadline = time.time() + 900
        status = None
        while time.time() < deadline:
            d = c.get(f"/api/runs/{run_id}").json()
            status = d["status"]
            if status in ("completed", "interrupted", "failed"):
                break
            time.sleep(1.0)
        print("finished:", status,
              "agents", d.get("agents"), "posts", d.get("posts"),
              "rounds", d.get("last_completed_tick"))
        if status != "completed":
            print("detail:", d.get("error_json"))
            return 1

        # The Findings view only shows a report once one is generated; the UI
        # harness checks for that section, so mint it here.
        rep = c.post(f"/api/runs/{run_id}/report")
        rep.raise_for_status()
        rd = rep.json()
        md = rd.get("report_md") or rd.get("report", {}).get("report_md") or ""
        print("report:", len(md), "chars")

        print(run_id)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
