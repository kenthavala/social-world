# Finishing log — The Social World

Branch: `feat/the-social-world`. Rule: nothing is marked verified without the command and its real exit code.

## Baseline (start of this finishing pass)

```
git log --oneline -15
f5c4905 feat(compare): counted per-issue stance deltas and per-round mix (D005)
e1cfac1 feat: evidence library, stride through the wizard's pre-flight, and honest failure states
3154f3b docs: validation methodology, report structure and QA instructions
7a824d6 feat(shell): home route, 8-step wizard and product framing
1647562 feat(run): findings briefing, selectable network, agent filters and quality guidance

git status  (uncommitted, all intended)
 M docs/audit/DEFECT_LOG.md
 M frontend/e2e/m2-ui.spec.ts
 M frontend/e2e/phase1-dod.spec.ts
 M frontend/e2e/screenshots.spec.ts
 M frontend/src/Wizard.tsx
 M frontend/src/run/FindingsView.tsx
 M frontend/tools/bug_hunt.mjs
 M start-e2e.bat
?? frontend/e2e/wizard-counts.ts
?? tools/qa_bootstrap.py
```

Backend 143 passed / tsc clean / build clean / acceptance 86 of 86 were recorded before this
pass and are re-run in the final verification phase (not re-asserted here).

## A3 — the Playwright stall (root cause found and fixed)

Symptom: the suite sat for the whole 300s test timeout. `1 source, 0 runs` in the E2E DB.

Diagnosis (bounded run, `DEBUG=pw:api`, `--reporter=line`):

```
pw:api   element is not enabled
pw:api retrying click action +0ms
pw:api   waiting 500ms
... (repeats for 300000ms)
Test timeout of 300000ms exceeded.
EXIT_CODE=1
```

Page snapshot at failure: step 3 (`Issues`), `5 issue(s) defined`, and
`button "4 Stakeholders 3 group(s) defined" [disabled]`.

Root cause: the 8-step rail renders future steps with `disabled={s.n > step}` and only handles
backward jumps (`onClick={() => s.n < step && setStep(s.n)}`). The specs used rail anchors
(`/^4 Stakeholders/`, `/^5 Population/`) for FORWARD navigation, so the click waited forever for
an element that can never enable. E021 corrected the nav labels but left these forward rail jumps.

Fix (tests only, assertions unchanged): forward steps now click the nav button
(`Review stakeholders`, `Set up the population`); the rail is used only to go back. The reload
assertion in phase1-dod now expects the stage the draft actually restores (Stakeholders), then
returns to Issues via the rail.

Verified: pending the targeted rerun below.

## A3b — rail accessible names are unstable (test bug, E021 leftover)

Second stall, caught at phase1-dod line 104 after the reload:

```
Error: locator.click: Test timeout of 300000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: /^3 Issues/ })
```

Snapshot showed `button "✓ Issues done"` — the rail replaces a completed step's number with a
checkmark and its status text with "done", so every numeric anchor (/^3 Issues/) stops matching the
moment the step is finished. Fixed by `railStep(page, label)` in e2e/wizard-counts.ts, which scopes
to the rail container and matches the label (only one rail button carries each label). The
assertions are unchanged: the same rail navigation is still exercised.

Verified: `npx playwright test phase1-dod.spec.ts --project=chromium-desktop` -> 1 passed (14.0s),
EXIT_CODE=0.

## A3c — two m2-ui tests targeted UI that no longer exists (test bugs)

- "Log tab renders": RUN_TABS is Feed/Agents/Connections/Findings/Quality — there is no Log tab.
  LogTab now renders inside the Run details drawer (aria-label "Run details"). The test now opens
  that drawer and still asserts the LLM-calls heading and a non-empty table.
- "Inject events UI works": two causes. (1) selectors were stale (textarea placeholder, audience
  select, round input and button label all differ now). (2) more important, setupM2Run leaves a
  COMPLETED run, where canControl is false and "Record intervention" is correctly disabled, so the
  click could never succeed. The test now creates a DRAFT run from the same source via the API,
  opens it, schedules an intervention for everyone at round 1, and asserts the SCHEDULED row.

## Data honesty — sanitizer invented neutral positions (product bug)

`_sanitize_brief` filled a 0.0 stance for every issue a stakeholder group had not stated, so the
stored brief claimed a position nobody gave (and it silently defeated the E022 fix, which leaves new
issues unstated). Now only stated positions are recorded; seeding keeps its documented 0.0 default
at use time. The wizard's stance inputs show a blank ("—") for an unstated position instead of a
fabricated 0.0, and clearing a value removes the key.

Verified: `pytest tests -q -k "brief or stance or sanitiz"` -> 14 passed, EXIT_CODE=0.

## Findings — dead control (product bug)

