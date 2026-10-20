# OASIS_SIM — M2 Report

**Branch:** `agent/m2-master` · **Date:** 2026-10-20 · **Baseline:** M1 vertical slice (`3a6a586`)

M2 turned the working M1 implementation into a polished OASIS-style product: a real design
system, a wizard, a 7-tab run room, persistent events, deterministic reports, a settings
page with inspectable redaction, responsive layout, and evidence that the engine runs on a
real LLM provider — while preserving every M1 guarantee (SQLite-first, additive migrations,
no API keys in UI/log/exports, zero client-side fake data).

---

## 1. Phase summary (commit per phase)

M1 baseline `3a6a586`. M2 = phases 0–11, M3-completion = phases 12–14.

| Phase | Commit | What shipped |
|---|---|---|
| 0 | `d69777a` | Test-isolation fix (config/client fixtures — M1 bug: live DB & settings leaked into tests), Playwright toolchain, baseline screenshots, decisions #11–#13 |
| 1 | `de18bf8` | Design tokens (CSS vars, IBM Plex Sans/Mono, token ramp), app shell with global nav, hash router, Simulations/Documents pages, additive chunks-list API |
| 2 | `9c9f29a` | Wizard redesign: Source → Brief → Agents → Run, document drop zone, library picker, step rail, draft runs autosave |
| 3 | `8f408e4` | Run room: 7 tabs (Overview / Feed / Agents / Network / Events / Insights / Log), auto-start from wizard, honest ELAPSED via `runs.started_at`/`finished_at` (migration v2, additive) |
| 4 | `1c1fdf7` | Per-agent detail drawer: stance history chart, traits, big five, memories, knowledge, posts with `[c_xxx p.N]` evidence chips |
| 5 | `df10c3a` | Network tab tick ruler (`?tick=N`), node inspector with full weights, legend; **M1 bug fixed: self-edges (`src==dst`) never persist** (test: `test_no_self_edges_persisted`) |
| 6 | `5283698` | Persistent scheduled events (survive restarts; rehydrated on start/resume) + stakeholder-group audience targeting (private briefings; verified live: no public leak) |
| 7 | `bcdff69` | Real deterministic reports: auto-generated on completion + manual regenerate button, provider/model captured per run, markdown-lite rendering, event double-counting fixed |
| 8 | `05c87f2` | Settings page (`#/settings`) with redact-preview (runs the real `redact()`), Documents chunk detail (real full text + citations); settings drawer removed |
| 9 | `185b5ee` | Responsive pass: network canvas width via ResizeObserver, inspector stacks on mobile; all 7 tabs verified at 390×844 (no horizontal overflow) |
| 10–11 | `9d8113a` | Real-provider run + validation evidence, pause/resume regression test, final screenshots, M2 report, decision #20 |
| 12 | `9d0e7b3` | Exports surfaced in UI (JSON/MD/CSV-zip buttons in Insights); bundle self-contained (llm_calls, stance_history, chunks, run window); redaction scan-tested |
| 13 | `0e236f9` | Insights depth: deterministic turning points, Louvain clusters with handles, source usage (cited chunks + pages) |
| 14 | `2da36ee` | Replay/cache toggles on Settings page; README + KNOWN_LIMITS refreshed for M3 |
| 15 | `435afdb` | Spec-completion sweep: TF-IDF community narratives (last §9 item), assertive gateway-replay guard + 3 replay tests, free-model filter in Settings model picker |
| 16 | `f4701fd` | Perf: Overview/Agents/Network tabs code-split via React.lazy — main bundle 789 → 223 kB, chart/graph chunks load on first use (decision #25) |
| 17 | *(this commit)* | The one generated section, done honestly: optional LLM executive summary ("essay") through the gateway — labeled, pinned to the counted snapshot, budget-exempt but counted, wiped on report regeneration (decision #26) |

## 2. Reliability, evidence & extra state (Phase 10–11)

- **Real-provider run — `run_463607ad7c`** (nvidia_nim / `z-ai/glm-5.3-flash`, Quick preset):
  completed after one stop→interrupt→resume cycle. The provider was flaky in the open
  (3× ReadTimeout, 1× parse_failed, one ~77–87 s stall) — all attempts are recorded in
  `llm_calls` with honest status/latency; final posts are real model text
  (verified: post text matches the recorded responses of the `ok` calls; 0 fallback posts).
  Even the interrupted half-tick is visible: `llm_calls` shows the tick-2 write that the
  first worker never committed, and resume finished it from the recorded response.
- **Pause/resume — re-verified** two ways:
  (a) live HTTP cycle: `run_5c4715d325` was paused and resumed through the API (pause
  landed at the tick-4 boundary; resume → completed; 0 duplicate tick/agent post groups;
  faster mock runs `run_8492f2f0b7`/`run_5b8dc0a6ed` completed before the HTTP pause could
  land — the pause genuinely mid-run is what the deterministic test guarantees);
  (b) deterministic regression test **`test_pause_then_resume_completes`** — pause is
  requested while the worker is blocked inside tick 1's LLM call (gateway held behind an
  `asyncio.Event`), tick 1 commits, the worker idles paused, and resume finishes ticks 2–3
  with no duplicated tick/agent post groups. Suite: **58 passed** at Phase 11
  (61 after the Phase 15 sweep; 70 after Phase 16–17).
- **Failure resilience (M1 semantics re-verified):** ticks commit atomically; a worker
  crash/stall leaves `running` rows that become `interrupted` on startup or via stop; resume
  restarts from `last_completed_tick + 1` and never re-commits finished ticks.

## 3. Evidence run index (preserved)

| Run | Purpose |
|---|---|
| `run_d9c6f72354` | M2 8-tick mock run (Overview with scenario, metrics) |
| `run_5c5a2af780` | Phase 5 self-edge check (52 edges, 0 self-edges) |
| `run_d3bde9b1a7` | Phase 6 events E2E (public event + private group briefing, no leak) |
| `run_861c1d7194` | Phase 7 report E2E (auto report + regenerate) |
| `run_463607ad7c` | Phase 10 real-provider run (GLM text, flaky-provider recovery; 4 error/parse rows + 2 ok) |
| `run_8533c162a3` | user run — preserve |
| `run_cc10006004` | user run — preserve |
| `run_8ed7e5a3b5` | user run — preserve |
| 39/39 163-call run | user's completed long run — preserve |

## 4. Known limitation: nvidia_nim is flaky

README's known-notes: the `nvidia_nim` endpoint (z-ai/glm-5.3-flash) intermittently stalls
or times out (~75–87 s latencies; 3 ReadTimeouts and 1 parse-failed observed in one run).
Mitigations already in place: gateway retries with backoff, records every attempt, and
supports replay-from-cache (`LLM_CACHE` / request-hash match) so an interrupted tick can be
recovered without re-paying for content already produced. `runs.provider_json` records
`{"name": "nvidia_nim", "model": "z-ai/glm-5.3-flash"}` at creation, so reports stay
traceable to the exact model even after settings change.

## 5. Legacy junk in the live DB (flagged, not deleted)

Test isolation in M1 leaked live DB usage into test runs. `data/oasis.db` contains ~29
junk sources — including a duplicate 1-page `policy.pdf` uploaded several times — plus
runs from historical test leakage ("API test" runs). Per the operator's instruction these
are **flagged only**: nothing was deleted. The user-run list above is preserved untouched.

## 6. How to run

```
.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000     # from backend\
cd frontend && npm run build                                     # produces dist served by the API
cd backend && ..\.venv\Scripts\python.exe -m pytest tests -q     # 70 passed
```

Screenshots: `docs/screenshots/{baseline,m2,final}` (Playwright chromium at
`127.0.0.1:8000`, hash-routed `#/...` views; mandated viewports 1440×900, 1280×720,
1920×1080, 390×844).

## 7. Decision index (M2)

`#11` design tokens (reference ramp wins where prompt advisory) · `#12` Playwright
toolchain · `#13` test isolation hardened · `#14` dependency-free hash router ·
`#15` self-edges never persist · `#16` canvas node hexes + replace mode ·
`#17` events: schedules persist, audiences real · `#18` reports deterministic real ·
`#19` Settings page + inspectable redaction · `#20` flaky providers expected,
recovery verified · `#21` exports surfaced, bundle self-contained ·
`#22` Insights depth (turning points / clusters / source usage) ·
`#23` replay + cache toggles on the Settings page ·
`#24` spec-completion sweep (replay loud + tested, free-model filter, TF-IDF
narratives) (see `docs/DECISIONS.md`).

## 8. Honest-state guarantees carried through M2

- Zero fake data: every number rendered (ELAPSED, tick rulers, counters, stances, graphs,
  report text) is derived from DB rows or the SSE stream at render time.
- API keys never enter UI/log/export; `GET /settings` exposes `{VAR: bool}` only, and
  `POST /api/settings/redact-preview` demonstrates the exact `redact()` masking.
- Migrations are additive (m1 → v2 `started_at`/`finished_at`): an existing M1 database
  opens unchanged.
- LLM calls (success, parse-fail, error) all surface in the Log tab — nothing silently
  dropped.
