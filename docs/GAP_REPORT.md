# Gap report — baseline for The Social World

Date: 2026-10-21. Branch: `feat/the-social-world` (from `agent/m2-master` at `73d1ea5`).

This report maps every phase of the master implementation prompt to the code that
exists, before the product work in this branch. Phase 1 safety changes have already
landed at the time of writing and are marked "Phase 1 delta" where relevant.

## Verified baseline

- Backend: 76 tests passed before any change (`pytest backend/tests`). After the Phase 1
  delta: 88 tests passed.
- Frontend: `npm run build` completed with no errors.
- App: starts through `start.bat`; `/api/health` returned `ok: true`.
- Baseline screenshots: `docs/screenshots/baseline/` (1440×900 and 390×844).
- Current live provider at baseline: Token Harbor (`deepseek-v4-flash:free`); its account
  balance was $0, so recent attempts recorded provider 402 errors and fell back to
  labelled template posts. NVIDIA NIM (`z-ai/glm-5.3-flash`) has a working key.

## Architecture map

- Entry: `backend/app/main.py` (FastAPI, routers, recovery, static UI).
- API: `app/api/{sources,runs,stream,settings,providers,export}.py`.
- Persistence: `app/db.py`, SQLite WAL at `data/oasis.db`; tables `sources`, `chunks`,
  `runs`, `agents`, `posts`, `reactions`, `edges`, `edge_history`, `memories`,
  `stance_history`, `events`, `metrics`, `llm_calls`, `reports`, `schema_version`.
- Simulation: `app/sim/{engine,seeding,feed,opinion,memory,relations,events,budget,policy,models}.py`.
  One run at a time; one worker task per run; per-tick atomic commit.
- LLM: `app/llm/{gateway,adapters,mock,presets,parsing,ratelimit}.py`. JSON prompts only,
  retries, one repair, cache/replay, fallback chain, per-run call budget.
- Ingestion: `app/ingest/{extract,clean,chunk,index,brief}.py`; chunk ids `c_…` with page
  bounds; BM25 index per source.
- Analytics: `app/analytics/{report,metrics,network}.py`; counted report + optional
  labelled LLM essay.
- Frontend: React 18 + Vite + Tailwind, dependency-free hash router, SSE, Recharts,
  react-force-graph. Design tokens in `frontend/src/tokens.css`.

## Direct questions from the prompt

| Question | Answer from the code |
| --- | --- |
| Interactions recorded? | Follows are recorded in `edges` (with weight and interaction counts); replies are recorded on posts (`parent_id`) and bump `edges.interactions`; likes/reposts are recorded only as aggregate counts on `posts` (the `reactions` table exists but the engine does not insert per-reaction rows). There is no mentions system. |
| Stance per tick? | Yes. `commit_tick` writes one `stance_history` row per agent per issue per tick; the Agents tab reads it as a series. |
| Fork a run at tick N? | No. There is no state snapshot or parent-run branch in the engine. Truthful alternative: a new run from round 1 with the same source, scenario, config and seed plus a scheduled intervention. Phase 1 added `POST /api/runs/{id}/branch` labelled `rerun_from_round_1`. |
| What does the seed control? | Persona slot → group/stance targets, initial follow graph, per-tick RNG streams for activation/feed/reactions, and deterministic fallback choices. It does **not** make LLM text reproducible. |
| Ingestion extract issues/groups with page refs? | The world brief (`app/ingest/brief.py`) produces 1–3 issues and 3–8 stakeholder groups with `evidence_chunk_ids`; chunks carry page bounds, so the UI can show pages. It is LLM-generated with a deterministic fallback; no separate NER/issue extraction. |
| Providers/presets and API style? | `openrouter`, `opencode_zen`, `nvidia_nim`, `kilo`, `fcc`, `tokenharbor`, `custom`, `mock`; mostly OpenAI chat completions, `fcc` and optionally Zen use Anthropic messages. Phase 1 added `ollama` and `lmstudio`. |
| How are calls/retries/repairs/spend counted? | Every HTTP attempt that reaches a provider is a row in `llm_calls` with task, provider, model, status, http status, tokens and latency. `runs.llm_calls_used` increments only on `status='ok'`. Retries are separate error rows; repair results are `ok` or `parse_failed`; fallback switches are `fallback` rows. There is no token-price accounting (only tokens). Cache hits create no new row and do not increment the run budget. |

## Phase-by-phase status at baseline