`FindingsView` rendered `<div id="counted-detail" />` (empty) behind the
"Show the raw counts behind these findings" toggle since commit 1647562 — the button changed label
and revealed nothing. Now renders the counted tables (scale, stance by issue, stance by group,
provenance). Verified: pending rerun of UI checks.

## E022 — issue renumbering silently re-pointed group stances (product bug)

`removeIssue`/`duplicateIssue`/`moveIssue`/`addIssue` renumbered `iss_N` ids positionally without
remapping each group's `stance_by_issue`; `backend/app/sim/seeding.py:109` resolves group stances by
issue id. Deleting or reordering an issue therefore seeded groups on positions never recorded.
Fixed via one `commitIssues(next, fromIdx)` path that carries a stance by issue identity and leaves
new issues unstated. Verified: pending the wizard E2E, which deletes nothing yet — a dedicated check
is required (open item).

## A1 — the E2E data-dir clear is now hard-scoped (E020 hardening)

`start-e2e.bat` deletes `%TEMP%\oasis-e2e-data` recursively. Before this pass it did so unguarded: if
TEMP were unset the path collapsed to `\oasis-e2e-data`, and if the delete failed the launcher
carried on against stale data, re-creating E020 silently.

Now:
- the resolved path must equal exactly `<resolved TEMP>\oasis-e2e-data`, else it aborts (nothing deleted);
- `rd` is followed by an existence check; if the directory survives, it aborts with the likely cause
  (a process holding it) instead of running on stale state;
- a missing/uncreatable data dir aborts too.

Evidence (guard run through the same PowerShell line the bat uses):
`C:\Windows` -> "refusing to clear unexpected path: C:\Windows", exit 1.
empty -> "refusing to clear: TEMP or E2E_DATA is empty", exit 1.
`%TEMP%\..\oasis-e2e-data` -> "refusing to clear unexpected path: C:\Users\anand\AppData\Local\oasis-e2e-data", exit 1.
`%TEMP%\oasis-e2e-data` -> GUARD_ALLOWED, exit 0.
`%TEMP%\oasis-e2e-data\..\oasis-e2e-data` -> GUARD_ALLOWED (resolves to the expected path).

Abort branch, with a real blocker (a process whose CWD is the data dir):
`rd /s /q` -> "The process cannot access the file because it is being used by another process.",
exit 32, directory still present -> the launcher's `if exist` check fires and exits 1.

Honest limit: an *open SQLite connection does not block* the delete (SQLite opens with
FILE_SHARE_DELETE), so that specific case cannot be reproduced; the abort branch is proven with the
CWD case above, which is a genuine Windows lock.

## A3d — m2-ui tests 5 and 6 were stale as well (test bugs)

- "Model list free filter works": provider is a native `<select>` (option-clicking a closed select
  never resolves), the model field is a text input with a "List" button, and the filter is a counted
  checkbox. Rewritten to: select the provider, click List, and assert the option count equals the
  listed model count (+ the placeholder), the counted checkbox name, that checking the filter leaves
  exactly the free subset, and that an empty free set shows the explicit "no free models listed"
  state. The models endpoint is stubbed in the browser so the test does not depend on a live provider
  credential; the endpoint's own `free_only` derivation is asserted by the backend test
  `test_provider_models_derives_the_free_subset`.
- "Fallback provider switch works": there is no `switch` role and Settings is a link, not a button.
  Rewritten to change the real "Fallback provider" select, save, reload, and assert the value
  persisted, then restore the original value and assert that too.

## A3e — screenshots spec targeted the removed Log tab (test bug)

"Visual QA: Run page - Log tab" clicked a button matching /Log/; there is no Log tab (RUN_TABS =
Feed/Agents/Connections/Findings/Quality). It now opens the "Run details" drawer, asserts the LLM-calls
heading is inside it, and then takes the same three screenshots.

## A3f — mobile tab assertion and Settings navigation (test bugs)

- The run page renders TWO navigations: the desktop strip (`.run-tabs`, `display:none !important` at
  <=820px) and a mobile bottom bar (`nav[aria-label="Run sections"]`). The Agents test asserted
  `.tab.is-selected` - the hidden strip - so it failed only in the mobile project. It now asserts the
  selected button in whichever nav the viewport actually shows.
- The sidebar Settings link's accessible name is `Provider settings: <provider>`, and the primary nav's
  text label is CSS-hidden on mobile, so `getByRole('link', { name: 'Settings' })` matched nothing there
  and the Settings tests burned their full 600s. Both now navigate to `#/settings` directly (the page,
  not the link, is what those tests exercise).

Verified: `npx playwright test m2-ui.spec.ts --project=mobile-chrome` -> 6 passed (29.7s).

## A3g — the integrity spec reused a de-duplicated source (test bug)

