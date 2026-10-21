"""Build the bundled sample world: ingest the fictional PDF, draft its brief, run
a real-provider simulation and export the finished run as examples/sample-run.json.

Run from the repo root with the project venv. This script never writes settings;
the provider override lives in this process only. If the real provider fails or
pauses, it creates a clearly labelled mock sample instead.
"""
from __future__ import annotations

import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app import db
from app.api import runs as runs_api
from app.api import sources as sources_api
from app.api.export import _bundle
from app.config import config
from app.ingest import brief as brief_mod
from app.llm.gateway import gateway
from app.sim import engine

PDF = ROOT / "examples" / "harbour-city-congestion-charge.pdf"
OUT = ROOT / "examples" / "sample-run.json"
SCENARIO = (
    "Harbour City is consulting on a £6 weekday congestion charge for the central zone. "
    "How will residents, businesses, drivers and transport groups respond, and which parts "
    "of the proposal will they cite?"
)


def use_provider(provider: str, model: str) -> None:
    config._file = dict(config._file) | {
        "llm_provider": provider,
        "llm_model": model,
        "llm_timeout_seconds": 180,
        "llm_max_tokens": 2000,
        "llm_concurrency": 2,
        "llm_rpm": 35 if provider == "nvidia_nim" else None,
    }


async def build(provider: str, model: str) -> str:
    use_provider(provider, model)
    data = PDF.read_bytes()
    src = sources_api.extract_text_document(data, PDF.name)
    source_id = src["source_id"]
    row = db.query_one("SELECT brief_json FROM sources WHERE id=?", (source_id,))
    if not row or not row["brief_json"]:
        brief = await brief_mod.build_brief(source_id, SCENARIO, gateway)
        db.execute("UPDATE sources SET brief_json=? WHERE id=?", (db.j(brief), source_id))
        print(f"brief: {len(brief.get('issues') or [])} issues, "
              f"{len(brief.get('stakeholder_groups') or [])} groups", flush=True)
    run = runs_api.create_run(runs_api.RunIn(
        source_id=source_id,
        name="Harbour City — Congestion Charge" + ("" if provider != "mock" else " (mock)"),
        scenario_json={"question": SCENARIO, "events": []},
        config={"agents": 12, "ticks": 12, "writes_per_tick": 4, "write_batch": 4,
                "reflect_every": 6, "seed": 20261021, "max_llm_calls": 60},
    ))
    run_id = run["id"]
    print(f"run {run_id} · provider {provider}/{model} · seeding…", flush=True)
    await engine.seed_run(run_id, gateway)
    await engine.start_run(run_id)
    task = engine._tasks.get(run_id)
    if task:
        await task
    status = db.scalar("SELECT status FROM runs WHERE id=?", (run_id,))
    print(f"run {run_id} finished with status {status}", flush=True)
    return run_id


def export(run_id: str, *, mock: bool) -> None:
    bundle = _bundle(run_id)
    run = db.query_one("SELECT * FROM runs WHERE id=?", (run_id,))
    source_id = run["source_id"]
    src = db.query_one("SELECT * FROM sources WHERE id=?", (source_id,))
    bundle["sample"] = {
        "label": "Harbour City congestion charge",
        "description": "A fictional council consultation about a £6 weekday congestion charge.",
        "source_file": str(PDF.relative_to(ROOT)).replace("\\", "/"),
        "source_filename": src["filename"],
        "source_sha256": src["sha256"],
        "source_pages": src["pages"],
        "license": "CC BY 4.0 — written for The Social World",
        "mock": mock,
        "built_at": datetime.now(timezone.utc).isoformat(),
    }
    bundle["manifest"] = db.uj(run["manifest_json"], {}) or {}
    OUT.write_text(json.dumps(bundle, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)", flush=True)


async def main() -> None:
    if "--export" in sys.argv:
        rid = sys.argv[sys.argv.index("--export") + 1]
        provider = db.uj(db.scalar("SELECT provider_json FROM runs WHERE id=?", (rid,)), {}) or {}
        export(rid, mock=provider.get("name") == "mock")
        return
    if "--resume" in sys.argv:
        rid = sys.argv[sys.argv.index("--resume") + 1]
        use_provider("nvidia_nim", "z-ai/glm-5.3-flash")
        print(f"resuming {rid} with nvidia_nim…", flush=True)
        await engine.request_resume(rid)
        task = engine._tasks.get(rid)
        if task:
            await task
        status = db.scalar("SELECT status FROM runs WHERE id=?", (rid,))
        print(f"resume finished with status {status}", flush=True)
        if status == "completed":
            export(rid, mock=False)
        return
    if "--mock" in sys.argv:
        run_id = await build("mock", "mock-1")
        export(run_id, mock=True)
        return
    run_id = await build("nvidia_nim", "z-ai/glm-5.3-flash")
    status = db.scalar("SELECT status FROM runs WHERE id=?", (run_id,))
    if status != "completed":
        print("real provider did not complete; building a labelled mock sample instead", flush=True)
        run_id = await build("mock", "mock-1")
        status = db.scalar("SELECT status FROM runs WHERE id=?", (run_id,))
    export(run_id, mock=(status != "completed" or
                         (db.uj(db.scalar("SELECT provider_json FROM runs WHERE id=?", (run_id,)), {}) or {})
                         .get("name") == "mock"))


if __name__ == "__main__":
    asyncio.run(main())
