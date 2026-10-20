# OASIS-Lite — M1 Report

Date: 2026-10-20 · M1 vertical slice, per `docs/MASTER_BUILD_PROMPT.md` (§4, §14, §15, §16).

## 1. What was built (and how to see it)

Single local web app — upload a PDF → world brief → seeded personas → LLM-driven ticked
social simulation → SQLite persistence → live dashboard. One process, one port, no
Docker/Redis/queues/vector-DBs/agent-frameworks.

- **Ingestion** (`app/ingest/`): PyMuPDF text + chunking + dedup, BM25 index (`rank_bm25`),
  deterministic fallback brief + LLM world brief with page-cited issue evidence.
- **LLM gateway** (`app/llm/`): pluggable providers (openrouter, opencode_zen, nvidia_nim,
  kilo, fcc, tokenharbor, custom/local OpenAI-compatible, mock); prompt→JSON only
  (no `tools`/`response_format`), tolerant parsing + one repair retry, retries only on
  429/5xx/timeout/connection with Retry-After honoured, token-bucket RPM + concurrency,
  per-run call budget with deterministic degradation, every call recorded in `llm_calls`,
  `POST /api/providers/test` reporting `auth_ok/model_ok/json_ok/latency_ms/reasoning_seen`.
- **Simulation** (`app/sim/`): batched persona seeding (3 agents/call), ticked write loop
  (3 agents/write call, 1–5), reactions, memory, relations (networkx), opinion dynamics
  gate, event injection, atomic per-tick commits, startup recovery (`running`/`seeding`
  → `interrupted`), pause/stop/resume without duplicates.
- **API + SSE** (`app/api/`): sources, briefs, runs CRUD + start/seed/pause/stop/resume,
  posts/events/metrics/stream (SSE with heartbeats), settings with key redaction
  (only `has_key`-style booleans ever leave the process).
- **UI** (`frontend/src/`): Home with runs list, upload→brief→wizard→launch flow with a
  live per-task call estimate, Run page header + Overview / Feed / Network tabs
  (stance area chart, engagement, agent stances; cited-post feed chips; force-graph with
  density/influencers/communities), Settings drawer with provider pick, model, RPM and
  **Test connection**.
- **Launchers**: `start.bat` (env checks → venv → pip → backend+frontend build → serve
  on 127.0.0.1:8000), `dev.bat` (uvicorn --reload + vite proxy), `reset.bat` (wipes
  repo-root `data/`; venv and `.env` keys untouched).

## 2. How to run

```
C:\AI\OASIS_SIM\start.bat        # or: backend → .venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
python -m pytest tests           # from backend\ ; 47 tests
```

**Local URL:** http://127.0.0.1:8000 (server must be running).

## 3. Provider / model used for these runs

All acceptance runs used the built-in **mock provider** (`provider=mock`, `model=mock` —
deterministic, offline), plus a **custom OpenAI-compatible local HTTP provider** for the
crash test (`provider=custom`, `model=slow-mock`, real HTTP wire round-trips through the
`openai_chat` adapter). No external network was used; acceptance (b) is blocked on a user
API key (see §11).

## 4. PDF ingestion test result

Fixture: `docs/samples/policy_sim.pdf` — a **generated** 5-page policy document
(`backend/make_sample_pdf.py` builds it if absent).

**Important note:** the master build prompt references an "attached PDF", but no PDF was
actually attached to this session. To keep the deliverable verifiable, we generated a
comparable 5-page fixture policy PDF and ran everything against it. The ingestion path is
otherwise identical for user-supplied PDFs.

Result: uploaded in the browser → extracted, **5 pages → 2 chunks** (deduplicated),
BM25-indexed, LLM world brief produced a **real brief** (`fallback: false`) with two
contested issues (`iss_1`, `iss_2`) and **3 stakeholder groups**; the brief's
`evidence_chunk_ids` resolve to pool chunks of the uploaded document. Runs created from
this source agent-wise quote `c_…` chunk ids visible as chips in the Feed.

## 5–9. Counts (from the engine + SQLite, not fabricated)

Primary browser acceptance run — `run_8533c162a3` (Quick preset, `policy_sim.pdf`, mock):

| Metric | Value |
|---|---|
| Agents | **16** (4 persona batches × 4) |
| Ticks | **12 / 12 completed** |
| LLM calls (budget) | **26 / 40 used** (deterministic degradation available and not needed to finish) |
| Posts | **48** — all 48 cite ≥1 `c_…` chunk (`cited_chunk_ids_json` non-empty), 0 fallback posts |
| llm_calls rows | 24 `write`, 4 `persona`, 2 `reflect` — all `status=ok` |
| Runtime | comfortably **under 1 minute** (mock, Quick preset) → acceptance (a) pass |

