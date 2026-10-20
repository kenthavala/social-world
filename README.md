# OASIS-Lite

Local-first, multi-agent social simulation. Upload a document (PDF/TXT/MD/DOCX),
describe a scenario, and watch LLM-driven agents seed, debate, react, follow and
change opinions over simulated ticks — all persisted locally in SQLite and
watchable live in a single-window dashboard.

## Start

Double-click **start.bat** (Windows). It:

1. Creates `.venv` (Python 3.11/3.12) and installs backend requirements on first run.
2. Builds `frontend/dist` (React + Vite) on first run.
3. Serves app + UI on **http://127.0.0.1:8000** (opens your browser).

No Docker, no Redis, no cloud services. Your API keys stay in `backend\.env` /
data settings and are never echoed back by the API (only "key is set" booleans).

> The mock provider exists for tests/offline demos. When it is active the UI says so.

- `dev.bat` — backend with `--reload` + Vite dev server on :5173 (proxies `/api`).
- `reset.bat` — wipes `backend\data` (database, uploads, BM25 index, settings).

## What it does

- **Ingest** — extract (PyMuPDF/python-docx), clean boilerplate, chunk
  (250–400 words, overlap, page bounds) and BM25-index chunks.
- **World brief** — the LLM reads retrieved chunks and returns issues, claims,
  stakeholder groups with stance targets (fallback: deterministic brief from
  headings/keywords if the provider fails).
- **Seeding** — N agents with names, handles, archetypes, Big 5*, traits, stances
  towards each issue, memories of the document, and a follow graph (networkx).
- **Simulation** — ticks of: event activation → feed scoring → reactions
  (like/repost/follow/unfollow) → speakers → batched LLM write calls (3 agents
  per call, 1–5 configurable) with `reply` support → bounded-confidence opinion
  updates with optional backfire → relation decay → memory (cap 50) → metrics.
- **Reliability** — gateway retries only 429/5xx/timeouts (max 3 retries,
  honours Retry-After), one JSON-repair retry, model+provider fallback chain,
  per-run call budget with deterministic degradation, SSAHA-style caching
  (SQLite-backed request cache) and replay of recorded calls via `LLM_REPLAY`.
- **Persistence / crash-safety** — atomic per-tick commit; a crashed run is
  marked `interrupted` on startup and resumable, finishing exactly the ticks
  that did not commit; pause settles at the current tick boundary and resumes
  with no duplicated posts (unit-tested with a held gateway).
- **Events** — inject events mid-run (public broadcast or private
  stakeholder-group briefing); schedules persist in SQLite and survive restarts.
- **Reporting** — deterministic Insights report counted from recorded rows, plus an
  optional LLM executive summary ("essay") that runs through the gateway, is logged
  in the call record, and is always labeled *generated, not counted data*
  only: stance landings, biggest turning points, Louvain conversation
  clusters, cited sources with page bounds, PageRank influencers, top posts.
- **Exports** — one-click download of the whole run: JSON bundle,
  Markdown summary, CSV zip (agents / posts / edges / stance history /
  llm call log / chunks), self-contained and free of key material.

## Providers

OpenRouter, OpenCode Zen, NVIDIA NIM, Kilo, Custom/local (any OpenAI-compatible
endpoint, incl. anthropic-messages wire), FCC (local anthropic proxy),
Token Harbor, plus a deterministic `mock` provider so everything works with no
key at all. Configure in the **Settings page** (`#/settings`) or `backend\.env`:

```
LLM_PROVIDER=openrouter
LLM_MODEL=meta-llama/llama-3.3-70b-instruct:free
OPENROUTER_API_KEY=sk-or-...
```

## Tests

```
cd backend
..\.venv\Scripts\python.exe -m pytest tests
```

70 tests: ingest (extraction/cleaning/chunking/BM25), tolerant JSON parsing,
wire adapters (respx), gateway retries/fallback/budget/cache, opinion/memory/
relations formulas, partisanship seeding, engine determinism (same seed +
writes=0 → identical log), crash→interrupted→resume without duplicates,
mid-run pause→resume without duplicates, self-edges never persist, SSE
broker, API flow incl. self-contained exports, deterministic reports
(turning points / clusters / source usage / TF-IDF narratives), gateway
replay (serve / assertive miss / invalid recording), the LLM essay
(record/budget-exempt/failure-clean/regenerate-clears/export-labeled),
DB migrator (v1→v3).

## Screenshots

Generated with Playwright (exact viewports): `docs/screenshots/baseline/`
(pre-M2), `docs/screenshots/m2/` (phase evidence), `docs/screenshots/final/`
(every core page at 1440×900, 1280×720, 1920×1080 and 390×844).

## Layout

```
backend/app
  llm/        presets · adapters · parsing · ratelimit · mock · gateway
  ingest/     extract · clean · chunk · index · brief
  sim/        models · budget · feed · policy · opinion · memory · relations
              events · seeding · engine
  analytics/  metrics · network · report
  api/        sources · runs · stream · settings · providers · export
frontend/src   App · shell · router · HomePage · Wizard · DocumentsPage ·
               SettingsPage · run/ (RunShell, Overview, Feed, Agents,
               Network, Events, Insights, Log tabs) · api.ts · hooks · types
docs/          MASTER_BUILD_PROMPT · DECISIONS · KNOWN_LIMITS · M2_REPORT
```

See `docs/M2_REPORT.md` for the M2/M3 turn-by-turn record and
`docs/KNOWN_LIMITS.md` for the honest boundaries of the system.
