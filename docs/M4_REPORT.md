# M4 continuation — verification & polish

Date: 2026-10-21 · Branch: agent/m2-master

## Baseline
- Backend suite: 76 passed.
- Frontend build: succeeds (main 269 kB, gzip 79 kB).
- Server: http://127.0.0.1:8000, /api/health provider=nvidia_nim.
- Provider: NVIDIA NIM / z-ai/glm-5.3-flash; connection test auth/model/json OK.

## Real provider run — run_a5d78ff597
- Source policy_sim.pdf (src_aec1941644): 5 pages, 2 chunks, 714 words.
- Brief: 2 issues, 7 groups, evidence c_137eb3e7 + c_3eb94ff8.
- 8 agents, 8/8 ticks, seed 20261021.
- 25 posts, all 25 cited, 0 fallback; 40 citations; both chunks used.
- Budget 14/27; rows: 2 persona, 13 write, 1 reflect, 1 essay.
- Duration 24m41s (02:38:02 to 03:02:43 UTC).
- Report 3,461 chars: 45 follows, 51 relationships, 4 clusters.
- Essay: 1 call, 88,844 ms, attempt 1, labelled LLM DRAFT, pinned snapshot.

## Mock validation — run_988df3f631
- 8 agents, 8/8 ticks, 27 posts (27 cited), 14 budget calls / 16 rows, report generated.

## Changes
Source status mapping (extracted -> Ready, raw state kept), stored brief in source detail, failed-sha reingest, gateway task budgets + _http_call max_tokens fix, 180 s / 2000 token NVIDIA tuning, light theme token fix, SSE event names + debounce + active-run polling, tick 00 while seeding, honest health/provider labels, page-range citations + source deep links, log 500-call cap labelled, events gated, network focus/latest/particle cap, analysis colour and single-tick fixes, delete gating + report cascade.

## Visual QA
All core pages at 1280x720, 1440x900, 1920x1080, 390x844 plus light 1440; evidence and agent drawers desktop+mobile; essay card. Fixed: stale active run, seeding tick highlight, health overflow, duplicate Home lists, log count, light theme.

## Remaining limits
NVIDIA NIM 100-180 s per call and occasional unparseable JSON (all attempts logged); fixture PDF repeats page boilerplate; legacy duplicate policy.pdf rows remain; no OCR/auth; local-only.

## Launch
C:\AI\OASIS_SIM\start.bat -> http://127.0.0.1:8000
