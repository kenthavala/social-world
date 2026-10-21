# Architecture

The Social World is a local-first web application: FastAPI + SQLite on the server, a
React/Vite single-page UI, and an LLM gateway that speaks only two wire formats.

## Components

| Layer | Code | Responsibility |
| --- | --- | --- |
| HTTP API | `backend/app/api/` | sources, runs, SSE/backfill, settings, providers, exports, sample |
| Persistence | `backend/app/db.py` | SQLite WAL, one guarded connection, atomic transactions, additive migrations |
| Ingestion | `backend/app/ingest/` | per-page extraction, cleaning, chunking with page bounds, BM25 index, scenario brief |
| Simulation | `backend/app/sim/` | seeding, round loop, feed scoring, reactions, opinion, memory, relations, interventions, budget |
| LLM gateway | `backend/app/llm/` | presets, retries, one repair, cache/replay, fallback, budget, redaction |
| Analytics | `backend/app/analytics/` | counted metrics, network analytics, counted findings, deterministic report, optional essay |
| Frontend | `frontend/src/` | hash-router app, run room, source drawer, findings, compare, settings |

## Data model

```
sources(id, filename, sha256, pages, status, brief_json, error)
chunks(id, source_id, idx, text, page_start, page_end, heading, n_words)
runs(id, source_id, scenario_json, config_json, provider_json, seed, status,
     current_tick, last_completed_tick, llm_calls_used, llm_reserved,
     parent_run_id, branch_round, manifest_json, timestamps)
agents(id, run_id, handle, name, bio, archetype, stakeholder_group, persona_json,
       personality_json, traits_json, goals_json, interests_json, stances_json,
       state_json, knowledge_json, belief_summary)
posts(id, run_id, tick, agent_id, kind, parent_id, text, stance_json, emotion,
      cited_chunk_ids_json, likes, reposts, replies, is_fallback,
      seq, model, provider, via_fallback)
edges(run_id, src, dst, follows, weight, interactions, last_tick)
edge_history, memories, stance_history, events, metrics, llm_calls, reports
stream_events(id, run_id, kind, payload_json, created_at)
schema_version(version)
```

Migrations are additive: v1 → v2 (start/finish timestamps), v3 (essay columns), v4
(ordering, provenance, branch pointers, budget reservation, SSE log). An old database
keeps opening; existing posts receive a stable per-run `seq` in original row order.

## Source lifecycle

`extracting → extracted` on success, `extracting → failed` with an error otherwise. The
UI maps `extracted` to the label **Ready**; it does not rename the database state. A
re-upload of the same SHA reuses the existing row: extracted documents are deduplicated,
failed ones are re-ingested in place.

## Round lifecycle

One active run at a time. A worker task owns a run:

1. Load context (agents, edges, recent posts, source chunk set, config).
2. For each round: fire scheduled/scenario interventions, activate agents, score feeds,
   decide reactions/follows, choose speakers, batch LLM writes, materialise posts, apply
   bounded-confidence opinion updates, decay relations, reflect, compute metrics.
3. Commit the whole round in one `BEGIN IMMEDIATE` transaction, including posts,
   `stance_history`, memories, edges and metrics. Then emit `tick_completed`.
4. On completion, generate the deterministic counted report snapshot.

Stopping marks the run `interrupted`; a restart does the same for any `running`/`seeding`
rows. Resume continues from `last_completed_tick + 1`. The seed controls persona slots,
initial edges, activation/feed/reaction RNG streams and deterministic fallbacks; it does
not fix model text. Replay mode is the exact-reproduction path.

## LLM gateway

- Tasks: `brief`, `persona`, `write`, `reflect`, `report`, `essay`, `test`.
- Prompt-JSON only. No tools, response format or function calling.
- Retries on 429/500/502/503/504/529 with jitter and `Retry-After`; one repair retry for
  invalid structure; optional model/provider fallback, recorded on the post.
- Cache is SHA-256 of provider|model|task|messages. Replay serves recorded successful
  responses and asserts on a miss.
- Budget: `max_llm_calls`; a slot is atomically reserved before a call and released after.
  A budget or provider-credit/auth failure pauses at a round boundary.
- Per-post provenance: `model`, `provider`, `via_fallback`; per-run manifest: provider,
  model, seed, prompt version, app version, source SHA-256.

## SSE and REST

`GET /api/runs/{id}/stream` sends an `open` event, replays persisted `stream_events` after
`Last-Event-ID`, then live events with ids and a 15 s heartbeat comment. No-buffering
headers are set. `GET /api/runs/{id}/backfill?after_event=&after_post=` returns missed
events/posts and the latest ids. The UI coalesces bursts into one refetch per 350 ms.

## Provenance

| Class | Treatment |
| --- | --- |
| Source | paper tone, page + chunk id, document glyph, source drawer disclaimer |
| Simulated | agent post cards, “Simulated” badge on the run header |
| Counted | mono numerals with denominators; findings link to their post ids |
| Generated | dashed border + “Generated” tag; essay names its provider/model |
| Mock | striped banner on every mock run screen, watermark in PDF/Markdown |
| Configuration | run details drawer and export footers |

## Security

Keys live in `.env` (git-ignored) or the write-only Settings flow; the API returns only
booleans and non-secret set dates. A logging filter redacts authorization headers and
key-shaped strings before any handler sees them. Error responses pass through the same
redaction. No telemetry or external calls occur except the configured LLM provider.

## Performance boundaries

- Feed: latest 2,000 posts; a DOM cap per round and a “show earlier rounds” control.
  Larger runs are complete in JSON/CSV.
- Connections: agent graph ≤25; group graph 26–100; matrix + group graph 100+.
- SQLite indexes: `(run_id, seq)`, `(run_id, tick)`, `(run_id, agent_id)`,
  `stance_history(run_id, tick)`, `llm_calls(run_id, id)`, `stream_events(run_id, id)`.
