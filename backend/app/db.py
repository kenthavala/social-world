"""SQLite persistence (WAL mode). One connection guarded by a lock; JSON stored as TEXT."""
from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterable, Optional

from app.config import DATA_DIR

DB_PATH = DATA_DIR / "oasis.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS sources(
  id TEXT PRIMARY KEY, filename TEXT, sha256 TEXT UNIQUE, kind TEXT, pages INTEGER,
  created_at TEXT, status TEXT, brief_json TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS chunks(
  id TEXT PRIMARY KEY, source_id TEXT, idx INTEGER, text TEXT, page_start INTEGER,
  page_end INTEGER, heading TEXT, n_words INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id, idx);
CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY, name TEXT, source_id TEXT, scenario_json TEXT, config_json TEXT,
  provider_json TEXT, seed INTEGER, status TEXT, current_tick INTEGER,
  last_completed_tick INTEGER, rng_state TEXT, llm_calls_used INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT, error_json TEXT,
  started_at TEXT, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS agents(
  id TEXT PRIMARY KEY, run_id TEXT, handle TEXT, name TEXT, bio TEXT, archetype TEXT,
  stakeholder_group TEXT, persona_json TEXT, personality_json TEXT, traits_json TEXT,
  goals_json TEXT, interests_json TEXT, stances_json TEXT, state_json TEXT,
  knowledge_json TEXT, belief_summary TEXT, source_chunk_ids_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_agents_run ON agents(run_id);
CREATE TABLE IF NOT EXISTS posts(
  id TEXT PRIMARY KEY, run_id TEXT, tick INTEGER, agent_id TEXT, kind TEXT,
  parent_id TEXT, text TEXT, stance_json TEXT, emotion TEXT,
  cited_chunk_ids_json TEXT, likes INTEGER DEFAULT 0, reposts INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0, is_fallback INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_posts_run_tick ON posts(run_id, tick);
CREATE TABLE IF NOT EXISTS reactions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, tick INTEGER, agent_id TEXT,
  post_id TEXT, kind TEXT
);
CREATE TABLE IF NOT EXISTS edges(
  run_id TEXT, src TEXT, dst TEXT, follows INTEGER, weight REAL,
  interactions INTEGER, last_tick INTEGER, PRIMARY KEY(run_id, src, dst)
);
CREATE TABLE IF NOT EXISTS edge_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, tick INTEGER, src TEXT, dst TEXT,
  follows INTEGER, weight REAL
);
CREATE TABLE IF NOT EXISTS memories(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, agent_id TEXT, tick INTEGER,
  kind TEXT, text TEXT, importance REAL, refs_json TEXT
);
CREATE TABLE IF NOT EXISTS stance_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, tick INTEGER, agent_id TEXT,
  issue_id TEXT, value REAL, confidence REAL
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, tick INTEGER, kind TEXT,
  payload_json TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS metrics(
  run_id TEXT, tick INTEGER, metrics_json TEXT, PRIMARY KEY(run_id, tick)
);
CREATE TABLE IF NOT EXISTS llm_calls(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task TEXT, provider TEXT,
  model TEXT, request_hash TEXT, request_json TEXT, response_text TEXT, parsed_ok INTEGER,
  status TEXT, http_status INTEGER, error TEXT, tokens_in INTEGER, tokens_out INTEGER,
  latency_ms INTEGER, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_hash ON llm_calls(request_hash);
CREATE TABLE IF NOT EXISTS reports(
  run_id TEXT PRIMARY KEY, created_at TEXT, analytics_json TEXT, report_md TEXT, report_json TEXT,
  essay_json TEXT, essay_meta_json TEXT
);
CREATE TABLE IF NOT EXISTS schema_version(version INTEGER);
"""

_lock = threading.RLock()
_conn: Optional[sqlite3.Connection] = None


def connect() -> sqlite3.Connection:
    global _conn
    with _lock:
        if _conn is None:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
            _conn.row_factory = sqlite3.Row
            _conn.execute("PRAGMA journal_mode=WAL")
            _conn.execute("PRAGMA foreign_keys=ON")
            _conn.execute("PRAGMA synchronous=NORMAL")
            _conn.executescript(SCHEMA)
            version = _conn.execute("SELECT MAX(version) v FROM schema_version").fetchone()
            if version is None or version["v"] is None:
                _conn.execute("INSERT INTO schema_version(version) VALUES(1)")
            v = _conn.execute("SELECT MAX(version) v FROM schema_version").fetchone()["v"] or 1
            # Additive migrations only — an existing M1 database must keep opening.
            if v < 2:
                self_migrate_v2(_conn)
                _conn.execute("INSERT INTO schema_version(version) VALUES(2)")
            if v < 3:
                self_migrate_v3(_conn)
                _conn.execute("INSERT INTO schema_version(version) VALUES(3)")
            _conn.commit()
        return _conn


def self_migrate_v2(conn: sqlite3.Connection) -> None:
    """v2: runs.started_at / runs.finished_at (honest elapsed time)."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(runs)")}
    if "started_at" not in cols:
        conn.execute("ALTER TABLE runs ADD COLUMN started_at TEXT")
    if "finished_at" not in cols:
        conn.execute("ALTER TABLE runs ADD COLUMN finished_at TEXT")


def self_migrate_v3(conn: sqlite3.Connection) -> None:
    """v3: optional LLM-written executive summary pinned to the report snapshot."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(reports)")}
    if "essay_json" not in cols:
        conn.execute("ALTER TABLE reports ADD COLUMN essay_json TEXT")
    if "essay_meta_json" not in cols:
        conn.execute("ALTER TABLE reports ADD COLUMN essay_meta_json TEXT")


def reset(path_to_delete: Optional[Path] = None) -> None:
    """Wipe everything: used by reset.bat and tests."""
    global _conn
    with _lock:
        if _conn is not None:
            _conn.close()
            _conn = None
        if path_to_delete is not None and path_to_delete.exists():
            for suffix in ("", "-wal", "-shm"):
                p = Path(str(path_to_delete) + suffix)
                if p.exists():
                    p.unlink()


class tx:
    """Context manager for an atomic multi-statement transaction."""

    def __enter__(self):
        _lock.acquire()
        connect().execute("BEGIN IMMEDIATE")
        return connect()

    def __exit__(self, exc_type, exc, tb):
        conn = connect()
        try:
            if exc_type is None:
                conn.commit()
            else:
                conn.rollback()
        finally:
            _lock.release()
        return False


def execute(sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
    with _lock:
        cur = connect().execute(sql, tuple(params))
        connect().commit()
        return cur


def executemany(sql: str, rows: Iterable[tuple]) -> None:
    with _lock:
        connect().executemany(sql, [tuple(r) for r in rows])
        connect().commit()


def query(sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
    with _lock:
        return connect().execute(sql, tuple(params)).fetchall()


def query_one(sql: str, params: Iterable[Any] = ()) -> Optional[sqlite3.Row]:
    with _lock:
        return connect().execute(sql, tuple(params)).fetchone()


def scalar(sql: str, params: Iterable[Any] = ()) -> Any:
    row = query_one(sql, params)
    return row[0] if row is not None else None


def j(value: Any) -> str:
    """Serialize a value to canonical compact JSON text."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def uj(text: Optional[str], default: Any = None) -> Any:
    if text is None:
        return default
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return default
