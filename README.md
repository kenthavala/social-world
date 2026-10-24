# The Social World

**An AI social simulation lab — evolved from OASIS_SIM**

The Social World simulates how opinions spread and shift across a population of AI agents grounded in source documents. Each agent has a persona, beliefs, and a social network. They read, react, follow, and post — citing the exact document chunks that inform their views. The result is a counted, deterministic report (not a generated story) showing how the conversation evolved, which agents were influential, what narratives emerged, and where the evidence came from.

---

## Quick Start (Windows)

```bat
# From the repo root
start.bat
# Opens http://127.0.0.1:8000
```

Or manually:
```bash
# Backend
cd backend
python -m uvicorn app.main:app --reload --port 8000

# Frontend (separate terminal, for dev mode with HMR)
cd frontend
npm run dev
```

---

## Scientific honesty

The Social World simulates **plausible responses from modelled agents**. It is not a
survey, not a forecast, and not a validated predictor of real opinion.

- **Predictive accuracy has not yet been externally validated.** No observed dataset
  is linked to a run, so no accuracy figure is produced.
- The Quality tab computes **simulation quality** — how well a run is configured and
  how internally consistent its recorded data is. That score is *not* accuracy.
- Source-derived text, simulated posts, counted statistics and generated prose are
  labelled separately everywhere they appear.
- Where a metric cannot be computed honestly, the UI shows **Not enough evidence**
  rather than inventing a number.

See [`docs/VALIDATION.md`](docs/VALIDATION.md) for the dimension-by-dimension
definitions and the path to adding real external validation.

---

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Source** | A PDF you upload. Extracted to pages → chunks with page bounds. |
| **Brief** | LLM-extracted issues + stakeholder groups from the source. |
| **Run** | A simulation: N agents, T ticks, a seed, a provider/model, a budget. |
| **Agent** | Persona + Big5 traits + stances on issues + knowledge (cited chunks). |
| **Tick** | One round: events → feed → reactions → speakers → posts → opinion updates → commit. |
| **Post** | Text + stance + emotion + cited chunk IDs + provenance (model/provider/seq/via_fallback). |
| **Report** | Counted from DB rows: stance landings, turning points, clusters, citations, influencers. |
| **Essay** | Optional LLM executive summary (separate card, pinned to snapshot, labelled "LLM DRAFT"). |

---

## The Wizard (8 steps)

1. **Source** — upload or pick a document.
2. **Question** — name the simulation and state the research question.
3. **Issues** — review and edit the generated issues; add as many as you need.
4. **Stakeholders** — review and edit stakeholder groups, stances and attributes.
5. **Population** — agents, rounds and stance mix.
6. **Settings** — writes per round and the random seed.
7. **Review** — read the full configuration before committing.
8. **Launch** — create the run and hand off to the run room.

Nothing is truncated: the number of issues and stakeholder groups is whatever you
configure. If the population is smaller than the group count, the wizard and the run
log both say which groups could not be represented.

---

## Key Guarantees

- **Deterministic simulation:** Same seed + config = identical structure (mock/fallback/replay)
- **Atomic ticks:** Posts, reactions, stances, metrics, RNG state commit together
- **Crash-safe:** Startup recovers `running`/`seeding` → `interrupted`; resume from `last_completed_tick + 1`
- **Budget honesty:** Exhaustion pauses at round boundary; existing posts kept; fallback posts marked
- **Provenance on every post:** `seq` (monotonic), `model`, `provider`, `via_fallback`
- **SSE replay:** Event IDs, 15s heartbeats, `Last-Event-ID` replay, `/backfill` REST catch-up
- **Counted report:** Zero invented numbers; only the optional essay is generated text
- **Redaction:** All logs/errors pass through `redact()` (keys, Bearer tokens, JWTs masked)

---

## Screenshots

| Desktop (1440×900) | Mobile (390×844) |
|---|---|
| Light/Dark themes | Bottom nav + FAB |
| Live feed with citations | Evidence drawer |
| Network graph (lazy-loaded) | Run health rail |

---

## Documentation

| File | Purpose |
|------|---------|
| `docs/VALIDATION.md` | What realism/quality means, every dimension, and how external validation is added |
| `docs/DECISIONS.md` | 37 key implementation decisions (opinionated, recorded) |
| `docs/KNOWN_LIMITS.md` | Honest limits (no accuracy claim, scale, providers, nondeterminism) |
| `docs/RELEASE_REPORT.md` | This release's verification results and deliverables |
| `docs/MASTER_BUILD_PROMPT.md` | Original 19-phase implementation specification |
| `docs/ARCHITECTURE.md` | System architecture overview |

---

## Provider Setup

| Provider | Key Required | Notes |
|----------|--------------|-------|
| **Mock** | No | Deterministic, zero cost, CI default |
| **OpenAI** | `OPENAI_API_KEY` | GPT-4o, GPT-4o-mini, etc. |
| **Anthropic** | `ANTHROPIC_API_KEY` | Claude models |
| **OpenRouter** | `OPENROUTER_API_KEY` | Access 100+ models; error-body detection for 402/429/401 |
| **NVIDIA NIM** | `NVIDIA_API_KEY` | e.g. `z-ai/glm-5.3-flash`; set Timeout=180s, Max tokens=2000 |
| **Ollama** | No (local) | `http://localhost:11434` |
| **LM Studio** | No (local) | `http://localhost:1234` |

