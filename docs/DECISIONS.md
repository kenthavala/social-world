# DECISIONS.md — key implementation decisions (opinionated, recorded)

1. **Hybrid determinism, not coin-flips.** Each tick derives its RNG from
   `Random(f"{seed}|{tick}")` and agent ids are salted per run, so a run with
   `writes_per_tick=0` (or a mock provider) replays byte-identically. LLM text
   is nondeterministic by nature, so post ids hash the content
   (`sha1(agent|tick|seq|text)[:12]`) instead of using random ids — same inputs,
   same posts, no ordering churn.

2. **Prompt-JSON only.** No tools, no response_format, no function calling. The
   gateway stores raw text, repairs common issues (think blocks, fences, prose
   wrappers, trailing commas, curly quotes) and retries once with a "fix your
   JSON" message before falling back. Smart quotes *inside* already-quoted JSON
   strings are dropped as decoration; curly quotes *outside* strings become
   real delimiters.

3. **Bounded confidence gate.** Acceptance window grows from the agent's
   tolerance (stubborn agents) up to 1.2 (the no-backfire threshold) as
   stubbornness drops: `gate = tol + (1.2 - tol) * (1 - stubbornness)`. Rates:
   0.12 (seen), 1.0/0.4 engagement weight, trust from edge weight; backfire
   only when |Δ| > 1.2 AND edge < −0.3.

4. **Batched writes, speaker quota.** Up to `writes_per_tick` selected speakers
   are batched 3-per-call (1–5). Replies are chosen against a target post; the
   mock contract keys off persona stance lines, not agent ids.

5. **Budget degradation is deterministic.** When the per-run call budget is
   exhausted, remaining speakers post template fallback text derived from
   persona stance; runs still complete. `max_llm_calls` defaults from the
   `/api/estimate` formula.

6. **One process, one port.** FastAPI serves the API, SSE stream
   (10 s heartbeats) and the built frontend from 127.0.0.1:8000. Vite dev mode
   is only for development and proxies `/api`.

7. **Crash safety by contiguous ticks.** Ticks commit atomically (posts,
   reactions, stance history, metrics, rng_state, llm_calls). On startup runs
   stuck in `running`/`seeding` become `interrupted`; resume restarts from
   `last_completed_tick + 1` with reloaded rng and memory/context from the DB,
   never re-committing finished ticks; resume requires the prior key exactly.

8. **Keys only as booleans.** `GET /settings` returns `keys: {VAR: bool}`.
   Writes go to `.env` + live `os.environ`. Every stored/displayed string that
   could embed a key passes through `redact()` (sk-or-, sk-, Bearer, nvapi-,
   FCC headers …).

9. **Ingest strictness** — scanned/no-text PDFs are rejected loudly, not
   silently; header/footer boilerplate is cleaned only for repeated lines;
   chunks keep page_start/page_end for citations that the UI renders as [c_xxx
   p.N] evidence chips.

10. **Mock contract is load-bearing.** Mock provider parses the same prompts
    real providers get; markers like `agent_id must be exactly "agent_x"`,
    `[c_xxx p.N]` and `action: reply` are used by tests and determinism checks.

---

## M2 (design-system + full product UI)

