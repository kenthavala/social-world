# KNOWN_LIMITS.md — M1 → M3 (vertical slice + product shell + exports/analytics)

1. **Scale is honest, not huge.** Designed for tens of agents and tens of ticks
   (Quick 8 agents / 8 ticks, Standard 24 / 20, Large 40 / 24; configurable to 100).
   SQLite is local-first by contract, not a cluster DB.

2. **Rule-based feed & reactions.** Activation, p_like/p_repost/follow use
   closed formulas with traits — they are calibrated heuristics, not learned.

3. **LLM nondeterminism still leaks in.** With real providers and writes>0 two
   runs share structure but not prose, even with temperature 0. Deterministic
   identity is guaranteed only for mock/fallback/replay and budget-degraded
   segments.

4. **Prompt-JSON is repairable, not foolproof.** Extremely broken outputs cost
   one repair call, then fall back to the next model/provider, then to
   template posts at end-of-chain. Garbage always surfaces as warnings, never
   as invented data.

5. **The PDF fixture path** — the M1 acceptance run used a generated
   representative PDF (policy scenario, 5 pages) to prove ingestion,
   chunk/page citations and brief grounding end-to-end. Arbitrary scanned
   PDFs are rejected with a clear error; unicode-heavy DOCX layouts may lose
   formatting.

6. **Brief generation lattice** — the brief LLM call returns issues/groups;
   agents are sampled per group's target stance. Groups smaller than one agent
   are merged; extreme unlucky splits can skew initial pop_mix slightly.

7. **No auth / no multi-tenant** — localhost single-user app. Do not expose
   8000 to other devices; .env keys are readable from the same machine.

8. **Network view draws follows, weighted.** The M2 tick ruler replays any
   committed tick from `edge_history` (double-click returns to latest);
   communities/PageRank in Insights are computed on the final snapshot only.

9. **The counted report is deterministic on purpose.** It counts recorded rows
   (decisions #18/#22/#24): stance landings, turning points, clusters, citations,
   influencers, top posts. The only generated text is the optional executive
   summary ("essay"), which is stored and rendered separately under an explicit
   "LLM DRAFT — generated, not counted data" label and is deleted when the report
   is regenerated (see #16 and decision #26).

10. **Windows-first.** Uses UNC-free relative paths and `start.bat`/`dev.bat`/
    `reset.bat`. Anywhere else equivalent commands work with bash equivalents.

11. **Chunk page attribution** — consecutive merged paragraphs carry page
    bounds of their first paragraph; a chunk spanning a page break stores
    page_start/page_end but not per-paragraph pages (stumps exact per-line
    citation within merged chunks).

12. **Replay is exacting.** `LLM_REPLAY=1` requires an exact prior recorded
    request (provider+model+task+messages hash); an empty prompt change makes
    the replay miss assertively, by design. Both toggles now live on the
    Settings page.

13. **Free providers are flaky and slow; the run tells the truth about it.** A
    real nvidia_nim run recorded 3× ReadTimeout and 1× parse-failed among 6 calls;
    every attempt is a logged `llm_calls` row. On 2026-10-21 the configured
    `z-ai/glm-5.3-flash` model measured 155–171 s per persona batch, 100–113 s per
    write batch and ~217 s for a brief at a 180 s HTTP timeout. The 90 s default
    is too tight for larger prompts; use Settings → Timeout 180 s and Max tokens
    2000 for this provider. A stalled attempt can leave a run mid-tick; stop →
    resume continues it (the recorded response is reused through the cache, so
    nothing is re-billed or fabricated).

14. **Exports are self-contained but raw.** The JSON bundle carries
    runs/agents/posts/edges/metrics/events/llm_calls/stance_history/chunks;
    the CSV zip flattens the same data. Demographics like memories and
    per-agent richer state still live only in SQLite; imports/re-exports of
    bundles into a fresh install are not (yet) a flow.

15. **Pause settles at tick boundaries.** Requesting a pause mid-tick lets the
    in-flight tick finish and commit; nothing is discarded or duplicated
    (deterministic test covers the mid-call pause specifically).

16. **The executive-summary essay is generated prose — deliberately separated.**
    The report's counted sections never call an LLM. The optional essay does
    (task `essay` in `llm_calls`), and it renders only inside a card labeled
    "LLM DRAFT (generated, not counted data)". It may paraphrase; it can never
    change a counted number, and regenerating the report deletes it (it
    summarized a snapshot that no longer exists). The essay call is exempt
    from the run's simulation budget (operator action after the run) but is
    still counted in `llm_calls_used` and cached like any other call.

17. **Source status vocabulary.** Backend source states are `extracting`,
    `extracted` and `failed`; there is no backend `ready` state. The UI maps
    `extracted` to the success label **Ready** and keeps the raw state visible in
    detail views (see decision #27). Runs additionally have `draft`, `ready`,
    `seeding`, `running`, `paused`, `interrupted`, `completed` and `failed`.

18. **The real provider is not fast.** The demo defaults should expect minutes,
    not seconds, per tick at Quick settings (2 write calls per tick with
    concurrency 2). The UI shows live progress and elapsed time; nothing is
    fabricated to look faster.
