/**
 * Wizard editing integrity (item 3).
 *
 * The wizard's brief is the operator's own data. These tests prove that the three
 * editing operations that rewrite issue ids — duplicate, reorder and edit — keep:
 *   - ids positional and contiguous (iss_1..iss_N),
 *   - every group's recorded position attached to its own issue (by name),
 *   - a duplicated issue free of inherited positions (no fabricated 0.0),
 * and that a refresh restores unsaved edits from the autosaved draft, while a
 * failed save is shown without reverting what the operator typed.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { normaliseGroups, normaliseIssues, railStep } from './wizard-counts';

test.describe.configure({ retries: 0, timeout: 240000 });

type Brief = {
  issues: { id: string; name: string }[];
  stakeholder_groups: { name: string; stance_by_issue: Record<string, number> }[];
};

async function sourceIds(request: APIRequestContext): Promise<string[]> {
  const list = await (await request.get('/api/sources')).json();
  return (list.sources ?? []).map((s: any) => s.source_id ?? s.id);
}

async function savedBrief(request: APIRequestContext, sourceId: string): Promise<Brief> {
  const detail = await (await request.get(`/api/sources/${sourceId}`)).json();
  const brief = detail.brief ?? detail;
  expect(brief?.issues?.length, 'source has no saved brief').toBeGreaterThan(0);
  return brief as Brief;
}

/** group name -> { issue name -> stance } for the issues present in `brief`. */
function byName(brief: Brief): Record<string, Record<string, number>> {
  const issueName = new Map(brief.issues.map((i) => [i.id, i.name]));
  const out: Record<string, Record<string, number>> = {};
  for (const g of brief.stakeholder_groups) {
    out[g.name] = {};
    for (const [issueId, value] of Object.entries(g.stance_by_issue ?? {})) {
      const name = issueName.get(issueId);
      if (name) out[g.name][name] = value;
    }
  }
  return out;
}

function issueRow(page: Page, id: string) {
  return page.locator(`div.panel-2:has(span.t-id:text-is("${id}"))`);
}

function issueNameInput(page: Page, id: string) {
  return issueRow(page, id).locator('label.field').filter({ hasText: 'Name' }).locator('input');
}

async function issueIds(page: Page): Promise<string[]> {
  return page.locator('span.t-id:text-matches("^iss_")').allTextContents();
}

async function issueNames(page: Page): Promise<string[]> {
  const rows = page.locator('div.panel-2:has(span.t-id:text-matches("^iss_"))');
  const n = await rows.count();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(await rows.nth(i).locator('label.field').filter({ hasText: 'Name' }).locator('input').inputValue());
  }
  return out;
}

/**
 * Give every (group, issue) pair a recorded position.
 *
 * A blank stance input means "no stated position" and is deliberately saved as an
 * absent key rather than a fabricated 0, so a generated brief may legitimately
 * have groups with no position on an issue the operator added afterwards. The
 * fixture that proves positions survive duplicate/reorder/edit must therefore
 * state them explicitly instead of relying on what the provider happened to draft.
 * The inputs are the only labelled "… (iss_N)" fields on the step, in group order.
 */
async function seedPositions(page: Page, issues: number, groups: number): Promise<void> {
  const fields = page.getByLabel(/\(iss_\d+\)$/);
  await expect(fields).toHaveCount(issues * groups);
  for (let g = 0; g < groups; g++) {
    for (let i = 0; i < issues; i++) {
      // Distinct, non-zero values so a lost or swapped position is visible.
      const value = (((g + 1) * 3 + i + 1) % 7) / 10 + 0.1;
      await fields.nth(g * issues + i).fill(value.toFixed(1));
    }
  }
}

/**
 * Upload a unique document, draft the brief with the mock provider and normalise
 * it to `issues` issues and `groups` groups. Returns the id of the source this
 * test owns (identified as the one that did not exist before the upload).
 */