11. **Design tokens: reference ramp wins where the prompt was advisory.** The
    UI reference artifact ships a complete token system (`--bg-0..4`, `--line-1..3`,
    `--fg-1..4` with `base`/`-fg`/`-soft`/`-line` variants per accent, IBM Plex
    Sans/Mono, 13px base UI, 15px post text, radii 4/6/8px, durations
    120/200/320ms). Prompt §7 hexes ("suggested foundation") adopt as: where the
    prompt states an explicit color for a semantic role, that color wins
    (PRO #14B8A6, NEU #8A939E, CON #F59E0B, OK #22C55E, WARN #F59E0B,
    ERR #EF4444); where the prompt only recommends (accent #7C8CFF), the
    reference's accent **#6CA6FF (+#93BDFF fg)** is used as the cohesive system.
    Event accent violet #B08CFF is reserved exclusively for runtime/scene events.

12. **Playwright added to the toolchain.** The built-in browser harness has no
    viewport control and file:// URLs are blocked, so exact-viewport screenshots
    (1440×900, 1280×720, 1920×1080, 390×844) and browser tests use Playwright
    ( chromium, served over http://127.0.0.1:8000 ). Helper: `tools/shots.py`.

13. **Test isolation hardened (M1 bug).** The autouse `mock_provider` fixture
    reloaded config before `fresh_db` redirected `SETTINGS_FILE`, so the
    developer's live settings.json leaked into gateway/seeding tests; the
    `client` fixture in test_api.py ran against the live DB and started real
    runs ("API test" on the live server). Fix: `fresh_db` re-syncs the config
    singleton after redirects and `client` now depends on `fresh_db`.
    (Side effect visible in the live DB: historical test runs/uploads, e.g.
    duplicate policy.pdf sources — kept, flagged in M2_REPORT.)

14. **Routing: dependency-free hash router.** Views map to URLs
    (`#/`, `#/simulations`, `#/documents`, `#/settings`, `#/new`, `#/run/<id>`)
    so refreshing mid-run returns to the same run. No react-router; ~40 lines in
    `frontend/src/router.ts`. Runs open full-width (not in the max-w column).

15. **Self-edges never persist.** M1 let "agent reacts to own post" persist a
    `src==dst` edge row (found 5 in a live run). Fixed at both edge-INSERT
    sites in `sim/engine.py` (seed loop + tick persist) by skipping
    `src == dst` — a self-reaction is not a relationship. Regression test
    `test_no_self_edges_persisted` (mock run with writes, asserts 0).

16. **Canvas nodes use concrete hexes; nodes drawn in "replace" mode.** Canvas
    contexts cannot resolve CSS vars, so network-node stance colors are
    hard-coded to the same semantic hexes (#14B8A6/#8A939E/#F59E0B, selection
    ring #6CA6FF). `nodeCanvasObjectMode="replace"` takes over drawing
    completely (circle + selection ring + labels), removing reliance on the
    library's default renderer.

17. **Events: schedules persist, audiences are real.** Injected events are
    written to the events table (`kind=scheduled`, marked `fired` when
    delivered) so schedules survive restarts; `_rehydrate_scheduled()` rebuilds
    the in-memory queue on start/resume. Audience targeting: `all` keeps M1
    broadcast behavior (public newsroom post); a stakeholder group becomes a
    private briefing — no public post, no knowledge push outside the group,
    delivery traceable via members' memories and the event log
    (`audience`/`private` payload flags). Verified live: group briefings never
    leak into other agents' memories or the public feed.

18. **Reports are deterministic and real.** The `reports` table existed in M1
    but nothing ever wrote to it — the "auto-report" was an empty promise.
    Now: `app/analytics/report.py` generates a report snapshot purely from the
    run's DB rows (stance/endorsement counts, engagement, PageRank, events,
    llm_calls, fallbacks) on run completion (auto) and via `POST
    /runs/{id}/report` (manual regenerate button). Report generation failures
    are logged as run events, never silent. `runs.provider_json` now records
    the provider/model at creation so the report's "Provider" line is
    traceable. The Insights UI renders the markdown with a ~30-line renderer
    (no dependency added).

20. **Flaky providers are expected; recovery is the product.** The Phase 10
    real-provider run (nvidia_nim / z-ai/glm-5.3-flash) hit 3× ReadTimeout,
    1× parse-failed and one stalled attempt before completing; every attempt
    is recorded in `llm_calls` with honest status/latency. The run was recovered
    with M1's stop→resume path — resume re-issued only the unfinished tick and
    reused the recorded response via the request-hash cache, completing in ~2 s
    with 0 fallback posts. Consequence for UI: ELAPSED/counts always come from
    the run row, never from the client clock. A mid-run pause is now covered
    by a deterministic test (`test_pause_then_resume_completes`, gateway held
    behind an asyncio gate while pause is requested).

## M3 (exports, analytics depth, replay UX)

21. **Exports are surfaced and self-contained.** The M3 export API existed but
    no UI used it. The Insights tab now has JSON / Markdown / CSV-zip download
    buttons (real endpoints, `download` anchors). The bundle grew into a
    self-contained raw dataset: `llm_calls` log (honest statuses/latency),
    per-tick per-issue mean `stance_history`, source `chunks` (id/heading/
    pages/text), and the run's started/finished window. The csv zip ships 8
    tables. A regression test asserts bundle completeness and scans the raw
    download for `sk-`/`nvapi-`/`Bearer`/`eyJ` to prove zero key material.

22. **Insights depth, still zero invented data.** The deterministic report now
    includes the spec's §9 analytics: turning points (top 3 per-issue
    tick-to-tick mean-stance deltas from `stance_history`), Louvain
    conversation clusters named with agent handles, and source usage (which
    chunks the posts actually cited, with page bounds — the real-provider run
    cited its policy chunk 3×). All counted from DB rows; md + report_json.

23. **Replay/cache toggles live on the Settings page.** `llm_cache` and
    `llm_replay` round-tripped through the API but had no UI control; the
    Runtime section now has two selects ("on/off"). Replay asserts on any
    request with no prior identical recording — kept as an assertive miss, now
    reachable without editing `.env`.

## Phase 15 — spec-completion sweep

24. **Replay is loud; free-model filter is real; narratives are counted.**
    Three spec items closed in one sweep:
    (a) The gateway replay path had **zero test coverage** — now covered by
    3 tests (serve recorded response, assertive miss, and a new guard: a
    recorded "ok" row whose text no longer parses raises `replay_invalid`
    instead of silently degrading to fallback posts).
    (b) The models endpoint always returned `free_only`; the Settings model
    picker now has a "Free models only" checkbox that filters with an honest
    counter (NVIDIA's listing marks none with `:free` — the UI says so rather
    than inventing a list).
    (c) Spec §9's final missing element — **TF-IDF narratives per community**
    — land in the report: for each Louvain cluster, the top 6 terms over that
    cluster's own posts (stopword-trimmed, deterministic tie-breaks) plus the
    community's most-engaged post. Counted text, never generated.

19. **Settings is a page; redaction is inspectable.** The settings overlay
    drawer became `#/settings` as a real page (provider / runtime / keys /
    redaction sections). New additive `POST /api/settings/redact-preview` runs
    the exact `redact()` used on errors/logs so anyone can verify masking
    (sk-/nvapi-/Bearer /eyJ) without ever sending a real key. Documents page:
    chunk rows expand to the chunk's full TEXT via the existing per-chunk GET
    (the listing stays lean — no text in bulk payloads).

25. **The heavy chart/graph tabs load on first use.** One 789 kB `index.js`
    shipped recharts (Overview + Agents) and react-force-graph-2d (Network)
    on every visit, even to the home page. `OverviewTab`, `AgentsTab` and
    `NetworkTab` became `React.lazy` chunks behind a `Suspense` spinner in
    `RunShell` — the main bundle dropped to **223 kB** (gzip 68 kB), with the
    recharts core (363 kB) and force-graph (176 kB) loading only when a tab
    is opened. Zero behavior or route change; all three tabs verified
    rendering charts/canvas with no console errors (`p16_overview_lazy.png`,
    `p16_network_lazy.png`, agent drawer chart). Even on a localhost,
    local-first app this keeps cold loads and any slower remote deployments
    honest — perf work without touching product behavior.

26. **The report gains ONE generated section — the LLM executive summary —
    fenced off by design.** The counted report is deterministic by spec; a
    summary written by the model was therefore never allowed to blur into it:
    - The essay is a separate `POST /api/runs/{id}/report/essay` action (an
      Insights button): it goes through the gateway as task `essay`, is
      recorded in `llm_calls`, consumes a real call, and is stored in two
      new `reports` columns (additive migration v3) — `essay_json` (9
      labeled sections: headline / opinion shifts / narratives / influential
      voices / communities / events / contradictions / unexpected /
      limitations) and `essay_meta_json` (provider, model, cache status,
      created_at, and the `report_created_at` it was pinned to).
    - It renders only inside a card headed "LLM DRAFT (generated, not
      counted data)", with the meta line naming the exact provider/model,
      call status and the pinned counted snapshot. The prompt receives the
      counted facts as JSON only and is told to invent nothing.
    - Regenerating the report **deletes** the essay — it summarized a
      snapshot that no longer exists (and GET returns `essay: null`).
    - The call is exempt from the run's simulation budget (operator action
      after the run; `max_llm_calls` guards in-run work) but is still
      counted in `llm_calls_used`, stays visible in the call log, and a
      cache hit makes a rewrite free (no new row, `from_cache` shown).
    - Failures are loud and leave the counted report untouched; no essay is
      stored. The same essay rides along in exports with its honesty label.

