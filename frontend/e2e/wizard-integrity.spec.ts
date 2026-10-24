/**
 * Data-integrity regression for E022.
 *
 * Issue ids are positional (iss_1..iss_N) and every stakeholder group records its
 * starting position keyed by those ids. Deleting (or reordering) an issue in the
 * wizard used to renumber the ids without remapping the groups' stance maps, so
 * seeding gave each group a position that belonged to a different issue.
 *
 * This test proves the contract the fix establishes: a group's recorded position
 * follows its ISSUE (by name), never the issue's index.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
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

test('deleting an issue keeps group positions attached to their own issue', async ({ page, request }) => {
  const known = new Set(await sourceIds(request));

  await page.goto('/#/new');
  await page.waitForLoadState('domcontentloaded');

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: 'attached' });
  // Upload unique bytes: identical content is de-duplicated by sha256 and would
  // return an existing source, so a fresh fixture name/content is required to
  // know which source this test owns.
  const unique = `Integrity ${Date.now()} ${Math.random().toString(36).slice(2)}`;
  await fileInput.setInputFiles({
    name: `integrity-${Date.now()}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(
      `${unique}. Transport policy is contested. Supporters say the charge cuts emissions ` +
      'and funds buses. Opponents say it raises costs for households and small shops. ' +
      'Residents near the centre are divided; commuters are more supportive; trade bodies ' +
      'want exemptions; the council must decide before the budget review. '.repeat(20),
    ),
  });

  // The upload endpoint creates a source; identify it as the one that was not
  // there before, so leftover sources in the shared data dir cannot confuse us.
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
  await normaliseIssues(page, 5);

  // Step forward (the nav saves on the way out), normalise groups, step forward
  // again so the 6 groups are saved too.
  await page.getByRole('button', { name: 'Review stakeholders', exact: true }).click();
  await normaliseGroups(page, 6);
  await page.getByRole('button', { name: 'Set up the population', exact: true }).click();
  await railStep(page, 'Issues').click();   // back via the rail

  const before = await savedBrief(request, sourceId);
  expect(before.issues.length).toBe(5);
  expect(before.stakeholder_groups.length).toBe(6);
  const positionsBefore = byName(before);
  const removedName = before.issues[0].name;

  // Delete the first issue and save by stepping forward again.
  await page.locator('button[title="Remove"]').first().click();
  await expect(page.locator('span.t-id:has-text("iss_")')).toHaveCount(4);
  await page.getByRole('button', { name: 'Review stakeholders', exact: true }).click();

  await expect
    .poll(async () => (await savedBrief(request, sourceId)).issues.length, { timeout: 15000 })
    .toBe(4);
  const after = await savedBrief(request, sourceId);
  const positionsAfter = byName(after);

  // The deleted issue is gone.
  expect(after.issues.map((i) => i.name)).not.toContain(removedName);

  // Surviving issues keep exactly the positions that were recorded for them.
  for (const g of before.stakeholder_groups) {
    for (const iss of after.issues) {
      const was = positionsBefore[g.name]?.[iss.name];
      const now = positionsAfter[g.name]?.[iss.name];
      expect(now, `${g.name} / ${iss.name} lost its recorded position`).toBe(was);
    }
  }

  // No stance may point at an id that no longer exists.
  const liveIds = new Set(after.issues.map((i) => i.id));
  for (const g of after.stakeholder_groups) {
    for (const key of Object.keys(g.stance_by_issue ?? {})) {
      expect(liveIds.has(key), `${g.name} kept a stance for deleted id ${key}`).toBe(true);
    }
  }
});
