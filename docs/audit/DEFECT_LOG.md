# DEFECT LOG — Phase 0 Full Codebase Audit

**Audit scope:** backend (FastAPI + SQLite), frontend (React 18 + Vite + Tailwind), DB schema/migrations, API routes, simulation engine, agent seeding, brief generation, issue/stakeholder persistence, Quality tab, Findings/Report, network/graph, exports, UI/UX, settings/provider, tests, Playwright config, screenshots.

**Audit date:** 2026-10-22  
**Auditor:** Claude Code (Forge, MAUS OS)  
**Methods:** Code inspection, git diff review, grep for hardcoded limits, schema analysis, API contract review.

---

## Defects Found

### D001: brief.py system prompt caps issue count to 1-3
- **File:** `backend/app/ingest/brief.py:15`
- **Location:** `BRIEF_SYSTEM` string: `"1 to 3 issues, 3 to 8 stakeholder groups"`
- **Impact:** LLM constrained to max 3 issues regardless of user configuration. Master prompt requires: "create 1, 2, 5, 10, N issues." Silent truncation — user cannot configure more than 3 issues.
- **Root cause:** System prompt text artificially limits LLM output. The `_sanitize_brief` function does NOT cap issue count itself (it iterates `raw.get("issues") or []`), but the LLM never generates more than 3 because of the prompt.
- **Fix:** Change system prompt to allow arbitrary issue counts. Ensure `_fallback_brief` and `_sanitize_brief` support N issues (they already iterate without hard cap, but fallback creates exactly 1 issue).

### D002: brief.py system prompt caps stakeholder group count to 3-8
- **File:** `backend/app/ingest/brief.py:15`
- **Location:** Same `BRIEF_SYSTEM` string: `"3 to 8 stakeholder groups"`
- **Impact:** LLM constrained to max 8 stakeholder groups. Master prompt requires: "create ... N stakeholder groups." Silent truncation.
- **Root cause:** Same as D001 — system prompt text.
- **Fix:** Change system prompt to allow arbitrary group counts. Fix `_fallback_brief` to support N groups (currently creates exactly 3).

### D003: brief.py _fallback_brief always creates 1 issue + 3 groups
- **File:** `backend/app/ingest/brief.py:193-213`
- **Function:** `_fallback_brief(scenario, source_id)`
- **Impact:** When LLM brief generation fails completely, the fallback produces exactly 1 issue and 3 stakeholder groups regardless of user needs. A user wanting 5 issues and 6 groups gets 1 and 3 — silent data loss.
- **Root cause:** Hardcoded fallback structure.
- **Fix:** Make `_fallback_brief` accept optional parameters for issue count and group count, or derive from scenario/config. At minimum, support generating N issues and N groups from the scenario text.