async function setUpBrief(
  page: Page, request: APIRequestContext, issues = 3, groups = 3,
): Promise<string> {
  const known = new Set(await sourceIds(request));
  await page.goto('/#/new');
  await page.waitForLoadState('domcontentloaded');

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: 'attached' });
  const unique = `Wizard edit ${Date.now()} ${Math.random().toString(36).slice(2)}`;
  await fileInput.setInputFiles({
    name: `wizard-edit-${Date.now()}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(
      `${unique}. Transport policy is contested. Supporters say the charge cuts emissions ` +
      'and funds buses. Opponents say it raises costs for households and small shops. ' +
      'Residents near the centre are divided; commuters are more supportive; trade bodies ' +
      'want exemptions; the council must decide before the budget review. '.repeat(20),
    ),
  });

  let sourceId = '';
  await expect.poll(async () => {
    const fresh = (await sourceIds(request)).filter((id) => !known.has(id));
    if (fresh.length === 1) sourceId = fresh[0];
    return fresh.length;
  }, { timeout: 30000 }).toBe(1);

  const draftNav = page.getByRole('button', { name: 'Draft the scenario', exact: true });
  const reviewNav = page.getByRole('button', { name: 'Review the scenario', exact: true });
  await expect(draftNav.or(reviewNav)).toBeVisible({ timeout: 30000 });
  if (await draftNav.isVisible()) {
    await draftNav.click();
    await page.locator('textarea').first().fill('How will residents respond to the new policy?');
    await page.getByRole('button', { name: 'Draft the brief', exact: true }).click();
  } else {
    await reviewNav.click();
  }
  await expect(page.getByText(/issue\(s\) defined/)).toBeVisible({ timeout: 60000 });
  await page.getByRole('button', { name: 'Review issues', exact: true }).click();

  await normaliseIssues(page, issues);
  await page.getByRole('button', { name: 'Review stakeholders', exact: true }).click();
  await normaliseGroups(page, groups);
  await seedPositions(page, issues, groups);
  // Step forward so the groups (and their positions) are stored, then return.
  await page.getByRole('button', { name: 'Set up the population', exact: true }).click();
  await railStep(page, 'Issues').click();
  await expect(page.getByText(`Issues — ${issues}`)).toBeVisible();
  return sourceId;
}

test('duplicate, reorder and edit keep ids positional and positions attached', async ({ page, request }) => {
  const sourceId = await setUpBrief(page, request);
  const before = await savedBrief(request, sourceId);
  expect(before.issues.length).toBe(3);
  const positionsBefore = byName(before);
  // The fixture must actually carry positions, otherwise the contract is vacuous.
  for (const g of before.stakeholder_groups) {
    for (const iss of before.issues) {
      expect(positionsBefore[g.name]?.[iss.name], `${g.name} has no position on ${iss.name}`)
        .toBeDefined();
    }
  }

  // 1. Edit the first issue's name.
  const renamed = `Renamed issue ${Date.now()}`;
  await issueNameInput(page, 'iss_1').fill(renamed);

  // 2. Duplicate the second issue: it lands immediately after iss_2 as iss_3, and the
  //    old iss_3 becomes iss_4.
  await issueRow(page, 'iss_2').locator('button[title="Duplicate"]').click();
  await expect(page.locator('span.t-id:text-matches("^iss_")')).toHaveCount(4);
  expect(await issueIds(page)).toEqual(['iss_1', 'iss_2', 'iss_3', 'iss_4']);
  const originalSecond = before.issues[1].name;
  expect(await issueNameInput(page, 'iss_3').inputValue()).toBe(`${originalSecond} (copy)`);
  expect(await issueNameInput(page, 'iss_4').inputValue()).toBe(before.issues[2].name);

  // 3. Reorder: move the duplicate (iss_3) up, so it becomes iss_2.
  await issueRow(page, 'iss_3').locator('button[title="Move up"]').click();
  expect(await issueNames(page)).toEqual([
    renamed, `${originalSecond} (copy)`, originalSecond, before.issues[2].name,
  ]);
  expect(await issueIds(page)).toEqual(['iss_1', 'iss_2', 'iss_3', 'iss_4']);

  // 4. Save by stepping forward, then read what the server stored.
  await page.getByRole('button', { name: 'Review stakeholders', exact: true }).click();
  await expect.poll(async () => (await savedBrief(request, sourceId)).issues.length,
    { timeout: 15000 }).toBe(4);
  const after = await savedBrief(request, sourceId);

  expect(after.issues.map((i) => i.id)).toEqual(['iss_1', 'iss_2', 'iss_3', 'iss_4']);
  expect(after.issues.map((i) => i.name)).toEqual([
    renamed, `${originalSecond} (copy)`, originalSecond, before.issues[2].name,
  ]);

  // 5. Every surviving original issue keeps exactly the positions recorded for it.
  //    The originals moved: old index 0 -> 0 (renamed), 1 -> 2, 2 -> 3.
  const positionsAfter = byName(after);
  const movedTo = [0, 2, 3];
  for (const g of before.stakeholder_groups) {
    before.issues.forEach((iss, oldIdx) => {
      const was = positionsBefore[g.name]?.[iss.name];
      const now = positionsAfter[g.name]?.[after.issues[movedTo[oldIdx]].name];
      expect(now, `${g.name} / ${iss.name} lost its recorded position`).toBe(was);
    });
  }

  // 6. The duplicated issue inherits nothing: it has no recorded position anywhere.
  const copyName = `${originalSecond} (copy)`;
  for (const g of after.stakeholder_groups) {
    expect(positionsAfter[g.name]?.[copyName],
      `${g.name} was given an invented position on the duplicated issue`).toBeUndefined();
  }

  // 7. No stance may point at an id that no longer exists.
  const liveIds = new Set(after.issues.map((i) => i.id));
  for (const g of after.stakeholder_groups) {
    for (const key of Object.keys(g.stance_by_issue ?? {})) {
      expect(liveIds.has(key), `${g.name} kept a stance for a dead id ${key}`).toBe(true);
    }
  }

  // 8. The reloaded UI shows the same thing (the saved brief, not a stale edit).
  await railStep(page, 'Issues').click();
  expect(await issueNames(page)).toEqual(after.issues.map((i) => i.name));
});

test('a refresh restores unsaved edits from the autosaved draft', async ({ page, request }) => {
  const sourceId = await setUpBrief(page, request);
  const before = await savedBrief(request, sourceId);

  const draftOnly = `Draft-only name ${Date.now()}`;
  await issueNameInput(page, 'iss_1').fill(draftOnly);
  await page.getByRole('button', { name: '+ Add Issue', exact: true }).click();
  await expect(page.locator('span.t-id:text-matches("^iss_")')).toHaveCount(4);
  // Deliberately do NOT step forward: nothing was saved to the server.

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  // The draft restores the step and the working copy.
  await expect(page.getByText('DRAFT · AUTOSAVED')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('span.t-id:text-matches("^iss_")')).toHaveCount(4, { timeout: 15000 });
  expect(await issueNameInput(page, 'iss_1').inputValue()).toBe(draftOnly);

  // The server still holds the pre-refresh state: the restore came from the draft.
  const stillStored = await savedBrief(request, sourceId);
  expect(stillStored.issues.length).toBe(before.issues.length);
  expect(stillStored.issues[0].name).toBe(before.issues[0].name);

  // Saving the restored draft persists it.
  await page.getByRole('button', { name: 'Review stakeholders', exact: true }).click();
  await expect.poll(async () => (await savedBrief(request, sourceId)).issues.length,
    { timeout: 15000 }).toBe(4);
  expect((await savedBrief(request, sourceId)).issues[0].name).toBe(draftOnly);
});

test('a failed save is reported and does not revert the operator input', async ({ page, request }) => {
  const sourceId = await setUpBrief(page, request);
  const before = await savedBrief(request, sourceId);

  const kept = `Kept despite failure ${Date.now()}`;
  await issueNameInput(page, 'iss_1').fill(kept);

  let attempts = 0;
  await page.route('**/api/sources/*/brief', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    attempts += 1;
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: {
        component: 'test', stage: 'save', error_type: 'forced',
        message: 'Forced save failure for the test', hint: 'This is a stubbed 500.',
        http_status: 500,
      } }),
    });
  });

  await page.getByRole('button', { name: 'Review stakeholders', exact: true }).click();

  // The failure is shown, and the wizard stays on the step it could not save.
  await expect(page.getByText('Save failed')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('Forced save failure for the test')).toBeVisible();
  expect(attempts).toBe(1);
  await expect(page.getByText(`Issues — ${before.issues.length}`)).toBeVisible();
  // The input is untouched — a failed save must not silently discard the edit.
  expect(await issueNameInput(page, 'iss_1').inputValue()).toBe(kept);
  // The server was not changed.
  expect((await savedBrief(request, sourceId)).issues[0].name).toBe(before.issues[0].name);

  // Retrying without the stub saves the same edit and advances the wizard.
  await page.unroute('**/api/sources/*/brief');
  await page.getByRole('button', { name: 'Review stakeholders', exact: true }).click();
  await expect.poll(async () => (await savedBrief(request, sourceId)).issues[0].name,
    { timeout: 15000 }).toBe(kept);
  await expect(page.getByRole('button', { name: '+ Add Group', exact: true }))
    .toBeVisible({ timeout: 15000 });
});