Supporting runs:

- **Budget degradation**: `run_8ed7e5a3b5` (5 agents × 40 ticks) exhausted its budget at
  **63/63** calls and still completed 40/40 ticks with 60 posts — the engine degrades
  deterministically instead of dying mid-run.
- **Crash/resume**: `run_cc10006004` — see §10 (c).

## 10. M1 acceptance results

- **(a) Mock Quick run < 1 min — PASS**: `run_8533c162a3` finished 16 agents / 12 ticks in well under a minute in the browser.
- **(b) Real free provider, ≥20 LLM-written posts — BLOCKED on user key**: no API key was provided in this session, so no external provider could be exercised. The gateway's external path was verified as far as possible locally: real HTTP round-trips over `openai_chat` against a local custom provider drove an entire run (`run_cc10006004`, 8 write calls over HTTP, valid JSON every time) and a wrong-key run (§d). What remains untested is only the *network-facing* side of a hosted provider and the page-badge rendering on that provider's outputs.
- **(c) Kill mid-run → restart → Resume completes, no duplicates — PASS**: `run_cc10006004` (5 agents, 8 ticks, 1 write/tick, seed 4242, custom local provider at 2.5 s/call). Server process was force-killed **immediately after tick 1 committed** (`running`, `last_completed_tick=1`, 1 post). After restart, startup recovery marked it **`interrupted`** with tick 1 preserved; `POST /resume` completed all remaining ticks: **8/8 ticks, 8 posts (exactly one per tick 1…8), 9 llm_calls** (1 persona + 1 reflect + 8 write), zero duplicate post ids, tick 1 not redone.
- **(d) Wrong key → readable error naming provider and fix — PASS**: local always-401 endpoint + `provider=custom`, key `sk-bad-test-key-…` (test key). `POST /api/providers/test` → `auth_ok: false`, error **"401 from custom: …"** (names the provider), hint **"the API key in LLM_API_KEY was rejected. Check and re-save it."** (names the fix and the env var *name*, never the value). A `brief` call through the gateway recorded the error in `llm_calls` (rows 76/77, provider=custom) and the run degraded to a deterministic brief (`fallback: true`). Verified: the key string appears **nowhere** in responses, stored error text, or DB rows; a 401 is non-retryable so there was no retry storm.

## 11. Test results

`backend\tests\`: **47 passed** (0 failed) — ingest, parsing, adapters (respx), gateway
reliability (retries, 429/Retry-After, 401, fallback, budget, cache, redaction), seeding,
memory, relations, opinion dynamics, engine determinism, recovery (crash + resume),
API flow. Everything offline (smoke test against a real provider is available per §14 of
the spec but needs a key).

Two bugs were found and fixed during this final pass (test suite caught both):
1. `DELETE /api/runs/{id}` 500'd — `runs` has no `run_id` column (fixed with per-table column map; verified by deleting 15 junk runs through the endpoint).
2. `config.reload()` retained stale in-memory settings when the settings file disappeared, making tests depend on the existence of the live `settings.json` (fixed; suite hermetic again).

Also fixed: `reset.bat` wiped `backend\data` while the live database lives at repo-root `data\` — corrected.

## 12. Known limitations (honest list)

- **No real hosted-provider run yet** (acceptance b) — needs one API key; nothing else is missing.
- Mock provider is intentionally **not RPM-throttled** (gateway short-circuits before the rate limiter) so tests stay fast; throttling applies to all real providers.
- The deterministic fallback brief returns empty `evidence_chunk_ids` (real LLM briefs attach them).
- Reactions table is empty in these runs — engagement is passive counters in M1, explicit reaction behaviour is later.
- Network tab graph is from the M1 edges pass; influencer/community views are basic.
- `llm_calls_used` budget counter covers write+reflect (+budgeted tasks), while `llm_calls` rows also record seeded persona calls; the two counts intentionally differ (rows > budget counter).
- Fixture PDF substitution (§4) — spec's "attached PDF" never existed in this session.

## 13. Exact next step

Provide one free provider API key (e.g. OpenRouter) in **Settings → paste key → Test
connection → Save**, then repeat acceptance **(b)**: re-run …

1. `start.bat` → http://127.0.0.1:8000
2. Upload `docs/samples/policy_sim.pdf`, choose **Quick**, launch, watch ≥ 20 LLM-written posts with page-badge chips and moving stance lines on the Overview chart.
3. If it passes, M1 is fully closed and M2 (Agents tab + drawer, Network tick slider, Log tab, event injection, model list with free filter, fallback provider) begins per §15 of the master prompt.
