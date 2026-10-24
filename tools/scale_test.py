"""Scale measurement: run the engine at several population sizes and report what we
actually observe. Nothing here is estimated — every number is measured in this run.

    python tools/scale_test.py [sizes...]
    python tools/scale_test.py 24 100 500
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path

DATA = Path(tempfile.mkdtemp(prefix="tsw-scale-"))
os.environ["OASIS_DATA_DIR"] = str(DATA)
os.environ["LLM_PROVIDER"] = "mock"
os.environ["LLM_MODEL"] = "mock-1"

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import app.api.sources as sources  # noqa: E402
from app import db  # noqa: E402
from app.sim import engine  # noqa: E402

TEXT = (
    "Transport policy is contested. Supporters say charges cut emissions and fund buses. "
    "Opponents say costs hit households and small shops. Residents disagree; commuters are "
    "more supportive; trade bodies want exemptions; the council must decide before March. "
) * 30

TICKS = 10
# Posts per tick. 4 is the default; set SCALE_WRITES_PER_TICK=50 for the
# realistic-volume run (10 ticks x 50 = 500+ posts).
WRITES = int(os.environ.get("SCALE_WRITES_PER_TICK", "4"))


def make_brief(n_issues: int = 5, n_groups: int = 6) -> dict:
    return {
        "summary": "Scale test scenario.",
        "issues": [
            {"id": f"iss_{i + 1}", "name": f"Issue {i + 1}", "question": f"Q{i + 1}?",
             "pro_label": "Supports", "con_label": "Opposes", "evidence_chunk_ids": []}
            for i in range(n_issues)
        ],
        "stakeholder_groups": [
            {"name": f"Group {j + 1}", "description": "d",
             "size_hint": ["small", "medium", "large"][j % 3],
             "stance_by_issue": {f"iss_{i + 1}": round(((i + j) % 5 - 2) / 4, 2)
                                 for i in range(n_issues)},
             "population_weight": 1.0 + j * 0.1}
            for j in range(n_groups)
        ],
        "key_claims": [], "entities": [],
    }


async def measure(agents: int) -> dict:
    src = sources.extract_text_document(TEXT.encode(), f"scale-{agents}.md")
    sid = src["source_id"]
    db.execute("UPDATE sources SET brief_json=? WHERE id=?", (db.j(make_brief()), sid))

    cfg = {"agents": agents, "ticks": TICKS, "writes_per_tick": WRITES, "seed": 4242,
           "pop_mix": {"pro": 0.34, "con": 0.33, "undecided": 0.33},
           "max_llm_calls": 100000, "write_batch": 3, "reflect_every": 5, "backfire": True}
    run_id = f"run_scale_{agents}"
    db.execute(
        "INSERT INTO runs(id,name,source_id,scenario_json,config_json,provider_json,seed,status,"
        "current_tick,last_completed_tick,rng_state,llm_calls_used,created_at,updated_at,error_json)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (run_id, f"Scale {agents}", sid, db.j({"question": "q", "events": []}), db.j(cfg),
         db.j({}), 4242, "draft", 0, 0, None, 0, "", "", None))

    db_path = Path(DATA) / "oasis.db"
    size_before = db_path.stat().st_size if db_path.exists() else 0

    from app.llm.gateway import gateway
    # Seeding is timed WITHOUT tracemalloc: allocation tracing adds a large,
    # Python-call-count-proportional overhead to the pure-Python parts, which made
    # earlier seeding numbers (e.g. 24.7 s at 500 agents) mostly measure the tracer.
    # Memory is traced around the tick loop, which is where the population-held
    # state actually grows.
    t0 = time.perf_counter()
    await engine.seed_run(run_id, gateway)
    seed_s = time.perf_counter() - t0

    ctx = await engine.load_context(run_id)
    tracemalloc.start()
    t1 = time.perf_counter()
    per_tick = []
    for tick in range(1, TICKS + 1):
        tt = time.perf_counter()
        await engine.do_tick(ctx, tick)
        ctx.last_completed = tick
        per_tick.append(round(time.perf_counter() - tt, 4))
    ticks_s = time.perf_counter() - t1
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    t2 = time.perf_counter()
    from app.analytics.findings import build_findings
    from app.analytics.narrative import build_narrative
    from app.analytics.realism import compute_realism
    from app.analytics.report import generate_report
    findings_t = time.perf_counter()
    build_findings(run_id)
    findings_s = time.perf_counter() - findings_t
    narrative_t = time.perf_counter()
    build_narrative(run_id)
    narrative_s = time.perf_counter() - narrative_t
    quality_t = time.perf_counter()
    compute_realism(run_id)
    quality_s = time.perf_counter() - quality_t
    report_t = time.perf_counter()
    md = generate_report(run_id)["report_md"]
    report_s = time.perf_counter() - report_t
    analytics_s = time.perf_counter() - t2

    size_after = db_path.stat().st_size if db_path.exists() else 0
    return {
        "agents": agents,
        "ticks": TICKS,
        "seed_seconds": round(seed_s, 3),
        "tick_seconds_total": round(ticks_s, 3),
        "tick_seconds_avg": round(ticks_s / TICKS, 4),
        "tick_seconds_max": max(per_tick),
        "posts": db.scalar("SELECT COUNT(*) FROM posts WHERE run_id=?", (run_id,)) or 0,
        "edges": db.scalar("SELECT COUNT(*) FROM edges WHERE run_id=?", (run_id,)) or 0,
        "stance_rows": db.scalar("SELECT COUNT(*) FROM stance_history WHERE run_id=?",
                                 (run_id,)) or 0,
        "findings_seconds": round(findings_s, 4),
        "narrative_seconds": round(narrative_s, 4),
        "quality_seconds": round(quality_s, 4),
        "report_seconds": round(report_s, 4),
        "analytics_seconds": round(analytics_s, 3),
        "report_chars": len(md),
        "db_growth_mb": round((size_after - size_before) / 1e6, 2),
        "peak_memory_mb": round(peak / 1e6, 1),
    }


async def main() -> None:
    sizes = [int(x) for x in sys.argv[1:]] or [24, 100]
    print(f"engine: {sys.version.split()[0]} · ticks={TICKS} · writes/tick={WRITES} "
          f"· provider=mock · db={DATA}")
    print("seed_s excludes tracemalloc overhead; peakMB is traced across the ticks only.")
    print()
    print(f"{'agents':>7} {'seed_s':>7} {'tick_avg':>9} {'tick_max':>9} {'posts':>7} "
          f"{'edges':>7} {'analytics':>10} {'report':>8} {'db_dMB':>7} {'peakMB':>7}")
    rows = []
    for n in sizes:
        try:
            r = await measure(n)
        except Exception as e:  # noqa: BLE001 — report the failure, do not hide it
            print(f"{n:>7}  FAILED: {type(e).__name__}: {str(e)[:80]}")
            continue
        rows.append(r)
        print(f"{r['agents']:>7} {r['seed_seconds']:>7.2f} {r['tick_seconds_avg']:>9.3f} "
              f"{r['tick_seconds_max']:>9.3f} {r['posts']:>7} {r['edges']:>7} "
              f"{r['analytics_seconds']:>10.3f} {r['report_chars']:>8} "
              f"{r['db_growth_mb']:>7.2f} {r['peak_memory_mb']:>7.1f}")
    import json
    print()
    print(json.dumps(rows, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