`wizard-integrity` uploaded `e2e/fixtures/sample_source.txt` and expected exactly one new source. The
upload endpoint de-duplicates by sha256, so the fixture (already uploaded by earlier tests) returned the
existing source and the poll saw 0 new ids (`Expected: 1, Received: 0`, 30s). It now uploads unique
bytes via `setInputFiles({ name, mimeType, buffer })`, so the source it owns is unambiguous.

Verified: `npx playwright test wizard-integrity.spec.ts --project=chromium-desktop` -> 1 passed (11.5s).


## E029/E030 — the key warning and a double-full-stop (product bugs)

`GET /api/sources` returns `id`; `GET /api/sources/{id}` returns `source_id`. HomePage keyed the
document list with `key={d.source_id}`, which is `undefined` for every list row, so React warned
"Each child in a list should have a unique key prop" on every viewport. Fixed by declaring the
optional `id` on `SourceStats` and keying with `d.id ?? d.source_id` (the pattern DocumentsPage and
Wizard already used). The Findings provenance line also ended in two full stops because the method
string and the sentence both already ended with one; fixed.

Evidence:
- console capture across `#/`, `#/simulations`, `#/documents`, `#/new`, `#/settings`, `#/run/...`:
  key warning present before, absent after (exit 0);
- visual QA (50 screenshots, 1920/1440/1280/768/390): before = 5 problems (one per viewport, all the
  key warning); after = "No problems detected";
- bug hunt: 22 passed, 0 failed, exit 0;
- counted detail (E025) headless check: visible, 13 table rows, Scale + Stance by issue + Stance by
  stakeholder group + provenance, 0 console errors;
- Findings accuracy line: "not validated — no accuracy figure is claimed for this run.", raw
  `not_validated` absent, no double stops.

## Visual QA — what was actually looked at

50 screenshots at five widths for home, simulations, documents, settings, wizard and the five run
tabs, plus 51 files total in the output dir. I viewed 1920 home, 1440 findings, 1440 quality, 390
home, 390 run-agents, 768 run-connections, 1440 wizard and 1280 documents directly:
- home: honest "what it does / what it does not claim" panel, provider status, recent run, documents,
  activity; no clipping;
- findings: "Computed, not generated" badge, executive findings, no accuracy figure;
- quality: "Configuration quality - NOT predictive accuracy", 91/100 with the dimension list and
  "Predictive accuracy: Not validated";
- mobile home/run: mock banner, no horizontal overflow, bottom run nav with Back;
- 768 connections: group counts (6 groups) and 24 agents, list mode, no overflow;
- wizard: 8-step rail with real state labels, library shows the stored source as Ready;
- documents: evidence library, per-tab counts (5 issues / 6 stakeholders / 6 findings / 2 passages),
  100% citation coverage, the run that used it.

## Real provider test (E2) — blocked by the credential, not by the code

`POST /api/providers/test` against the running backend (QA stack, mock selected, real keys from .env):
- `{"provider":"nvidia_nim","model":"z-ai/glm-5.3-flash"}` -> HTTP 200, `auth_ok:false`,
  `model_ok:true`, `json_ok:false`, `latency_ms:null`, 878 ms round trip,
  error `401 from nvidia_nim: {"status":401,"title":"Unauthorized","detail":"Invalid JWT
  serialization: Missing dot delimiter(s)"}`;
- `{"provider":"opencode_zen"}` -> HTTP 200, `auth_ok:false`, `model_ok:false`, `json_ok:false`,
  3313 ms, error `400 ... Upstream request failed: Model is unavailable.`;
- `{"provider":"mock"}` -> HTTP 200, `auth_ok:true`, `model_ok:true`, `json_ok:true`, 34 ms.

Cause: the configured `NVIDIA_API_KEY` is 64 characters with zero dot delimiters and does not carry
the provider's expected prefix, i.e. it is not a valid NVIDIA JWT. NVIDIA's `GET /v1/models` still
answers 200 (model listing is not gated the same way), which is why `model_ok` is true while the chat
call is 401. No real-provider generation is claimed.

## Scale (measured, mock provider, 10 ticks)

| agents | seed s | tick avg s | tick max s | edges | stance rows | analytics s | db growth MB | peak MB |
|---|---|---|---|---|---|---|---|---|
| 24 | 0.21 | 0.086 | 0.122 | 298 | 1200 | 0.708 | 0.72 | 2.0 |
| 100 | 0.93 | 0.256 | 0.353 | 1605 | 5000 | 0.229 | 1.42 | 2.1 |
| 500 | 24.70 | 1.136 | 1.415 | 9196 | 25000 | 1.172 | 5.02 | 9.3 |

Note: posts stay at 40 by configuration (`writes_per_tick` x `write_batch`), so this measures engine,
graph and stance cost, not feed volume.

## Acceptance harness and build

- `python tools/e2e_acceptance.py` -> 86 passed, 0 failed, exit 0 (own temp data dir, TestClient).
- `npm run build` -> built in 5.80s, exit 0.

