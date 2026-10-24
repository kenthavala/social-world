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

## Phase 2 - the second finishing pass (24 Oct 2026)

Rules unchanged: no claim without the command and its real output; no push; nothing
real-provider is claimed while the credential is invalid.

### E033 - the E2E suite could silently run against a REAL provider (found and fixed)

Symptom: `frontend/e2e/navigation-integrity.spec.ts` and `run-recovery.spec.ts` started
failing with `Expected: "completed" / Received: "paused"`, and a run sat at
`paused` after 1 tick with `llm_calls_used: 0` and `error: null`.

Diagnosis (read from the running stack, nothing guessed):

```
GET /api/health                      -> {"provider":"nvidia_nim"}   (expected "mock")
%TEMP%\oasis-e2e-data\settings.json  -> {"llm_provider":"nvidia_nim",
                                          "llm_model":"nvidia/nemotron-3-ultra-550b-a55b", ...}
GET /api/runs/<id>/stats             -> {"calls":11,"by_status":{"error":11},
                                          "models":{"nvidia/nemotron-3-ultra-550b-a55b":11}}
```

`app/config.py` resolves settings as "data/settings.json wins over env" (`_pref`), so a
provider saved into the E2E data dir by an earlier manual session outranked the
`LLM_PROVIDER=mock` that `start-e2e.bat` and `playwright.config.ts` set. The suite was
therefore calling a real endpoint with an invalid key: every persona/write call 401'd.

Two defects came out of this, both fixed:

1. `start-e2e.bat` now pins the provider for the run data dir before starting the backend:

   ```bat
   powershell -NoProfile -Command "$q=[char]34; $p=Join-Path $env:OASIS_DATA_DIR 'settings.json'; [IO.File]::WriteAllText($p, '{'+$q+'llm_provider'+$q+':'+$q+'mock'+$q+'}')"
   if errorlevel 1 ( echo [start-e2e] ABORT: could not pin the provider to mock... & exit /b 1 )
   ```

   (`WriteAllText` = UTF-8 without BOM; a BOM would make `json.loads` throw and silently
   fall back to env.) Verified after restart: `/api/health` -> `{"provider":"mock"}`,
   `settings.json` -> `{"llm_provider":"mock"}`, and the two specs pass.

2. The engine paused on repeated write failures with **no reason at all**:
   `ctx.pause_self()` wrote `status='paused'` and an SSE event but left `error_json` NULL,
   so the room showed a healthy-looking run that had simply stopped. It now pauses through
   `_pause_with_reason()` with the count, the underlying error and a hint:

   ```
   message: "3 of the last 3 write calls failed. Last error: RuntimeError: connection reset by provider."
   hint:    "Check the provider and its key in Settings, then Resume. Completed rounds are
             kept and agents that could not be written are recorded as template reposts."
   ```

   The write path also records `ctx.last_write_error`, and a `BudgetExhausted` no longer
   counts as a write failure (it has its own pause path).

   Test: `backend/tests/test_failure_states.py::test_repeated_write_failures_pause_with_the_reason`
   (raises from `_write_batch_call`, asserts paused + message + hint + kept agents/posts,
   then clears the fault, resumes and reaches `completed`). `test_failure_states.py` ->
   **19 passed** (was 18).

### Item 1 (frontend half) - reload during an active run

`frontend/e2e/run-recovery.spec.ts` (new, both projects): create a 30-agent/300-round run
*not* started, open the run room, select **Agents**, click **Start**, wait until the API
reports posts, then `page.reload()` mid-run and assert: the same run id renders, the Agents
view is restored (sessionStorage), `.banner-err` count is 0, the header follows the run to
`Completed`, the header **Posts** stat equals the API's stored post total, and every
`article[data-post-id]` is unique. `data-post-id` was added to the post card for that check.
Result: `chromium-desktop` + `mobile-chrome` -> 2 passed.

The shared fixture `frontend/e2e/run-fixture.ts` now holds `SOURCE_TEXT`, `BRIEF`,
`createSource`, `waitForRun`, `createRun`, `createCompletedRun`, `runNav`, `openTab`;
`navigation-integrity.spec.ts` was refactored onto it (no duplicated fixture code).
`navigation-integrity.spec.ts` + `run-recovery.spec.ts` together: 8 tests, 1 skipped
(the 390px contract runs once, on `mobile-chrome`), 7 passed.

### Item 6 - accessibility, measured

- The duplicate run navigation is gone. The desktop `nav[aria-label="Run views"]` is rendered
  only when `!isMobile` and the `.run-tabs { display: none }` rule was removed from the CSS,
  so exactly one run navigation exists in the tree per viewport.
- `@axe-core/playwright` 4.14.0 added (`frontend/package.json`) and
  `frontend/e2e/accessibility.spec.ts` (new) audits all ten screens in both projects:
  home, wizard, sources, settings, feed, agents, connections, findings, quality, compare.
  The gate is explicit: **no `serious` or `critical` violations**; the exact per-screen
  violation lists are attached to every test as annotations, so nothing is hidden.
