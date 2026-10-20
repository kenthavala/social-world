"""Opt-in smoke test against the real configured provider (or mock when none).

Usage: .venv\Scripts\python -m app.smoke [--provider openrouter --model google/gemini-2.0-flash-exp:free]
"""
from __future__ import annotations

import asyncio
import sys
import time

from app import db, config as cfg_mod
from app.sim import engine, budget as budget_mod


async def _main(provider: str | None = None, model: str | None = None) -> int:
    from app.llm.gateway import gateway

    db.connect()
    provider = provider or cfg_mod.config.llm_provider
    if provider != "mock":
        report = await gateway.test_connection(provider, model)
        print(f"connection test: {report}")
        if report.get("error"):
            print("SMOKE FAILED: connection test error")
            return 2

    # create a tiny text source
    api_sources = __import__("app.api.sources", fromlist=["router"])
    text = ("Energy transition policy is contested. Supporters argue that subsidies for "
            "renewables cut emissions and build industry. Opponents argue costs rise for "
            "households and grids become less reliable. Towns differ on wind projects.")
    src = await api_sources.upload_source(text=text, filename="smoke.md")
    source_id = src["source_id"]
    print(f"source: {src}")

    brief = await __import__("app.ingest.brief", fromlist=["build_brief"]).build_brief(
        source_id, "How will residents react to energy policy changes?", gateway)
    db.execute("UPDATE sources SET brief_json=? WHERE id=?", (db.j(brief), source_id))
    print(f"issues: {[i['id'] + ':' + i['name'] for i in brief.get('issues', [])]}")

    cfg = budget_mod.PRESETS["quick"] | {"agents": 6, "ticks": 3, "writes_per_tick": 2}
    cfg["max_llm_calls"] = 10
    run_id = "run_smoke_" + str(int(time.time()))
    db.execute(
        "INSERT INTO runs(id, name, source_id, scenario_json, config_json, provider_json, seed,"
        " status, current_tick, last_completed_tick, rng_state, llm_calls_used, created_at,"
        " updated_at, error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (run_id, "Smoke", source_id, db.j({"question": "How will residents react?"}), db.j(cfg),
         db.j({"provider": provider, "model": model or ""}), 1234, "draft", 0, 0, None, 0,
         "", "", None))
    api_runs = __import__("app.api.runs", fromlist=["run_detail"])  # noqa: F401 (reference only)
    await engine.seed_run(run_id, gateway)
    engine_cfg = db.uj(db.scalar("SELECT config_json FROM runs WHERE id=?", (run_id,)) or "{}", {})
    engine_cfg["max_llm_calls"] = 10
    db.execute("UPDATE runs SET config_json=? WHERE id=?", (db.j(engine_cfg), run_id))
    await engine.start_run(run_id)
    task = engine._tasks.get(run_id)
    deadline = time.time() + 300
    while task and not task.done() and time.time() < deadline:
        await asyncio.sleep(0.5)
    posts = db.scalar("SELECT COUNT(*) FROM posts WHERE run_id=?", (run_id,)) or 0
    status = db.scalar("SELECT status FROM runs WHERE id=?", (run_id,))
    llm = db.scalar("SELECT llm_calls_used FROM runs WHERE id=?", (run_id,)) or 0
    sample = db.query_one("SELECT text FROM posts WHERE run_id=? AND kind='post' LIMIT 1", (run_id,))
    print(f"status={status} posts={posts} llm_calls={llm}")
    if sample is not None:
        print(f"sample post: {sample['text'][:140]}")
    ok = status == "completed" and posts >= 5 and llm <= 10
    print("SMOKE OK" if ok else "SMOKE FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    args = sys.argv[1:]
    provider = None
    model = None
    if "--provider" in args:
        provider = args[args.index("--provider") + 1]
    if "--model" in args:
        model = args[args.index("--model") + 1]
    sys.exit(asyncio.run(_main(provider, model)))
