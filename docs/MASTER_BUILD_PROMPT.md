# OASIS-Lite — Master Build Prompt (saved as the first artifact of the project)

> This file is the authoritative spec. Re-read at the start of every milestone.

You are building OASIS-Lite: a local-first, multi-agent social simulation app for Windows. Build it, run it, test it. Do not just describe it.

=== 1. GOAL ===

The user uploads a PDF (or text), describes a scenario, configures a run, starts it, watches agents post, reply, react, follow and change opinions in real time, inspects agents, interactions, trends and the network, reads an auto-generated analysis, and exports the results.

Priority order when trade-offs arise: (1) it runs reliably end to end, (2) results are real and traceable, (3) low LLM call count, (4) visual polish, (5) extra features.

Milestone 1 must be running tonight. Prefer a simpler working feature over an ambitious unfinished one.

=== 2. NON-NEGOTIABLES ===

- No fake progress or static data. Every post, metric and chart comes from the engine and the database.
- The real LLM is called whenever a real provider is configured. A "mock" provider exists only for tests and offline demos; when active, the UI shows a permanent amber banner "MOCK PROVIDER: simulated text is not from an LLM".
- The uploaded source must shape the issues, the personas and the posts, with chunk IDs and page numbers preserved.
- One failed LLM call never stops a run.
- API keys never reach the browser, logs, errors or exports.
- Do not install anything outside the stack below without writing the reason in docs/DECISIONS.md. Never install: Docker, Redis, Celery, Postgres, any vector DB, LangChain, LlamaIndex, camel-ai or camel-oasis, Zep, Neo4j, Next.js, an auth system, the openai or anthropic SDKs.
- No TODOs for critical features. If something cannot be done well, implement the simpler version described here and list it in docs/KNOWN_LIMITS.md.
- Make small implementation decisions yourself and record notable ones in docs/DECISIONS.md. Only stop to ask me when a requirement here is contradictory or a needed key is missing.

=== 3. STACK (fixed) ===

Backend: Python 3.11 or 3.12, FastAPI, Uvicorn, Pydantic v2, httpx (async), stdlib sqlite3 (WAL mode), pymupdf (fallback pypdf), python-docx, rank-bm25, networkx, python-dotenv, sse-starlette.
Tests: pytest, pytest-asyncio, respx.
Frontend: React 18 + TypeScript + Vite + Tailwind CSS, recharts, react-force-graph-2d, lucide-react. Plain fetch + EventSource; no state library unless clearly needed (zustand allowed).
Serve the built frontend from FastAPI at http://127.0.0.1:8000 (one process, one port). Bind to 127.0.0.1 only.

=== 4. REPO LAYOUT ===

oasis-sim/
  start.bat  dev.bat  reset.bat  README.md  .env.example  .gitignore
  docs/ (MASTER_BUILD_PROMPT.md, DECISIONS.md, KNOWN_LIMITS.md)
  backend/requirements.txt
  backend/app/main.py config.py db.py errors.py smoke.py
  backend/app/api/ (settings.py providers.py sources.py runs.py stream.py export.py)
  backend/app/llm/ (gateway.py adapters.py parsing.py ratelimit.py presets.py mock.py)
  backend/app/ingest/ (extract.py clean.py chunk.py index.py brief.py)
  backend/app/sim/ (models.py seeding.py engine.py feed.py policy.py opinion.py memory.py relations.py events.py budget.py)
  backend/app/analytics/ (metrics.py network.py narratives.py report.py)
  backend/tests/ (one file per area + fixtures)
  frontend/ (Vite app; src/pages, src/components, src/lib/api.ts, src/lib/sse.ts)
  data/ (created at runtime: oasis.db, uploads/, exports/, logs/, settings.json) -- git-ignored

=== 5. DATABASE (SQLite, data/oasis.db) ===

Use plain SQL in db.py with a schema_version table. JSON stored as TEXT. Tables:
sources, chunks, runs, agents, posts, reactions, edges, edge_history, memories, stance_history, events, metrics, llm_calls, reports — with the columns given in the original spec (see chat transcript of 20 Oct 2026).

=== 6. LLM GATEWAY (the only code that talks to providers) ===

Presets: openrouter, opencode_zen, nvidia_nim, kilo, fcc, tokenharbor, custom, mock — definitions as in the original spec.
Adapters: openai_chat (chat/completions, content -> reasoning_content -> reasoning fallback), anthropic_messages (x-api-key + Authorization + anthropic-version 2023-06-01, system top-level).
Gateway API: async complete(task, messages, expect, run_id) -> LLMResult. Never send tools or response_format. Prompt-based JSON + tolerant parsing + one repair retry. Retries only on 429/5xx/timeout/connection (max 3, backoff 2/6/15s + jitter, honour Retry-After <= 120s). Fallback models/provider. Token-bucket RPM + concurrency semaphore. Budget check per call (BudgetExhausted -> deterministic-only). Every call recorded in llm_calls; cache by request_hash; replay mode serves only from llm_calls. Connection test endpoint reports auth_ok, model_ok, latency_ms, json_ok, reasoning_seen.

=== 7. INGESTION ===

.pdf/.txt/.md/.docx up to 50 MB; sha256 dedupe; per-page PyMuPDF extraction; scanned-PDF guard (page < 20 chars -> image-only; >50% image-only -> error); MAX_PAGES default 200; header/footer removal (>40% pages), dehyphenation, NFKC; chunks 250-400 words with 1-paragraph overlap, never across headings, keeping page_start/page_end/heading; BM25 index; world brief via LLM (map/reduce over 60 chunks) with deterministic fallback; brief editable before seeding.

