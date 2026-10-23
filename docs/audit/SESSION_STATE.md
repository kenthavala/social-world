# Session state — The Social World / OASIS-Lite
Branch: feat/the-social-world · Repo: C:\AI\OASIS_SIM

## Completed
- Task 1: orphan dev servers killed (uvicorn :8000, vite :5173). Ports free. Baseline recorded in DEFECT_LOG.md.
- Task 2: `.gitattributes` added — commit `5fb3631 chore: normalize line endings to LF`. Zero CRLF text blobs;
  every `frontend/**/*.ts,tsx` is LF; only `dev.bat`/`start.bat`/`start-e2e.bat` keep CRLF, by design.
- Task 3: no hooks, no formatter, no lint-staged/husky/prettier/editorconfig. Nothing rewrites files mid-edit.
- Task 4: weakened reload assertion reverted to strict `toEqual` (spec line 111); repro captured (2 vs 5).
- Task 5: D011 root-caused with console-log evidence and fixed — commit `4f49bfa fix(wizard): persist
  edited issues/groups across reload`.
- D012-D015 (spec defects, all decided "the TEST is wrong"): step-1 upload race; Groups tab left active plus
  wrong DOM depth in Step 4/5; ambiguous agents-slider locator; 30s test timeout shorter than the awaited run.
  No assertion was weakened — the reload assertions are strict `toEqual`.
- D016 (PRODUCT bug, decided "the PRODUCT is wrong"): "Start run" never started the run —
  `Wizard.tsx` wrote `sessionStorage["oasis-autostart"]` while `RunShell.tsx` reads `tsw-autostart`, so the
  auto-start branch was dead and every run stayed in `draft`. Fixed by matching the reader's key.
- Task 6 progress: the E2E now passes Steps 1-9 legitimately from a cleared data dir — the run completes in
  17.7s (5 issues, 6 groups, 16 agents, report generated, `iss_1`'s edited name present in the run's brief).
- No orphan listeners or uvicorn processes remain after any run.

## In progress
- Nothing. Stopped for the D017 decision.

## Next step (file:line)
- D017 — `backend/app/analytics/report.py:416-418` and `frontend/e2e/phase1-dod.spec.ts:204,216`: the report
  labels issues by internal id and never mentions stakeholder groups; the spec asserts names in both the
  report and findings.

## Blockers
- Awaiting the operator's choice on D017 (change the product's report vs change the spec's probes).

## Hypothesis
- All remaining red is Steps 10-11 only; every earlier step passes on the committed artifact.