| Phase | Status | Detail / truthful alternative |
| --- | --- | --- |
| 0 Inspect/baseline | Done | This report, tests, build, baseline screenshots. |
| 1 Safety | **Phase 1 delta: supported** | Redaction filter (`app/logsafe.py`); `.env.example`; atomic per-tick commit already existed; added per-run `seq`, unique `(run_id, seq)` and indexes; SSE IDs/heartbeat/Last-Event-ID/backfill (`stream_events`, `/api/runs/{id}/backfill`); atomic budget reservation (`runs.llm_reserved`); manifest (`runs.manifest_json`, app/provider/seed/source SHA); seeding stop guard and background start/resume. WAL already on; added `busy_timeout`. Two simultaneous runs are still disallowed by design (one writer). |
| 2 Rename/brand | Not started | Internal DB filename and localStorage keys will stay for compatibility; all user-facing names change. Mark/favicon assets are new. |
| 3 Tokens/colour | Mostly supported | `tokens.css` already uses the recommended neutral/blue palette, dark default and light overrides. Missing: paper `source` tone, generated treatment, aliases (`--surface`, etc.). CSS resets `.mo a` outrank `.btn-primary`; fix with `:where()`. Monospace use is high and section labels are uppercase mono. |
| 4 Provenance | Partial | Feed shows citations and a source drawer with disclaimer; executive summary has the exact honesty label. Mock provider shows one global banner, not a stripe on every mock run screen; exports have no watermark; no shared provenance classes; citation chips are not paper-toned. |
| 5 Navigation/language | Needs frontend restructure | Existing nav is Home / Simulations / Documents / Settings; run tabs are Live / Agents / Network / Events / Analysis / Log. No Simulation entity separate from a run. Truthful alternative: treat one run as one simulation execution, add Run details drawer and re-run/duplicate actions, rename UI labels only. Source drawer is not URL-addressable yet. |
| 6 First run <60s | Cannot be done as specified today | No bundled sample world or import. Will add `examples/` PDF + a prebuilt run bundle and a first-start import. Ingestion is request-bound and has no page progress events; will show honest phase text, no fake percentage. Agent editing before seeding is not supported; the wizard shows the generated mix and explanation. |
| 7 Live run | Partial | Ruler is static (posts per round by stance), feed groups by tick, stance filter and follow-live exist; no play/scrub, no what-changed strip, no group/page filters, no virtualisation. SSE updates are coalesced. |
| 8 Findings/report | Partial | Analysis tab has counted charts, counts, report markdown and JSON/CSV/MD export; no per-finding denominators/evidence links; no PDF export. The LLM essay is correctly separated and labelled. |
| 9 Interventions | No fork | Injection is supported (public or group-private, scheduled/persisted). Truthful comparison: branch endpoint creates a re-run from round 1; compare endpoint counts differences. |
| 10 Connections | Partial | Force graph from recorded follow/reply edges; empty state exists; no group-first/matrix strategy; 100-agent readability unproven. |
| 11 Providers | Partial | Presets, model listing, connection test and plain hints exist. Phase 1 delta added local presets, OpenRouter 200-with-error body checks, single-system-message merge, 402/auth pause, per-post model/provider provenance. No cost estimate (token prices unknown). |
| 12 States | Partial | Many screens have empty/loading/error states; audit and success confirmations are incomplete. |
| 13 Responsive/a11y | Partial | Mobile header/bottom nav exists; run tabs are not a mobile bottom bar; source drawer is full-width, not a sheet; Esc closes drawer but focus is not trapped; no aria-live batch announcement. |
| 14 Visual QA | Tooling exists | `tools/qa_shots.py` captures final screens; a full five-viewport/two-theme pass must be repeated after changes. |
| 15 Verification | Prior evidence exists | A real NVIDIA run (`run_a5d78ff597`, 8 agents, 8/8 ticks, 25 posts, 15 calls) and a mock run exist. Must be repeated after changes; current Token Harbor balance is $0 and cannot provide real posts. |
| 16 Docs/GitHub | Partial | README, M1/M2/M4, DECISIONS, KNOWN_LIMITS exist. No LICENSE, CONTRIBUTING, SECURITY, CI or issue/PR templates; no git remote and `gh` CLI is not installed, so publishing requires the user's credentials. |

## Known correctness issues found and fixed in Phase 1

1. A stop during seeding was overwritten by `seed_run` finalising to `ready`.
2. Resume of a seed-interrupted run with zero agents started an empty tick loop.
3. Start/seed were tied to the HTTP request; a disconnect could strand `seeding`.
4. Posts had no stable per-run order (content-hash id ordering).
5. SSE had no event ids, replay, or REST catch-up.
6. Budget checks were not atomic across parallel write batches.
7. `_http_call` previously discarded the task-specific `max_tokens` (fixed before this branch).
8. Provider errors inside HTTP 200 bodies were treated as empty text (now classified).

## Remaining honest limitations

- No fork-at-round; comparisons use a re-run from round 1 and say so.
- No per-reaction rows, mentions, or LLM cost in currency.
- Mock runs are deterministic but still must be labelled; they are not model output.
- One active run at a time.
- Source extraction progress is phase-level, not per-page streaming.
- Agents cannot be edited before seeding; personas are generated from the brief.
