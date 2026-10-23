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
- **Verification:** Reproduced (code). `backend/app/ingest/brief.py:11-24` `BRIEF_SYSTEM` now states "there is no artificial upper bound on the number of issues or stakeholder groups"; old "1 to 3 issues, 3 to 8 stakeholder groups" cap removed. Inline Python: `assert "1 to 3 issues" not in BRIEF_SYSTEM` and `assert "no artificial upper bound" in BRIEF_SYSTEM` → passed. LLM no longer prompted to cap issues at 3.

### D002: brief.py system prompt caps stakeholder group count to 3-8
- **File:** `backend/app/ingest/brief.py:15`
- **Location:** Same `BRIEF_SYSTEM` string: `"3 to 8 stakeholder groups"`
- **Impact:** LLM constrained to max 8 stakeholder groups. Master prompt requires: "create ... N stakeholder groups." Silent truncation.
- **Root cause:** Same as D001 — system prompt text.
- **Fix:** Change system prompt to allow arbitrary group counts. Fix `_fallback_brief` to support N groups (currently creates exactly 3).
- **Verification:** Reproduced (code). Same `BRIEF_SYSTEM` change as D001 — "no artificial upper bound" present, "3 to 8 stakeholder groups" cap removed. Inline Python check passed. LLM no longer prompted to cap groups at 8.

### D003: brief.py _fallback_brief always creates 1 issue + 3 groups
- **File:** `backend/app/ingest/brief.py:193-213`
- **Function:** `_fallback_brief(scenario, source_id)`
- **Impact:** When LLM brief generation fails completely, the fallback produces exactly 1 issue and 3 stakeholder groups regardless of user needs. A user wanting 5 issues and 6 groups gets 1 and 3 — silent data loss.
- **Root cause:** Hardcoded fallback structure.
- **Fix:** Make `_fallback_brief` accept optional parameters for issue count and group count, or derive from scenario/config. At minimum, support generating N issues and N groups from the scenario text.
- **Verification:** Reproduced (script). `python -c "from app.ingest.brief import _fallback_brief; b=_fallback_brief('s','x',n_issues=5,n_groups=6); assert len(b['issues'])==5 and len(b['stakeholder_groups'])==6"` → 5 issues + 6 groups produced (no silent truncation to 1/3). EXIT 0.