## M4 continuation — finish, verify, polish

27. **The source lifecycle has three states, and the UI maps them once.**
    `app/api/sources.py` only ever writes `extracting`, `extracted` or `failed`.
    "ready" was never a backend source state; treating it as one produced badges
    that stayed "ingesting" forever. `frontend/src/status.ts` is now the single
    mapping: `extracted → Ready` (success), `extracting → Extracting` (live),
    `failed → Failed`; the raw backend value remains visible in the detail view.
    The wizard gates "next" on `usable`, shows extraction errors, and reuses a
    stored brief. A re-upload of the same sha now reuses a failed row instead of
    tripping the UNIQUE constraint (regression test `test_reupload_failed_source_recovers_in_place`).

28. **Task-specific output budgets — and a real plumbing bug fixed.**
    Persona batches and the essay are long-form; a 1200-token cap truncated valid
    JSON on verbose models (`finish=length` at 1200 in a real NVIDIA run). `_send`
    now budgets persona/essay at 2× the configured cap and a repair after a
    truncated answer gets a further 2× (capped at 4000). Critically, `_http_call`
    used to recompute `max_tokens` from config, silently discarding the doubling
    for both wire formats; it now receives the computed budget. Covered by
    `test_long_form_tasks_get_a_bigger_output_budget` and
    `test_repair_after_truncation_doubles_the_budget` (suite now 76 tests).

