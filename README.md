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
| `docs/DECISIONS.md` | 37 key implementation decisions (opinionated, recorded) |
| `docs/KNOWN_LIMITS.md` | 18 honest limits (scale, providers, nondeterminism, etc.) |
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
| `GET /api/sources` | List sources (upload via UI) |
| `GET /api/settings` | Provider, runtime, keys (booleans), redaction preview |

---

## Testing

```bash
# Backend (96 tests)
cd backend
python -m pytest tests/ -v

# Frontend build
cd frontend
npm run build
```

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