### D004: Wizard autosave doesn't persist brief/edit state
- **File:** `frontend/src/Wizard.tsx:56-135`
- **Mechanism:** `localStorage.setItem("tsw-wizard-draft", JSON.stringify(d))` where `Draft` type (lines 58-62) only includes: `step, sourceId, name, scenario, agents, ticks, writesPerTick, seed, preset, mix`. The `brief` and `edit` (user's detailed modifications) are NOT persisted.
- **Impact:** On page refresh, route change, or browser restart before the user hits "Save scenario brief", all detailed brief edits and stakeholder group modifications are lost. The autosave is "best-effort" but misses the critical brief content.
- **Root cause:** Draft type omits `brief` and `edit` fields; autosave effect (line 127-135) only serializes the Draft fields.
- **Fix:** Add `brief` and `edit` (or relevant subset) to the `Draft` type and `localStorage` payload. Ensure the hydrate effect (lines 94-118) restores brief from draft when available, falling back to source re-fetch. Make autosave idempotent (no duplicate entries on repeated saves).

### D005: compare_runs diff may not show meaningful differences
- **File:** `backend/app/api/runs.py:646-695`
- **Function:** `compare_runs(run_id, other)`
- **Impact:** The `out["diffs"]` section only compares `posts`, `fallback_posts`, `citation_total`, and `rounds` count difference. It does NOT include per-round stance mix differences, per-issue stance distribution changes, or citation-by-chunk delta. Users cannot see what actually changed between runs.
- **Root cause:** Diff computation limited to aggregate counts; no per-round or per-issue delta.
- **Fix:** Enhance diff to include per-round stance mix (pro/con/undecided counts per tick), per-issue stance delta (how many agents shifted stance direction/magnitude), and citation set differences (newly cited chunks vs lost).

### D006: brief.py evidence_chunk_ids silently truncated to 6 per issue
- **File:** `backend/app/ingest/brief.py:148`
- **Code:** `"evidence_chunk_ids": [c for c in (issue.get("evidence_chunk_ids") or [])[:6]]`
- **Impact:** If LLM or user provides more than 6 evidence chunk IDs per issue, the last N-6 are silently dropped. No warning, no indication to the user.
- **Root cause:** Arbitrary `[:6]` cap in sanitizer.
- **Fix:** Remove the `[:6]` cap. The evidence_chunk_ids list can grow to the number of available chunks (set by `select_chunks` limit of 12). If needed, add a warning in UI when >6 chunks are referenced, but do not silently truncate.

### D007: Wizard StepBrief save function — brief not auto-saved on navigation
- **File:** `frontend/src/Wizard.tsx:646-661`
- **Function:** `save()` called on `handleNext()` (line 686-688): `const success = await save(); if (success) onNext();`
- **Impact:** The `save()` API call writes the brief to the source document, but if the user navigates between wizard steps without explicitly clicking "Save scenario brief", or if they refresh the page, the brief is not persisted. The autosave (localStorage draft) does NOT include brief content (see D004). Two separate persistence mechanisms both miss the brief.
- **Root cause:** No auto-save of brief on every state change; save is explicit-button-dependent; autosave draft type omits brief.
- **Fix:** (See D004) Add brief to autosave draft. Also consider making `save()` called implicitly on every input change (debounced), or at minimum on every Next/Back navigation.

### D008: Engine agent stances_json schema may not match brief stance_by_issue
- **File:** `backend/app/sim/seeding.py:70` vs `WorldBrief.stakeholder_groups.stance_by_issue`
- **Impact:** The brief schema has `stance_by_issue: Record<string, number>` (flat float per issue). The seeding engine reads `group.get("stance_by_issue")` as flat floats (line 70). The agent `stances_json` stores `{"value": float, "confidence": 0.5}` per issue (clamp_persona in seeding.py line 171-198). This mismatch could cause stances to not persist correctly through the full pipeline brief → seed → DB → report.
- **Root cause:** Brief uses flat `{iss_N: float}` but agents store `{iss_N: {"value": float, "confidence": 0.5}}`. The seeding engine bridges this correctly via `template_persona` and `clamp_persona`, but if brief stance_by_issue format changes or is read differently, breakage could occur.
- **Fix:** Ensure consistent format. The current code appears consistent (brief has flat floats, seeding reads flat floats, clamps to {"value": ..., "confidence": 0.5}). Verify with tests. If no bug found, document the format contract.

### D009: _clamp_config in runs.py silently truncates agent/tick counts
- **File:** `backend/app/api/runs.py:28-44`
- **Function:** `_clamp_config(cfg)`
- **Impact:** `max(5, min(100, int(cfg.get("agents", 16) or 16)))` silently clamps agent count to [5, 100] and tick count to [1, 100]. If a user configures 200 agents or 200 ticks, they get silently truncated. Master prompt wants "create 1, 2, 5, 10, N issues and N stakeholder groups" — the clamp should either allow wider ranges or warn the user.
- **Root cause:** Hardcoded clamping bounds.
- **Fix:** Increase bounds (e.g., max 500 or remove upper bound entirely, min only) or add UI warning when config is truncated. At minimum, change to `max(1, int(...))` with no upper bound, or document the limits explicitly.

### D010: No validation that configured issues/groups actually appear in run
- **File:** Various (brief → seed → run → report pipeline)
- **Impact:** The master prompt Requirement 1-4: "Every issue and group must survive: create → edit → add another → edit again → next → previous → reload → return later → launch → backend persistence → run creation → agent seeding → simulation → findings → report → export." There is no end-to-end test or code path that verifies every configured issue and stakeholder group makes it through the full pipeline to the report. Groups or issues could be silently dropped at any layer.
- **Root cause:** No cross-layer validation; each layer assumes the previous layer passed through all data.
- **Fix:** Add validation checks at key pipeline points: (a) after brief generation, verify issue and group counts match config; (b) after seeding, verify agent count and group distribution; (c) after run completion, verify report references all issues and groups. These can be backend tests or API endpoints.

---

## Summary of Critical Defects (Phase 1 non-negotiable)

The following defects directly violate the master prompt's Phase 1 non-negotiable requirements:

| ID | Requirement Violated | Severity |
|----|----------------------|----------|
| D001 | "create 1, 2, 5, 10, N issues" — LLM capped at 3 | Critical |
| D002 | "create ... N stakeholder groups" — LLM capped at 8 | Critical |
| D003 | Fallback can't support N issues/groups | Critical |
| D004 | "Wizard must persist on every Next/Back/Launch/route-change/refresh" — autosave missing brief | Critical |
| D006 | "No silent truncation anywhere" — evidence_chunk_ids[:6] drops data | Critical |
| D009 | "No silent truncation" — _clamp_config silently truncates agent/tick counts | High |

All other defects (D005, D007, D008, D010) are important for quality but do not directly violate the Phase 1 persistence non-negotiables.

---

## Fix Priority Order

1. **Fix D001/D002:** Change BRIEF_SYSTEM prompt to allow N issues and N groups. This is the single most impactful fix — it enables the core requirement of configurable issue/group counts.

2. **Fix D003:** Make _fallback_brief support arbitrary counts. Critical for when LLM fails.

3. **Fix D006:** Remove [:6] evidence chunk cap. Direct violation of "no silent truncation."

4. **Fix D004:** Add brief to Wizard autosave draft. Critical for UX — user edits lost on refresh.

5. **Fix D009:** Widen or document _clamp_config bounds. Important for configurability.

6. **Fix D005, D007, D008, D010:** Higher-quality enhancements for subsequent phases.

---

**Note:** This defect log is the Phase 0 deliverable. No code changes have been applied yet (Phase 0 Definition of Done: "Defect log exists and covers each area above. No 'unknowns' left un-inspected."). Fixes will proceed to Phase 1 after this log is reviewed and approved.