Keys are written to `.env` and live `os.environ` via `POST /api/settings/keys`. `GET /api/settings` returns only booleans.

---

## API Highlights

| Endpoint | Description |
|----------|-------------|
| `POST /api/runs` | Create run (records manifest: seed, source_sha256, prompt_version, app_version) |
| `POST /api/runs/{id}/seed` | Seed agents (background; Stop wins) |
| `POST /api/runs/{id}/start` | Start run (background seed_and_start) |
| `POST /api/runs/{id}/resume` | Resume interrupted/paused run |
| `POST /api/runs/{id}/stop` | Request interrupt (commits current tick) |
| `GET /api/runs/{id}/stream` | SSE: tick_started, post_created, stance_tick, run_status, heartbeat |
| `GET /api/runs/{id}/backfill` | REST catch-up after SSE gap |
| `POST /api/runs/{id}/branch` | Truthful re-run from round 1 with intervention |
| `GET /api/runs/{id}/compare?other=...` | Counted per-round stance mixes |
| `POST /api/runs/{id}/report` | Generate deterministic report |
| `POST /api/runs/{id}/report/essay` | Generate LLM executive summary |
| `GET /api/runs/{id}/narrative` | Plain-language findings computed from counted rows (no model call) |
| `GET /api/runs/{id}/realism` | Quality diagnostics: 23 dimensions + improvement actions |
| `GET /api/sources` | List sources (upload via UI) |
| `GET /api/settings` | Provider, runtime, keys (booleans), redaction preview |

### Where things live in the UI

| Screen | Route | What it is for |
|--------|-------|----------------|
| Home | `#/` | What the product does, what it does not claim, recent work |
| Simulations | `#/simulations` | The full list, searchable and filterable |
| Sources | `#/documents` | Upload, extraction status, chunks, brief status |
| Wizard | `#/new` | The 8-step guided setup |
| Run room | `#/run/<id>` | Feed, Agents, Connections, Findings, Quality |
| Settings | `#/settings` | Provider, keys, runtime limits |

---

## Testing

```bash
# Backend: 123 tests (unit, integration, pipeline regression, narrative, migration)
cd backend
python -m pytest tests/ -v

# Pipeline regression (issues/groups, quality dimensions, narrative)
python -m pytest tests/test_pipeline_n.py -v

# End-to-end acceptance through the real HTTP API (74 assertions)
cd ..
python tools/e2e_acceptance.py

# Frontend typecheck and production build
cd frontend
npx tsc --noEmit
npm run build

# Visual QA: 41 screenshots at 1920/1440/1280/390 + overflow/console audit
python ../tools/seed_demo.py ../.demo-data
# then, with the server running on :8021
node tools/visual_qa.mjs http://127.0.0.1:8021 run_demo_congestion
```

The pipeline tests drive the real code path end to end with the mock provider:
2/5/10 issues and 3/6/10/15 stakeholder groups are asserted to survive
brief → database → seeding → agents → stances → findings → report, the Quality
endpoint is asserted to never fabricate a score for an unassessed dimension, and
the narrative endpoint is asserted to cover every issue and group without a model
call.

---

## Project Structure

```
C:\AI\OASIS_SIM\
├── backend/
│   ├── app/
│   │   ├── api/           # FastAPI routes (runs, sources, stream, settings, examples)
│   │   ├── sim/           # Engine, seeding, feed, opinion, relations, budget, events
│   │   ├── llm/           # Gateway, adapters, cache, replay
│   │   ├── analytics/     # Report, realism score, metrics
│   │   ├── ingest/        # PDF extraction, chunking, BM25 index
│   │   └── db.py          # SQLite WAL, migrations v1-v5
│   └── tests/             # 96 tests (integrity, migration, recovery, seeding, gateway, API, units)
├── frontend/
│   ├── src/
│   │   ├── components/    # PostCard, EvidenceDrawer, charts, graph, etc.
│   │   ├── run/           # LiveTab, AgentsTab, NetworkTab, AnalysisTab, EventsTab, RunDetails
│   │   ├── Brand.tsx      # Mark, Wordmark, LoadingMark
│   │   ├── tokens.css     # Design tokens (surface, accent, stance-*, event, source, brand-*)
│   │   ├── shell.tsx      # Sidebar/bottom-nav, active run, provider status
│   │   └── status.ts      # Single source-state mapping
│   └── public/brand/      # mark.svg, favicon.svg, social-preview.png
├── docs/                  # DECISIONS, KNOWN_LIMITS, RELEASE_REPORT, MASTER_BUILD_PROMPT, ARCHITECTURE
├── start.bat / dev.bat / reset.bat
└── README.md              # This file
```

---

## License

MIT — see `LICENSE` (to be added).

---

## Attribution

Built with FastAPI, React 18, Vite, Tailwind, SQLite (WAL), SSE.

Product name: **The Social World** (formerly OASIS_SIM).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>