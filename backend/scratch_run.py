"""Scratch: run a full mock simulation in-process to validate the engine."""
import asyncio
import json
import sys
sys.path.insert(0, "backend")

from app import db
from app import config as cfg_mod

cfg_mod.config.reload()
print("provider:", cfg_mod.config.llm_provider)


async def main():
    from app.ingest import brief as brief_mod
    from app.llm.gateway import gateway
    from app.sim import engine, budget as budget_mod
    from app.api import sources as sources_api

    db.reset()
    db.connect()
    text = ("Energy transition policy is contested. Supporters argue that subsidies for "
            "renewables cut emissions and build local industry. Opponents argue that costs rise "
            "for households and that grids become less reliable without firm capacity. "
            "Rural towns differ sharply on wind projects; some welcome investment while others "
            "object to land use changes. The council must decide before the budget review.")
    src = sources_api.extract_text_document(text.encode("utf-8"), "scratch.md")
    print("source:", src)
    brief = await brief_mod.build_brief(src["source_id"], "How will residents react to energy policy?", gateway)
    db.execute("UPDATE sources SET brief_json=? WHERE id=?", (db.j(brief), src["source_id"]))
    print("issues:", [(i["id"], i["name"]) for i in brief["issues"]])

    cfg = {"agents": 8, "ticks": 4, "writes_per_tick": 4, "pop_mix": {"pro": 0.3, "con": 0.3, "undecided": 0.4}, "seed": 42}
    run_id = "run_test1_" + str(int(asyncio.get_event_loop().time() * 1000))
    db.execute(
        "INSERT INTO runs(id, name, source_id, scenario_json, config_json, provider_json, seed,"
        " status, current_tick, last_completed_tick, rng_state, llm_calls_used, created_at,"
        " updated_at, error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (run_id, "Scratch", src["source_id"], db.j({"question": "How will residents react?", "events": []}),
         db.j(cfg), db.j({}), 42, "draft", 0, 0, None, 0, "", "", None))
    n = await engine.seed_run(run_id, gateway)
    print("seeded agents:", n)
    await engine.start_run(run_id)
    task = engine._tasks.get(run_id)
    deadline = asyncio.get_event_loop().time() + 120
    while task and not task.done():
        await asyncio.sleep(0.5)
        if asyncio.get_event_loop().time() > deadline:
            print("TIMEOUT")
            break
    status = db.scalar("SELECT status FROM runs WHERE id=?", (run_id,))
    posts = db.scalar("SELECT COUNT(*) FROM posts WHERE run_id=?", (run_id,))
    errs = db.query("SELECT kind, payload_json FROM events WHERE run_id=? AND kind IN ('error','warning')", (run_id,))
    sample = db.query("SELECT tick, agent_id, kind, text FROM posts WHERE run_id=? ORDER BY tick LIMIT 5", (run_id,))
    calls = db.query("SELECT task, status, error FROM llm_calls WHERE run_id=? ORDER BY id DESC LIMIT 5", (run_id,))
    print("status:", status, "posts:", posts)
    for e in errs:
        print("ERR/EVENT:", dict(e))
    for p in sample:
        print("POST:", dict(p))
    for c in calls:
        print("LLMCALL:", dict(c))

asyncio.run(main())