### D004: Wizard autosave doesn't persist brief/edit state
- **File:** `frontend/src/Wizard.tsx:56-135`
- **Mechanism:** `localStorage.setItem("tsw-wizard-draft", JSON.stringify(d))` where `Draft` type (lines 58-62) only includes: `step, sourceId, name, scenario, agents, ticks, writesPerTick, seed, preset, mix`. The `brief` and `edit` (user's detailed modifications) are NOT persisted.
- **Impact:** On page refresh, route change, or browser restart before the user hits "Save scenario brief", all detailed brief edits and stakeholder group modifications are lost. The autosave is "best-effort" but misses the critical brief content.
- **Root cause:** Draft type omits `brief` and `edit` fields; autosave effect (line 127-135) only serializes the Draft fields.
- **Fix:** Add `brief` and `edit` (or relevant subset) to the `Draft` type and `localStorage` payload. Ensure the hydrate effect (lines 94-118) restores brief from draft when available, falling back to source re-fetch. Make autosave idempotent (no duplicate entries on repeated saves).
- **Verification:** Verified (code inspection). `frontend/src/Wizard.tsx:59-64` `Draft` type now includes `brief` and `edit`; lines 133-144 autosave serializes both; lines 106-110 hydrate restores `brief`/`edit` from draft; lines 148-162 beforeunload persists on every navigation/refresh. Fix confirmed in place.

### D005: compare_runs diff may not show meaningful differences
- **File:** `backend/app/api/runs.py:646-695`
- **Function:** `compare_runs(run_id, other)`
- **Impact:** The `out["diffs"]` section only compares `posts`, `fallback_posts`, `citation_total`, and `rounds` count difference. It does NOT include per-round stance mix differences, per-issue stance distribution changes, or citation-by-chunk delta. Users cannot see what actually changed between runs.
- **Root cause:** Diff computation limited to aggregate counts; no per-round or per-issue delta.
- **Fix:** Enhance diff to include per-round stance mix (pro/con/undecided counts per tick), per-issue stance delta (how many agents shifted stance direction/magnitude), and citation set differences (newly cited chunks vs lost).
- **Verification:** NOT FIXED. `backend/app/api/runs.py:691-697` `compare_runs` `diffs` still only reports aggregate counts (posts, fallback_posts, citation_total, rounds-count). No per-round stance-mix delta, per-issue stance delta, or citation-by-chunk delta in `diffs` (per-round mix exists in `out[key]["rounds"]` but is not diffed). Slated for Phase 2 quality work — not a Phase 1 non-negotiable.

### D006: brief.py evidence_chunk_ids silently truncated to 6 per issue
- **File:** `backend/app/ingest/brief.py:148`
- **Code:** `"evidence_chunk_ids": [c for c in (issue.get("evidence_chunk_ids") or [])[:6]]`
- **Impact:** If LLM or user provides more than 6 evidence chunk IDs per issue, the last N-6 are silently dropped. No warning, no indication to the user.
- **Root cause:** Arbitrary `[:6]` cap in sanitizer.
- **Fix:** Remove the `[:6]` cap. The evidence_chunk_ids list can grow to the number of available chunks (set by `select_chunks` limit of 12). If needed, add a warning in UI when >6 chunks are referenced, but do not silently truncate.
- **Verification:** Reproduced (script). `python -c "from app.ingest.brief import _sanitize_brief; raw={'issues':[{'id':'iss_1','name':'X','question':'q','pro_label':'P','con_label':'C','evidence_chunk_ids':[f'c_{i}' for i in range(10)]}],'stakeholder_groups':[{'name':'G','stance_by_issue':{'iss_1':0.0}]}]; s=_sanitize_brief(raw); assert len(s['issues'][0]['evidence_chunk_ids'])==10"` → all 10 evidence chunk ids retained (no silent [:6] truncation). EXIT 0.

### D007: Wizard StepBrief save function — brief not auto-saved on navigation
- **File:** `frontend/src/Wizard.tsx:646-661`
- **Function:** `save()` called on `handleNext()` (line 686-688): `const success = await save(); if (success) onNext();`
- **Impact:** The `save()` API call writes the brief to the source document, but if the user navigates between wizard steps without explicitly clicking "Save scenario brief", or if they refresh the page, the brief is not persisted. The autosave (localStorage draft) does NOT include brief content (see D004). Two separate persistence mechanisms both miss the brief.
- **Root cause:** No auto-save of brief on every state change; save is explicit-button-dependent; autosave draft type omits brief.
- **Fix:** (See D004) Add brief to autosave draft. Also consider making `save()` called implicitly on every input change (debounced), or at minimum on every Next/Back navigation.
- **Verification:** Verified (code inspection). `frontend/src/Wizard.tsx:148-162` beforeunload handler persists brief+edit on every navigation/refresh; `handleNext` (lines 712-715) calls save() before onNext; autosave effect (lines 133-144) serializes brief+edit. Fix confirmed in place.

### D008: Engine agent stances_json schema may not match brief stance_by_issue
- **File:** `backend/app/sim/seeding.py:70` vs `WorldBrief.stakeholder_groups.stance_by_issue`
- **Impact:** The brief schema has `stance_by_issue: Record<string, number>` (flat float per issue). The seeding engine reads `group.get("stance_by_issue")` as flat floats (line 70). The agent `stances_json` stores `{"value": float, "confidence": 0.5}` per issue (clamp_persona in seeding.py line 171-198). This mismatch could cause stances to not persist correctly through the full pipeline brief → seed → DB → report.
- **Root cause:** Brief uses flat `{iss_N: float}` but agents store `{iss_N: {"value": float, "confidence": 0.5}}`. The seeding engine bridges this correctly via `template_persona` and `clamp_persona`, but if brief stance_by_issue format changes or is read differently, breakage could occur.
- **Fix:** Ensure consistent format. The current code appears consistent (brief has flat floats, seeding reads flat floats, clamps to {"value": ..., "confidence": 0.5}). Verify with tests. If no bug found, document the format contract.
- **Verification:** Verified (code + test). `backend/app/sim/seeding.py:70` `assign_targets` reads flat `stance_by_issue` floats matching the brief schema; `clamp_persona` (lines 171-198) stores `{"value": float, "confidence": 0.5}`. `test_seeding_creates_agents_and_edges` passes (stances keys == {"iss_1","iss_2"}, values in -1..1). Format contract consistent — no bug found.

### D009: _clamp_config in runs.py silently truncates agent/tick counts
- **File:** `backend/app/api/runs.py:28-44`
- **Function:** `_clamp_config(cfg)`
- **Impact:** `max(5, min(100, int(cfg.get("agents", 16) or 16)))` silently clamps agent count to [5, 100] and tick count to [1, 100]. If a user configures 200 agents or 200 ticks, they get silently truncated. Master prompt wants "create 1, 2, 5, 10, N issues and N stakeholder groups" — the clamp should either allow wider ranges or warn the user.
- **Root cause:** Hardcoded clamping bounds.
- **Fix:** Increase bounds (e.g., max 500 or remove upper bound entirely, min only) or add UI warning when config is truncated. At minimum, change to `max(1, int(...))` with no upper bound, or document the limits explicitly.
- **Verification:** Reproduced (script). `python -c "from app.api.runs import _clamp_config; c=_clamp_config({'agents':200,'ticks':200}); assert c['agents']==200 and c['ticks']==200"` → 200 agents/200 ticks accepted (1..500 bounds, no silent truncation to 100). EXIT 0.

### D010: No validation that configured issues/groups actually appear in run
- **File:** Various (brief → seed → run → report pipeline)
- **Impact:** The master prompt Requirement 1-4: "Every issue and group must survive: create → edit → add another → edit again → next → previous → reload → return later → launch → backend persistence → run creation → agent seeding → simulation → findings → report → export." There is no end-to-end test or code path that verifies every configured issue and stakeholder group makes it through the full pipeline to the report. Groups or issues could be silently dropped at any layer.
- **Root cause:** No cross-layer validation; each layer assumes the previous layer passed through all data.
- **Fix:** Add validation checks at key pipeline points: (a) after brief generation, verify issue and group counts match config; (b) after seeding, verify agent count and group distribution; (c) after run completion, verify report references all issues and groups. These can be backend tests or API endpoints.
- **Verification:** NOT FIXED. No cross-layer validation confirms every configured issue/group survives create→edit→launch→seed→report. No endpoint or test asserts issue/group counts match between brief, run config, seeding, and report. Slated for Phase 2 quality work — not a Phase 1 non-negotiable.

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

---
---

# Session 1 — Stabilization baseline

**Date:** 2026-10-23 · **Repo:** `C:\AI\OASIS_SIM` · **Branch:** `feat/the-social-world` · **HEAD at start:** `6eff51a`

## Task 1 — Baseline

- Orphan dev servers were running and holding the ports:
  - `:8000` held by PID 24720 (`python -m uvicorn app.main:app --host 127.0.0.1 --port 8000`), parent 27552 (same command, `.venv` python).
  - `:5173` held by PID 29212 (`vite.js`), parent chain 32672 ← 21872 (`npm run dev`) ← 29848 (`cmd /c start-e2e.bat`).
  - All four were stopped with `Stop-Process -Force`. After the kill both ports show only `TimeWait`, no `Listen`.
  - Note: the `@playwright/mcp` node processes and `laya.mcp.server` python processes were left alone — they belong to the agent tooling, not the app.
- Working tree at start (tracked): 4 modified files — `backend/app/config.py`, `docs/audit/DEFECT_LOG.md`, `frontend/package.json`, `frontend/src/Wizard.tsx`. The four diffs were reviewed before any edit and are prior-session work, not part of this sprint's fix.
- Untracked: `.claude/`, `FINAL_REPORT.md`, `backend/tests/test_pipeline_5i6g.py`, `docs/audit/SESSION_STATE.md`, `frontend/e2e/`, `frontend/playwright-report/`, `frontend/playwright.config.ts`, `frontend/test-results/`, `start-e2e.bat`.
- Baseline test state: backend `pytest -q` 98 passed; `npx tsc --noEmit` clean (recorded by the prior session; not re-run in this session).

## Task 2 — Line ending normalization

- **Root cause of the prior session's Edit failures (confirmed by measurement, not assumption):** working-copy files were CRLF while the read path presents LF, so a byte-exact `old_string` could never match. `file(1)` reported `frontend/src/Wizard.tsx` as "with CRLF line terminators"; the spec file was already LF, which is why only some tools failed.
- **Before:** 41 of 347 tracked files had CRLF working copies. Frontend `.ts`/`.tsx`: 17 of 28 (api.ts, ComparePage, DocumentsPage, HomePage, hooks, run/AgentsTab, run/AnalysisTab, run/EventsTab, run/helpers, run/LiveTab, run/NetworkTab, run/RunShell, SettingsPage, shell, SimulationsPage, types, Wizard).
- **Fix:** added `.gitattributes` — `* text=auto eol=lf`, `*.ts/*.tsx/*.py text eol=lf`, `*.bat/*.cmd text eol=crlf`, `*.db binary`. Working copies were converted CRLF→LF.
- **After:** 2 of 347 tracked files still have CRLF working copies — `dev.bat` and `start.bat`, which is intentional (`.bat`/`.cmd` are pinned to CRLF).
- **Stored blobs:** exactly **one** text file had a CRLF blob — `backend/app/llm/parsing.py` (144 lines). It was renormalized to LF. `git add --renormalize .` staged that file and nothing else on content grounds, so the change is line-endings only; no file's *content* changed beyond EOL.
- **Scope call:** the renormalization touched 1 file, well under the 20-file escalation threshold. The 39-file working-copy conversion produces no diff (the stored blobs were already LF), so it adds no churn to the commit.
- **Commit:** `5fb3631 chore: normalize line endings to LF`.
- **Note on diagnosis:** `sed`/`tr` from this shell silently round-trip CRLF (text-mode), so their "success" is a false positive. All EOL measurements in this entry were taken with Python reading bytes, and `git diff --cached --ignore-cr-at-eol` was used to prove a diff was EOL-only.

## Task 3 — Formatter / hook interference check

**Result: none found.**

- `.claude/` in the repo contains only `launch.json` (dev-server config). There is **no** `.claude/settings.json` and **no** `.claude/settings.local.json`, so no `PreToolUse`/`PostToolUse` hooks.
- `~/.claude/settings.json` exists but contains only `enabledPlugins` / `extraKnownMarketplaces`; no hooks.
- No `.husky/`, no `lint-staged`, no `.prettierrc*`, no `.prettierignore`, no `.editorconfig`, no root `package.json`, and no formatter scripts in `frontend/package.json`.
- No `.vscode/` directory in this repo, so no `editorconfig`/`formatOnSave` influence from workspace settings.

Nothing rewrites `.ts`/`.tsx`/`.py` on save, so the Edit failures were purely the CRLF mismatch, not a tool interfering mid-edit.

### D011: Wizard state does not survive page reload (Phase 1 acceptance criterion #3)

- **File:** `frontend/src/Wizard.tsx`
- **Impact:** Issues and groups added in the wizard are lost after a browser refresh. A user who builds a 5-issue / 6-group brief and reloads is returned to the originally generated brief. Silent data loss of user work.
- **Suspected chain (prior session, unproven):** `hydrate()` reads the localStorage draft → `setEdit(draft.edit)` → `setBrief(draft.brief)` → a `useEffect([brief])` fires → `setEdit(brief)` overwrites the restored edit. The prior attempted fix `useEffect(() => { if (!edit) setEdit(brief); }, [brief, edit])` did not make the test pass, so the chain is either incomplete or wrong. **Not accepted as the root cause until console-log evidence is captured (see Task 5).**
- **Status:** root-caused with console-log evidence, fixed, and verified — see below.

### D011 — Reproduction (before the fix, strict assertion restored)

Ran `npx playwright test phase1-dod.spec.ts --reporter=line --project=chromium-desktop` from `frontend/` with a cleared data dir. Failure:

```
Error: expect(received).toEqual(expected) // deep equality
- Expected  - 3
+ Received  + 0
  Array [ "iss_1", "iss_2" ]
-   "iss_3",
-   "iss_4",
-   "iss_5",
   > 114 |     expect(issAfter.sort()).toEqual(issBefore.sort());
```

`issAfter` = 2, `issBefore` = 5 — exactly the reported symptom.

### D011 — Root cause (console-log evidence, not a guess)

Instrumented every write to `brief`/`edit` in `Wizard.tsx` plus a `page.on('console')` bridge in the spec, then re-ran. Verbatim browser console, order preserved:

Add-issues phase, before the reload:
```
[SW] StepBrief.briefProp -> 2
[SW] StepBrief.syncEffect sees edit=null brief=2
[SW] top.brief -> 2
[SW] autosave -> {brief: 2, edit: null, step: 2}     <-- draft persisted with edit: null
[SW] StepBrief.edit -> 2
[SW] StepBrief.edit -> 3                              <-- user adds issue 3
[SW] StepBrief.edit -> 4
[SW] StepBrief.edit -> 5
```
After `page.reload()`:
```
[SW] hydrate draft -> {step: 2, briefIssues: 2, editIssues: null}
[SW] StepBrief.edit -> 2
[SW] StepBrief.syncEffect sees edit=2 brief=2
[SW] autosave -> {brief: 2, edit: null, step: 2}
```

**Which setter fires last, and with what:** the last write to `edit` is `StepBrief`'s own sync effect / `useState(brief)` initialiser, writing the **2-issue** brief. The Wizard's `[SW] top.edit ->` never fires with a non-null value during the add phase, and the final autosave is `{brief: 2, edit: null}`.

**Corrected root cause — the prior session's hypothesis was wrong.** `StepBrief` (Wizard.tsx:507) owned a *private* `edit` state seeded from the `brief` prop, and the Wizard's top-level `edit` (Wizard.tsx:46) was **never passed to it** (the render at Wizard.tsx:298-305 passes `brief`/`setBrief` only). Three consequences:

1. Every user edit landed in the child's private state, so the top-level `edit` — the only value the autosave effect depends on — stayed `null` forever, and the draft always persisted `edit: null`.
2. The child's edits were outside the autosave dependency graph entirely, so **adding an issue triggered no autosave at all** (no `[SW] autosave` line accompanies `StepBrief.edit -> 3/4/5`).
3. On reload, hydrate restored only `brief` (2 issues); `StepBrief` then re-seeded its private `edit` from that stale brief, discarding `iss_3..iss_5`.

It is **not** a `useEffect([brief])` clobbering a restored edit — there was no restored edit to clobber. That is why the prior `if (!edit) setEdit(brief)` guard changed nothing: `edit` was always null, so the guard always fired.

### D011 — Fix

Lift `edit` into the Wizard as the single source of truth and pass it to `StepBrief`:
- `StepBrief` receives `edit`/`setEdit` as props; its private `useState(brief)` and the `if (!edit) setEdit(brief)` sync effect are deleted.
- Every path that sets `brief` now sets `edit` in the same React batch (hydrate, `initialSource`, upload, choose-from-library, generate, `save()`).
- hydrate restores the working copy: `setEdit(draft.edit ?? draft.brief ?? null)`.
- hydrate's source fallback now also requires `!draft.edit`, so a restored edit can never be overwritten by the source's stored brief.

### D011 — Verification

Post-fix console evidence, same instrumentation, same command:
```
[SW] top.edit -> 3
[SW] autosave -> {brief: 2, edit: 3, step: 2}
[SW] top.edit -> 4
[SW] autosave -> {brief: 2, edit: 4, step: 2}
[SW] top.edit -> 5
[SW] autosave -> {brief: 2, edit: 5, step: 2}
...
[SW] hydrate draft -> {step: 2, briefIssues: 2, editIssues: 5}
[SW] top.edit -> 5
[SW] autosave -> {brief: 2, edit: 5, step: 2}
```

- Test: `Phase 1 DoD: Wizard Flow › complete 5-issue / 6-group / 16-agent pipeline`.
- Assertion: `phase1-dod.spec.ts:111 expect(issAfter.sort()).toEqual(issBefore.sort());` — **passes** (5 vs 5); previously failed 2 vs 5. The run now advances past the reload assertion. The reloaded UI also shows `Issues (5)` / `Stakeholder Groups (6)` (failure snapshot), and `hydrate draft` reports `editIssues: 5`.
- `npx tsc -p .` → clean. `pytest tests/test_pipeline_5i6g.py -q` → 2 passed.
- Instrumentation was removed after the evidence was captured; the final run was repeated on the committed artifact with no diagnostics and still advanced past the reload assertion.

**Note — the test had been weakened.** The reload assertion had been softened in a prior session to `issAfter.forEach(id => expect(issBefore).toContain(id))` (a subset check) with the same shape for groups. That weakening hid this bug: a 2-of-5 subset passed. It is reverted — the strict `toEqual` is restored at spec lines 111-112, with a comment forbidding reintroduction.

### D012: Phase 1 spec probes the step-1 nav button before the async upload settles

- **File:** `frontend/e2e/phase1-dod.spec.ts:33-46`
- **Decision: the TEST is wrong.**
- After `setInputFiles(...)` the spec immediately calls `draftButton.isVisible()`. `Nav` (Wizard.tsx:356-371) renders the primary button only when `onNext` is provided, and `StepSource` passes `onNext={source && meta?.usable ? onNext : undefined}` — so while upload/extraction is in flight the button **does not exist**. The probe returns false, the spec takes the "a brief already exists" branch, and waits 30s for a "Review the scenario" button that never appears. With a cleared data dir this is deterministic; the spec's own comment at line 31 assumes a source with a brief may already exist from a previous run, which is the only condition under which the branch it takes would ever resolve.
- **Fix applied** (before Task 5 — without it the D011 repro could not be obtained at all): wait for the button to exist before branching —
  `await expect(page.getByRole('button', { name: /(?:Draft|Review) the scenario/i })).toBeVisible({ timeout: 30000 });`
  No assertion was weakened; the fix makes the spec exercise the fresh-database path.

### D013: Phase 1 spec cannot complete Steps 4-5 — tab state and locator depth (NOT FIXED — hard stop)

- **File:** `frontend/e2e/phase1-dod.spec.ts:102,117,126,140`
- **Decision: the TEST is wrong; the PRODUCT is correct.** No product behaviour is at fault — a user on the Groups tab would simply click the Issues tab.
- **(a) Wrong tab.** Line 102 clicks "Stakeholder Groups" to count groups and never switches back. Issue rows render only on the Issues tab, so at line 117 the `span.t-id` holding `iss_1` does not exist. Confirmed from the failure snapshot, which reports `button "Stakeholder Groups (6)" [active]`.
- **(b) Wrong depth.** Line 117 goes `span.t-id` → `..` → `..`. In `IssueBuilder` the markup is row panel (`panel-2`) → header div → `flex items-center gap-2` → `span.t-id`; two levels up is the header div, which holds only the move/duplicate/remove buttons and **no `<input>`**. Reaching the panel that holds the Name input needs three levels (or a row-scoped locator). Line 126 repeats the mistake with a single `locator('..')`.
- **(c) Same tab problem at Step 5.** Line 140 reads group `span.t-id`s while the Issues tab is active (the reload resets `activeTab` to its `"issues"` default), so `namesFinal` would be empty and the strict `toEqual` on line 141 would fail. Not reached by the observed runs — this one is derived from the source, not executed.
- **Not fixed.** The run fails after the Task 5 fix for a reason other than reload persistence, which this sprint's brief marks as a hard stop ("stop and report — do not chase a new bug inside this session"). The decision is recorded here and the proposed patch is left for the operator to approve:

```ts
// Step 4 — return to the Issues tab, and scope the row by panel rather than by DOM depth
await page.getByRole('button', { name: /Issues \(\d+\)/ }).click();
const issueRow = page.locator('.panel-2').filter({
  has: page.locator('span.t-id', { hasText: firstIssueUuid }),
});
await issueRow.getByRole('textbox', { name: 'Name' }).fill('TEST_EDIT_' + Date.now());

// Step 4 assertion
const nameValue = await issueRow.getByRole('textbox', { name: 'Name' }).inputValue();

// Step 5 — count groups on the tab that renders them
await page.getByRole('button', { name: /Stakeholder Groups \(\d+\)/ }).click();
const namesFinal = await page.locator('span.t-id:has-text("Group")').allTextContents();
```