- Fixes made for real violations found by axe:
  - `label-content-name-mismatch`: wordmark text wrapped in a real `.wm-text` span
    (the accessible name now contains the visible text); the sidebar theme button is
    `Toggle colour theme - Dark mode|Light mode`; post avatars include their initials;
    the passage button uses `title` instead of an `aria-label` that omitted the visible
    page text; compare round buttons are labelled `Round 01:` (zero-padded, as displayed).
  - `color-contrast`: `stanceTextColor()` (`--pro-fg`/`--con-fg`/`--fg-2`) replaces raw
    canvas hexes for every stance number, and the moderate-strength badge uses `--accent-fg`.
  - `scrollable-region-focusable` (serious): every `overflow-x-auto` region is now a
    keyboard stop with a name (`tabIndex={0} role="group" aria-label="... -- scrollable ..."`)
    in HomePage, SimulationsPage, ComparePage (4), LogTab and NetworkTab.
  - `landmark-one-main` + `region` (moderate): the route content is now a single `<main>`
    in `App.tsx` (HomePage's own `<main>` was removed to avoid a duplicate), and the
    provider/server banners plus the mobile "New simulation" FAB are wrapped in named
    `role="region"` landmarks.
  - `landmark-unique` / `landmark-no-duplicate-banner` (moderate): the shell sidebar is
    `aria-label="Sections"` and the documents list panel is `aria-label="Document list"`.
  - `page-has-heading-one` (moderate): the wizard's page title is now an `<h1 class="eyebrow">`.
  - `link-in-text-block`: `.kbd-link` is underlined, not colour-only.
- Final measurement (`node axe-probe.mjs`, ten screens x 1440x900 and 390x844, axe default
  rule set): **0 violations of any impact on all 20 screen/viewport pairs**
  (before this pass: home 3, wizard 5, sources 5, settings 4, run tabs 2 each).
- What this is not: axe covers a subset of the success criteria and cannot judge screen-reader
  output, reading order or colour-blind readability. The claim is "0 axe violations in the
  default rule set", not "WCAG compliant".

### Item 3 - the wizard fixture was conditional (found by the full suite, fixed)

Full-suite run: `wizard-editing.spec.ts >> duplicate, reorder and edit keep ids positional
and positions attached` failed on **both** projects with
`Members of the public has no position on New Issue`.

The cause is not the wizard: `normaliseIssues()` adds issues the provider did not draft
(the new row defaults to "New Issue"), and a blank stance is deliberately stored as an
*absent* key rather than a fabricated 0. So the fixture's precondition
("every group has a position on every issue") only held when the mock brief happened to
draft enough issues with positions - a vacuous, data-dependent setup.

Fix (test only, assertions unchanged and now non-vacuous): `seedPositions(page, issues, groups)`
fills every `(iss_N)` stance input with a distinct non-zero value before the brief is saved,
so all 9 pairs are explicitly recorded. `wizard-editing.spec.ts` -> **6 passed** (3 tests x
2 projects, 12.9s), and the "position follows its own issue" comparisons now run against
values the test itself set.

### Item 7 - comparison discoverability

Ticking a second agent in the Connections list used to jump straight to the comparison view
and tick boxes were hard to reach at 390px. `pick()` now keeps the list visible while ticking
and the list shows an explicit **Compare N selected** button; the comparison table renders
only while the selection is an agent, so choosing a group always shows the group panel (an
explicit group/edge selection wins over a stale comparison). The new specs cover agent
comparison, the group detail panel, the 390px entity list, and the
finding -> passage -> finding round trip. On the backend, `narrative.py` gained
`_evidence_for_posts()` so the `evidence_use` finding carries the most-cited passages
(`evidence` + `post_ids`), which is what makes document -> chunk -> evidence -> finding
navigable in every run with citations. `test_report_factuality.py` + `test_data_matrix.py`
-> 15 passed.


### E034 - the scale harness was measuring tracemalloc, not seeding

Pass 1 of the gate sweep reported `seed_s = 7.11 s` at 500 agents (and the phase-1 table
in this log says 24.70 s). A profile of the same seeding run, without the tracer, measured
2.19 s, and the graph step alone 0.47 s. Cause: `tools/scale_test.py` called
`tracemalloc.start()` *before* `seed_run`, and tracemalloc's per-allocation overhead is
proportional to the number of Python calls, which is exactly what seeding is made of. The
old numbers were mostly the instrument.

Fix: seeding is now timed with tracing off; `peakMB` is traced across the tick loop (where
the population-held state actually grows), and the header says so. Corrected measurement,
10 rounds, mock provider, default volume (`writes/tick` 4):

| agents | seed s | tick avg s | tick max s | posts | edges | analytics s | db growth MB | peak MB |
|---|---|---|---|---|---|---|---|---|
| 24 | 0.05 | 0.063 | 0.102 | 40 | 298 | 0.337 | 0.73 | 0.3 |
| 100 | 0.05 | 0.192 | 0.240 | 40 | 1560 | 0.206 | 1.43 | 0.8 |
| 500 | 0.71 | 1.008 | 1.233 | 40 | 9588 | 1.167 | 5.05 | 3.5 |

Realistic post volume (`SCALE_WRITES_PER_TICK=50`, ~500 posts):

| agents | seed s | tick avg s | tick max s | posts | edges | analytics s | db growth MB | peak MB |
|---|---|---|---|---|---|---|---|---|
| 100 | 0.10 | 0.745 | 1.065 | 458 | 1073 | 0.524 | 4.28 | 1.4 |
| 500 | 0.74 | 2.666 | 3.457 | 500 | 9186 | 1.236 | 9.22 | 4.7 |

The remaining growth at 500 agents is the similarity graph itself (0.47 s of the 0.71 s
seed), which is inherently O(n^2): every agent compares its stances with every other agent.
The cubic term is gone. Graph step, measured with the pre-fix module extracted from
`b1ae311` and the identical population and seed:

| agents | pre-fix | fixed | speedup | same edge set + weights |
|---|---|---|---|---|
| 100 | 0.115 s | 0.021 s | 5.6x | yes |
| 500 | 7.827 s | 0.474 s | 16.5x | yes |

### E035 - a flaky string comparison in the report-factuality test (found by running the gates twice)

Pass B failed exactly one test:
`test_report_factuality.py::test_headline_numbers_match_independent_recomputation`,
`assert '-0.00' == '+0.00'`. That is the whole point of running the gates twice.

Two independent causes, both in the test, both fixed without weakening it:

1. `sum(vals) / len(vals)` in the test vs `round(statistics.mean(vals), 3)` in the
   renderer. `statistics.mean` sums floats exactly (Fraction arithmetic); `sum/len` does
   not, so the last bits differ and can cross a 3-dp boundary. The test now uses
   `statistics.mean`.
2. The renderer's per-group change is `round(mean(f - i for paired values), 3)`, not the
   difference of the two rounded means. The two agree in exact arithmetic but differ by up
   to 0.001 after rounding, which is the difference between printing `+0.00` and `-0.00`.
   The test now reproduces the renderer's definition exactly (same per-issue loop, same
   independent filtering of missing values, same pairing) and *also* asserts that the two
   definitions agree within the printed precision, so a wrong sign or a misplaced value
   still fails.

