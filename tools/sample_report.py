"""Generate a sample report from a mock run and print it, for inspection."""
import os
import sys
import tempfile
from pathlib import Path

DATA = Path(tempfile.mkdtemp(prefix="tsw-report-sample-"))
os.environ["OASIS_DATA_DIR"] = str(DATA)
os.environ["LLM_PROVIDER"] = "mock"
os.environ["LLM_MODEL"] = "mock-1"
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import asyncio  # noqa: E402

import app.api.sources as sources  # noqa: E402
from app import db  # noqa: E402
from app.sim import engine  # noqa: E402

TEXT = (
    "Congestion charging is contested. Supporters argue it cuts emissions and funds buses. "
    "Opponents say it raises costs for households and hits small shops. Inner-city residents "
    "are divided; suburban commuters are more supportive. Environmental groups want a higher "
    "charge, trade bodies want exemptions, and the council must decide before the budget. "
) * 40

src = sources.extract_text_document(TEXT.encode(), "policy.md")
sid = src["source_id"]

issues = [
    ("Congestion charge level", "policy.transport"),
    ("Where the revenue goes", "policy.infrastructure"),
    ("Small business exemptions", "business.regulation"),
    ("Air quality impact", "policy.environment"),
    ("Implementation timeline", "policy.urban_planning"),
]
groups = [
    ("Inner-city residents", "People living inside the zone", [0.2, 0.1, -0.3, 0.4, 0.0]),
    ("Suburban commuters", "People driving in from outside", [0.5, 0.3, 0.1, 0.6, 0.2]),
    ("Small businesses", "Shops inside the charging zone", [-0.6, -0.2, -0.8, -0.1, -0.5]),
    ("Environmental groups", "Campaigners for cleaner air", [0.8, 0.6, 0.2, 0.9, 0.3]),
    ("Local government", "The council itself", [0.3, 0.5, 0.0, 0.4, 0.6]),
    ("Trade bodies", "Business associations", [-0.4, -0.1, -0.7, 0.0, -0.3]),
]

brief = {
    "summary": "A council consults on a congestion charge.",
    "issues": [
        {"id": f"iss_{i+1}", "name": n, "question": f"What should happen about {n.lower()}?",
         "pro_label": "Supports", "con_label": "Opposes", "evidence_chunk_ids": [],
         "category": c}
        for i, (n, c) in enumerate(issues)
    ],
    "stakeholder_groups": [
        {"name": n, "description": d, "size_hint": ["medium", "large", "small"][i % 3],
         "stance_by_issue": {f"iss_{j+1}": v for j, v in enumerate(st)},
         "influence": 2 + i, "institutional_power": 1 + (i % 3),
         "concerns": ["cost", "fairness"] if i % 2 else ["air quality"]}
        for i, (n, d, st) in enumerate(groups)
    ],
    "key_claims": [], "entities": [],
}
db.execute("UPDATE sources SET brief_json=? WHERE id=?", (db.j(brief), sid))

cfg = {"agents": 24, "ticks": 10, "writes_per_tick": 4, "seed": 4242,
       "pop_mix": {"pro": 0.35, "con": 0.3, "undecided": 0.35},
       "max_llm_calls": 800, "write_batch": 3, "reflect_every": 5, "backfire": True}
run_id = "run_sample_rpt"
db.execute(
    "INSERT INTO runs(id,name,source_id,scenario_json,config_json,provider_json,seed,status,"
    "current_tick,last_completed_tick,rng_state,llm_calls_used,created_at,updated_at,error_json)"
    " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    (run_id, "Congestion Charge — Public Response", sid,
     db.j({"question": "How will residents and businesses respond to the congestion charge?",
           "events": []}), db.j(cfg), db.j({"name": "mock", "model": "mock-1"}), 4242,
     "draft", 0, 0, None, 0, "", "", None))


async def main():
    from app.llm.gateway import gateway
    from app.analytics.report import generate_report
    await engine.seed_run(run_id, gateway)
    ctx = await engine.load_context(run_id)
    for tick in range(1, 11):
        await engine.do_tick(ctx, tick)
        ctx.last_completed = tick
    out = generate_report(run_id)
    Path("report_sample.md").write_text(out["report_md"], encoding="utf-8")
    print(out["report_md"])


asyncio.run(main())
