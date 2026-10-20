"""Shared fixtures: isolated temp data dir + DB per test; mock provider .env isolation."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app import db as db_mod  # noqa: E402


@pytest.fixture()
def fresh_db(tmp_path, monkeypatch):
    """Point all data stores at a temp dir and provide a clean DB."""
    import app.db as db
    import app.api.sources as sources
    import app.ingest.index as index_mod
    import app.config as config_mod

    data_dir = tmp_path / "data"
    data_dir.mkdir(exist_ok=True)
    monkeypatch.setattr(db, "DATA_DIR", data_dir)
    monkeypatch.setattr(db, "DB_PATH", data_dir / "oasis.db")
    monkeypatch.setattr(sources, "DATA_DIR", data_dir)
    monkeypatch.setattr(index_mod, "INDEX_DIR", data_dir / "index")
    monkeypatch.setattr(config_mod, "DATA_DIR", data_dir)
    monkeypatch.setattr(config_mod, "SETTINGS_FILE", data_dir / "settings.json")
    monkeypatch.setattr(config_mod, "ENV_FILE", data_dir / ".env")

    index_mod._cache.clear()
    db.reset()
    db.connect()
    # Re-sync the config singleton now that SETTINGS_FILE/ENV_FILE are redirected,
    # so the developer's live data/settings.json can never leak into tests.
    from app.config import config as config_singleton
    config_singleton.reload()
    yield db
    db.reset()


@pytest.fixture()
def sample_source(fresh_db):
    """A small extracted source with a fallback-ready brief."""
    from app.api import sources as sources_api
    text = (
        "Energy transition policy is contested. Supporters argue that subsidies for "
        "renewables cut emissions and build local industry. Opponents argue that costs rise "
        "for households and that grids become less reliable without firm capacity. "
        "Rural towns differ sharply on wind projects; some welcome investment while others "
        "object to land use changes. The council must decide before the budget review. "
    ) * 8
    src = sources_api.extract_text_document(text.encode("utf-8"), "doc.md")
    return src


@pytest.fixture()
def brief_run(sample_source):
    """Source + brief + a draft run row; returns (run_id, source_id)."""
    from app import db as db
    brief = {
        "summary": "Energy policy is contested.",
        "issues": [
            {"id": "iss_1", "name": "Subsidies", "question": "Should subsidies continue?",
             "pro_label": "Support", "con_label": "Oppose", "evidence_chunk_ids": []},
            {"id": "iss_2", "name": "Wind projects", "question": "Build wind turbines?",
             "pro_label": "Build", "con_label": "Block", "evidence_chunk_ids": []},
        ],
        "stakeholder_groups": [
            {"name": "Residents pro", "description": "Want investment", "size_hint": "medium",
             "stance_by_issue": {"iss_1": 0.6, "iss_2": 0.4}},
            {"name": "Residents con", "description": "Worried about costs", "size_hint": "medium",
             "stance_by_issue": {"iss_1": -0.6, "iss_2": -0.4}},
        ],
        "key_claims": [], "entities": [], "fallback": True,
    }
    db.execute("UPDATE sources SET brief_json=? WHERE id=?", (db.j(brief), sample_source["source_id"]))
    run_id = "run_det"
    cfg = {"agents": 8, "ticks": 3, "writes_per_tick": 0, "seed": 1234,
           "pop_mix": {"pro": 0.3, "con": 0.3, "undecided": 0.4},
           "max_llm_calls": 50, "write_batch": 3, "reflect_every": 5, "backfire": True}
    db.execute(
        "INSERT INTO runs(id, name, source_id, scenario_json, config_json, provider_json, seed,"
        " status, current_tick, last_completed_tick, rng_state, llm_calls_used, created_at,"
        " updated_at, error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (run_id, "Test run", sample_source["source_id"], db.j({"question": "q", "events": []}),
         db.j(cfg), db.j({}), 1234, "draft", 0, 0, None, 0, "", "", None))
    return run_id, sample_source["source_id"]


@pytest.fixture(autouse=True)
def mock_provider(monkeypatch):
    """Force the mock provider unless a test overrides it."""
    monkeypatch.setenv("LLM_PROVIDER", "mock")
    monkeypatch.setenv("LLM_MODEL", "mock-1")
    from app.config import config
    config.reload()
    yield


@pytest.fixture()
def fast_gateway(monkeypatch):
    """Zero-delay retries for gateway tests."""
    from app.llm.gateway import Gateway

    monkeypatch.setattr(Gateway, "_delay", lambda self, err: 0.001)
    return Gateway()
