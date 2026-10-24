"""Seed a completed demo run into a chosen data dir, for screenshots and manual QA.

Usage:
    python tools/seed_demo.py <data-dir>

Creates a source, a 5-issue / 6-group brief, a 24-agent / 10-round completed run,
and a generated report. Deterministic (mock provider), so screenshots are stable.
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

DATA = Path(sys.argv[1] if len(sys.argv) > 1 else "data-demo").resolve()
DATA.mkdir(parents=True, exist_ok=True)
os.environ["OASIS_DATA_DIR"] = str(DATA)
os.environ["LLM_PROVIDER"] = "mock"
os.environ["LLM_MODEL"] = "mock-1"

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import app.api.sources as sources  # noqa: E402
from app import db  # noqa: E402
from app.sim import engine  # noqa: E402

TEXT = (
    "Congestion charging is contested. Supporters argue it cuts emissions, reduces traffic "
    "and funds public transport improvements. Opponents say it raises costs for households, "
    "hits small shops inside the zone, and pushes traffic onto residential streets. "
    "Inner-city residents are divided: some welcome cleaner air, others fear the charge on "
    "visitors. Suburban commuters are more supportive because they already pay for parking. "
    "Small businesses near the boundary worry about losing customers. Environmental groups "
    "want a higher charge and ring-fenced revenue for buses and cycle lanes. Trade bodies "
    "want exemptions for local firms and a longer consultation. The council must decide "
    "before the budget review in March, and implementation would begin the following year. "
) * 20

ISSUES = [
    ("Congestion charge level", "policy.transport",
     "How high should the daily charge be?"),
    ("Where the revenue goes", "policy.infrastructure",
     "Should revenue be ring-fenced for public transport?"),
    ("Small business exemptions", "business.regulation",
     "Should local firms receive an exemption?"),
    ("Air quality impact", "policy.environment",
     "How much will the charge improve air quality?"),
    ("Implementation timeline", "policy.urban_planning",
     "How quickly should the scheme start?"),
]

GROUPS = [
    ("Inner-city residents", "People living inside the charging zone",
     [0.15, 0.2, -0.1, 0.45, 0.0], 4, 2),
    ("Suburban commuters", "Drivers coming in from outside the zone",
     [0.55, 0.35, 0.2, 0.6, 0.25], 3, 2),
    ("Small businesses", "Shops and services inside the zone",
     [-0.6, -0.25, -0.75, -0.15, -0.45], 5, 4),
    ("Environmental groups", "Campaigners for cleaner air and active travel",
     [0.8, 0.7, 0.3, 0.9, 0.4], 6, 3),
    ("Local government", "The council delivering the scheme",
     [0.3, 0.55, 0.05, 0.4, 0.6], 7, 6),
    ("Trade bodies", "Business associations representing members",
     [-0.45, -0.15, -0.7, 0.05, -0.3], 5, 5),
]


def main() -> None:
    src = sources.extract_text_document(TEXT.encode(), "congestion-charge-consultation.md")
    sid = src["source_id"]

    brief = {
        "summary": "A council consults on introducing a congestion charge in the city centre.",
        "issues": [
            {"id": f"iss_{i + 1}", "name": name, "question": q,
             "pro_label": "Supports", "con_label": "Opposes",
             "evidence_chunk_ids": [], "category": cat}
            for i, (name, cat, q) in enumerate(ISSUES)
        ],
        "stakeholder_groups": [
            {"name": name, "description": desc, "size_hint": ["medium", "large", "small"][i % 3],
             "stance_by_issue": {f"iss_{j + 1}": v for j, v in enumerate(stance)},
             "influence": inf, "institutional_power": power,
             "population_weight": 1.0 + i * 0.15,
             "interests": ["transport", "cost", "air quality"],
             "concerns": ["cost", "fairness"] if i % 2 else ["implementation", "air quality"]}
            for i, (name, desc, stance, inf, power) in enumerate(GROUPS)
        ],
        "key_claims": [], "entities": [],
    }
    db.execute("UPDATE sources SET brief_json=? WHERE id=?", (db.j(brief), sid))

    cfg = {"agents": 24, "ticks": 10, "writes_per_tick": 4, "seed": 20261024,
           "pop_mix": {"pro": 0.35, "con": 0.3, "undecided": 0.35},
           "max_llm_calls": 900, "write_batch": 3, "reflect_every": 5, "backfire": True}
    run_id = "run_demo_congestion"
    db.execute(
        "INSERT OR REPLACE INTO runs(id,name,source_id,scenario_json,config_json,provider_json,"
        "seed,status,current_tick,last_completed_tick,rng_state,llm_calls_used,created_at,"
        "updated_at,error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (run_id, "Congestion Charge — Public Response", sid,
         db.j({"question": "How will residents, commuters and businesses respond to the "
                           "proposed congestion charge?",
               "events": []}),
         db.j(cfg), db.j({"name": "mock", "model": "mock-1"}), cfg["seed"],
         "draft", 0, 0, None, 0,
         "2026-10-24T09:00:00+00:00", "2026-10-24T09:00:00+00:00", None))

    async def run() -> None:
        from app.analytics.report import generate_report
        from app.llm.gateway import gateway
        await engine.seed_run(run_id, gateway)
        ctx = await engine.load_context(run_id)
        for tick in range(1, 11):
            await engine.do_tick(ctx, tick)
            ctx.last_completed = tick
        db.execute("UPDATE runs SET status='completed', last_completed_tick=10,"
                   " started_at=?, finished_at=?, updated_at=? WHERE id=?",
                   ("2026-10-24T09:00:05+00:00", "2026-10-24T09:12:00+00:00",
                    "2026-10-24T09:12:00+00:00", run_id))
        generate_report(run_id)
        print(f"seeded run {run_id} in {DATA}")

    asyncio.run(run())


if __name__ == "__main__":
    main()