=== 8. SIMULATION ===

Agent fields: identity, archetype, Big Five -> derived traits (activity, reactivity, tolerance, stubbornness), goals, interests, stances {issue: value+confidence}, state {mood, arousal, fatigue}, knowledge, belief_summary.
Seeding: target stance mix (default 30/30/40), archetype mix; persona batches of 5 with template fallback; knowledge 2-4 chunks per agent via BM25; initial follow graph k = 3 + round(5*extraversion), weighted by stance similarity 0.6 / shared group 0.2 / random 0.2, preferential attachment for expert/journalist/official.
Tick loop: events -> activation (activity*(1-fatigue)) -> feed scoring (followed 1.0, recency decay 0.8*exp(-(t-pt)/2), log engagement 0.5*log1p(likes+2*reposts), interest overlap 0.6, stance similarity 0.4, exploration 0.3*rng; top 10, 20% random) -> reactions (p_like = reactivity*agreement*(0.5+0.5*trust); p_repost = 0.3*p_like*extraversion; follow/unfollow thresholds) -> speakers urge = extraversion*(0.5+arousal)*salience*provocation, top writes_per_tick, batch of 3 per LLM call -> opinion update (bounded confidence, rate 0.12, backfire rule) -> state/relations (weights *0.97 decay) -> memory (importance + recency + overlap, keep 50) -> reflection every 5 ticks -> metrics -> ONE transaction, rng_state saved, SSE events.
Presets: Quick 16/12/4 (~40 calls); Standard 30/25/8 (~110); Large 60/40/12 (~220).

=== 9. ANALYTICS AND REPORT ===

Deterministic analytics: stance trajectories, biggest shifts, influencers (PageRank + engagement), Louvain communities, TF-IDF narratives per community, turning points, source usage. Then one report LLM call over the analytics JSON; fallback template report.

=== 10. API (prefix /api; AppError shape) ===

health | settings (PUT may set keys -> .env, never returned) | providers + models + test | sources (upload, brief get/put, chunks) | estimate | runs CRUD + seed/start/pause/resume/stop + events | stream (SSE; event types: run_status, stage, tick_started, tick_completed, post_created, reaction_batch, edge_changed, llm_call, waiting, warning, error; heartbeat 10s) | agents | posts (filters) | graph | metrics | llm-calls | errors | report | export (json, md, csv zip) | replay.

=== 11. UI ===

Home (runs list) | New simulation wizard (Source, Scenario + editable brief, Configure with estimate, Review personas) | Run page: sticky header (status, tick progress, Pause/Resume/Stop/Inject event, LLM calls vs budget, heartbeat dot) + tabs Overview / Feed / Agents / Network / Insights / Log | Settings drawer (provider, model from /models with free filter, write-only key, temperature, tokens, RPM, Test connection).
Look: dark-first, one accent, Inter + JetBrains Mono, 8px grid, 12px radius cards, stance colours: con = orange, neutral = grey, pro = teal.
Never-frozen: stage labels, countdowns on rate-limit waits, error toasts linking to the Log tab.

=== 12. CONFIG ===

.env.example as in the original spec. data/settings.json overrides .env for non-key settings; keys are written to .env only.

=== 13. WINDOWS STARTUP ===

start.bat: version checks with download links; .venv creation; pip install; frontend build (hashed stamps to skip unchanged); .env bootstrap message; port check; uvicorn on 127.0.0.1:8000; open browser. dev.bat: uvicorn --reload + vite dev with /api proxy. reset.bat: confirm, delete data\. pathlib everywhere, paths with spaces must work.

=== 14. TESTS (pytest; all offline except smoke) ===

ingest, parsing, adapters (respx), gateway reliability, seeding, memory, relations, opinion, engine determinism, recovery, api flow, and opt-in smoke (real provider, 6 agents, 3 ticks, 2 writes/tick, <10 calls).

=== 15. MILESTONES ===

M1 (tonight, vertical slice): repo + start.bat; config + presets; gateway (both adapters, mock, retries, rate limit, budget, parsing, connection test); ingestion + BM25 + world brief; seeding; full tick loop with LLM writing; SQLite persistence with atomic ticks + startup recovery + resume; SSE; UI: Home, wizard, Run page header, Overview + Feed tabs; settings drawer with Test connection. Tests: ingest, parsing, adapters, gateway, engine, recovery.
M1 ACCEPTANCE: (a) mock Quick run completes < 1 minute; (b) real free provider: upload PDF, run Quick, >= 20 LLM-written posts some with page badges, stance lines move; (c) kill server mid-run, restart, Resume completes, no duplicates; (d) wrong key -> readable error naming provider and fix.
M2: Agents tab + drawer, Network tab with tick slider, Log tab, inject events, model list with free filter, fallback provider.
M3: analytics, report, Insights tab, exports (json, md, csv zip), replay mode.
M4: polish, README with screenshots, remaining tests, docs/KNOWN_LIMITS.md.

=== 16. HOW YOU WORK ===

- Use PowerShell syntax. Run the app and the tests yourself; read the output; fix before moving on.
- Keep modules small and typed. Prefer clear code over clever code.
- Never print or commit keys. Never weaken a test to make it pass.
- At the end of each milestone, report: what works (with how to see it), test results, known limits, and the exact next step.