Re-run: the single test 10x and the file 6x -> 0 failures (the fixture's run ids are random,
so each run exercises different mock text).


## Final gates - twice, end to end, on the frozen tree (25 Oct 2026)

The code tree was frozen before both passes (items 1-9 complete); only this log was written
afterwards. Earlier in this phase the same script was run twice as well (pass 1 before the
measurement fix, and passes A/B, where B caught E035); the two passes recorded here are the
ones that correspond to the committed tree.

| Gate | Command | Pass C | Pass D |
|---|---|---|---|
| Backend suite | `python -m pytest tests -q` | 188 passed, 3 warnings in 146.4 s, exit 0 | 188 passed, 3 warnings in 146.4 s, exit 0 |
| Type check | `npx tsc --noEmit` | no output, exit 0 | no output, exit 0 |
| Production build | `npm run build` | exit 0 | exit 0 |
| Playwright (both projects) | `npx playwright test --reporter=line` | 67 passed, 1 skipped (3.2 m), exit 0 | 67 passed, 1 skipped (3.1 m), exit 0 |
| Acceptance harness | `python tools/e2e_acceptance.py` | 86 passed, 0 failed, exit 0 | 86 passed, 0 failed, exit 0 |
| Scale, default volume | `python tools/scale_test.py 24 100 500` | exit 0, 24/100/500 seed 0.05/0.06/0.72 s | exit 0, seed 0.06/0.05/0.71 s |
| Scale, realistic volume | `SCALE_WRITES_PER_TICK=50 python tools/scale_test.py 100 500` | exit 0, 458/500 posts | exit 0, 458/500 posts |
| Visual + accessibility QA | `node tools/visual_qa.mjs <base> <run>` | 50 screenshots, "No problems detected", exit 0 | idem, exit 0 |
| Bug hunt | `node tools/bug_hunt.mjs <base> <run>` | 22 passed, 0 failed, exit 0 | 22 passed, 0 failed, exit 0 |
| axe sweep | `node axe-probe.mjs` (10 screens x 2 viewports) | 0 violations of any impact | 0 violations of any impact |

The single skipped Playwright test is the 390px entity-list contract, which is skipped on
the desktop project by design and runs on `mobile-chrome`.

Playwright's 67 + 1 skipped = 68 = 34 tests x 2 projects (m2-ui, phase1-dod, screenshots,
wizard-integrity, wizard-editing, navigation-integrity, run-recovery, accessibility).