29. **Slow providers are tuned operationally, not hidden.**
    The configured NVIDIA NIM model (`z-ai/glm-5.3-flash`) was measured at
    155 s / 171 s for persona batches, 101 s / 113 s for write batches and ~217 s
    for a full brief (one 180 s timeout then success). With the old 90 s timeout
    the brief produced ReadTimeouts and the gateway fell back. The live settings
    now use Timeout = 180 s and Max tokens = 2000. Every attempt stays in
    `llm_calls`; a slow call is not reported as a system failure, and a fallback
    is labeled as a fallback.

30. **Provider status is configuration, not a health claim.**
    The shell/provier card says `configured` / `no key` (or `mock`) instead of
    "connected"; only the Settings **Test connection** button performs a live
    check and reports auth/model/JSON/latency. The run health tile is compact and
    honest by state: `live` only while an active run's SSE stream is connected,
    `retry` while reconnecting, `paused`, `stopped`, `error`, and `done` for a
    finished run (never "streaming" after completion). The tick ruler only marks
    an in-progress tick when the run has actually entered one (draft/seeding shows
    00).

31. **Evidence is one click from post to page.**
    `GET /api/sources/{id}` now carries the stored brief, so revisiting a document
    never pays for regeneration. Documents and the wizard accept deep links
    (`#/documents?source=…`, `#/new?source=…`), the evidence drawer opens the exact
    source document, and run creation rejects a source that is not `extracted`.
    Chunk listings include per-chunk citation counts plus the source's chunk/word
    totals; failed rows surface their `error` instead of looking merely "not ready".
