# Session state — The Social World / OASIS-Lite
Branch: feat/the-social-world · Repo: C:\AI\OASIS_SIM

## Completed
- Task 1: orphan dev servers killed (uvicorn :8000, vite :5173). Baseline recorded in DEFECT_LOG.md.
- Task 2: `.gitattributes` — commit `5fb3631`. Zero CRLF text blobs; every `frontend/**/*.ts,tsx` is LF;
  only the `.bat` files keep CRLF, by design.
- Task 3: no hooks, no formatter, no lint-staged/husky/prettier/editorconfig. Nothing rewrites files mid-edit.
- Task 4: weakened reload assertion reverted to strict `toEqual`; repro captured (2 vs 5).
- Task 5: D011 root-caused with console-log evidence and fixed — commit `4f49bfa`.
- D012-D015, D018 (spec defects, each decided "the TEST is wrong"): step-1 upload race; Groups tab left active
  plus wrong DOM depth; ambiguous agents-slider locator; 30s timeout shorter than the awaited run; and a group
  row's ordinal captured as though it were the group's name.
- D016 (PRODUCT bug, decided "the PRODUCT is wrong"): "Start run" never started the run — `Wizard.tsx` wrote
  `sessionStorage["oasis-autostart"]` while `RunShell.tsx` reads `tsw-autostart`. Fixed — commit `e67ee4e`.
- D017 (PRODUCT, operator chose the product change): the report now labels issues by their configured name
  (id retained) and carries a `## Stakeholder groups` section; findings gain an `issues` finding with the
  configured names, and the `groups` finding no longer drops a configured group that received no agents.
  No assertion was changed.
- Task 6 DONE: `npx playwright test phase1-dod.spec.ts --reporter=line` → **2 passed** (chromium-desktop and
  mobile-chrome), strict `toEqual` reload assertions, from a cleared data dir.
- Full backend suite: **98 passed**. No orphan listeners or uvicorn processes after any run.

## In progress
- Nothing.

## Next step (file:line)
- Commit the D017/D018 work and the doc updates (DEFECT_LOG.md, KNOWN_LIMITS.md, this file).

## Blockers
- None.

## Hypothesis
- The sprint's DoD is met. Remaining known gaps are the ones already deferred to Phase 2 in DEFECT_LOG
  (D005 compare-runs diffs, D010 cross-layer validation) and the E2E harness's `@playwright/test` dependency,
  which is declared in `package.json` but absent from the lockfile and `node_modules`.