## E032 — a flaky, ambiguous "Connections" click in the screenshot spec

The 20:30:44 full run failed exactly one test, `mobile-chrome` "Visual QA: Run page - Network tab",
with `strict mode violation: getByRole('button', { name: /Connections/ }) resolved to 2 elements`.
The test navigates at the mobile viewport, resizes to 1440x900, and clicks immediately; the mobile
bottom bar is unmounted by a React resize listener, so for one tick both "Run views" (desktop tabs)
and "Run sections" (mobile bar) expose a button named "Connections". The click is now scoped to
`navigation "Run views"`. Evidence: the spec alone on `mobile-chrome` -> 9 passed (29.8s), exit 0;
the failing test repeated five times on `mobile-chrome` (`--repeat-each=5 -g "Network tab"`) ->
5 passed (34.6s), exit 0.

## Accessibility — what the harness actually checks (and what it does not)

`frontend/tools/visual_qa.mjs` is a measured audit, not a screenshot walk. Per viewport (1920, 1440,
1280, 768, 390) and per screen (home, simulations, documents, wizard, settings, run feed/agents/
connections/findings/quality) it checks:
- horizontal overflow greater than 2px, with the offending elements named;
- pages whose visible text is shorter than 40 characters ("looks empty");
- every visible `button`, `a[href]`, `input`, `select`, `textarea` has an accessible name (aria-label,
  label element, wrapping label, title, text or alt), skipping `aria-hidden` subtrees;
- the nine `--fg-*`/`--bg-*` design-token contrast ratios, flagging any below 4.5:1;
- keyboard: eight Tab presses from the top of the run page, flagging any focused element with no
  visible outline and no box shadow;
- console errors and page errors, recorded per viewport.

Result: 50 screenshots, "No problems detected", exit 0 - i.e. zero overflow, zero unlabelled controls,
zero sub-4.5:1 text tokens, zero invisible focus stops and zero console errors across all five widths.

Not covered (so not claimed): axe-core/WCAG rule coverage, screen-reader output, colour-blind
simulation, motion/prefers-reduced-motion, and contrast of non-token colours or of text over images.

## Report quality review (current code, QA run `run_b67bbeb258`)

Regenerated with `generate_report("run_b67bbeb258")` against the QA data dir after the E031 fix
(`OASIS_DATA_DIR=%TEMP%\tsw-qa-data-1`), then read as text:
- 25,654 characters, 42 headings, 91 table rows;
- sections present: Executive summary, Scenario, Methodology, Stakeholder landscape, Issue landscape,
  Findings (4), Issue analysis (all 5 issues by name), Stakeholder analysis (all 6 groups by name),
  Network dynamics, Evidence, Changes over time, Outliers, Uncertainty, Validation, **Quality
  assessment**, Limitations, Implications, Appendix;
- 0 missing issue/group names out of 5 + 6;
- provider row: `` | **Provider** | `mock` / not used by mock | `` - no model name anywhere in the text;
- no accuracy percentage anywhere; "not validated" present; the quality section is explicitly titled
  as configuration quality ("This section describes the quality of the simulation configuration and of
  its recorded data. It is not predictive accuracy.");
- the 91/100 score in the report equals `compute_realism()`'s overall score for the same run, and all
  14 assessed dimension labels appear (23 dimensions total: 14 assessed, 7 not assessed, 2 not
  connected).

## Final gates (all run against the committed tree, 24 Oct 2026)

| Gate | Command | Result | Exit |
|---|---|---|---|
| Backend suite | `python -m pytest tests -q` (from `backend/`) | 146 passed, 3 warnings in 109.65s | 0 |
| Type check | `npx tsc --noEmit` (from `frontend/`) | no output | 0 |
| Production build | `npm run build` (from `frontend/`) | built in 5.41s | 0 |
| Playwright (both projects) | `npx playwright test --reporter=list,json` | 34 passed (1.7m), expected=34 unexpected=0 flaky=0 skipped=0 | 0 |
| Screenshot spec (mobile) | `npx playwright test screenshots.spec.ts --project=mobile-chrome` | 9 passed (29.8s) | 0 |
| Flake probe | `... --repeat-each=5 -g "Network tab"` (mobile) | 5 passed (34.6s) | 0 |
| Visual + accessibility QA | `node tools/visual_qa.mjs <base> run_b67bbeb258` | 50 screenshots, "No problems detected" | 0 |
| Bug hunt | `node tools/bug_hunt.mjs <base> run_b67bbeb258` | 22 passed, 0 failed | 0 |
| Acceptance harness | `python tools/e2e_acceptance.py` | 86 passed, 0 failed | 0 |
| Scale (mock, 10 ticks) | `python tools/scale_test.py 24 100 500` | see table above | 0 |
