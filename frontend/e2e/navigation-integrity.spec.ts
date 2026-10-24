/**
 * Navigation integrity (item 7).
 *
 * The run room must let an operator move between the four representations of the
 * same record without losing their place:
 *
 *   document -> chunk -> evidence -> finding      (Findings: "Open passage")
 *   finding -> passage -> finding                 (Feed drawer: "Findings that cite this passage")
 *   entity list -> agent comparison / group detail (Connections)
 *
 * and the entity list must stay usable at 390px, where the graph canvas is not a
 * realistic target. Every assertion reads what the API actually stored, so a
 * broken link cannot pass by showing a plausible label.
 */
import { test, expect } from '@playwright/test';
import { createCompletedRun, openTab } from './run-fixture';

test.describe.configure({ retries: 0, timeout: 240000 });

let runId = '';

test.beforeAll(async ({ request }) => {
  runId = await createCompletedRun(request);
});

test('the connections list supports agent comparison and group detail', async ({ page }) => {
  await page.goto(`/#/run/${runId}`);
  await openTab(page, 'Connections');

  const boxes = page.getByRole('checkbox', { name: /^Select / });
  await expect(boxes.first()).toBeVisible({ timeout: 30000 });
  const handle0 = (await boxes.nth(0).getAttribute('aria-label'))!.replace(/^Select\s+@?/, '');
  const handle1 = (await boxes.nth(1).getAttribute('aria-label'))!.replace(/^Select\s+@?/, '');

  // Ticking the first agent must not hide the list: comparison needs a second pick.
  await boxes.nth(0).check();
  await expect(boxes.nth(1), 'the list disappeared after the first pick').toBeVisible();
  await boxes.nth(1).check();

  // The list offers an explicit comparison control once two agents are ticked.
  const compare = page.getByRole('button', { name: /^Compare 2 selected$/ });
  await expect(compare).toBeVisible();
  await compare.click();

  // The comparison table is the only place the two agents are shown side by side.
  await expect(page.getByText('2 agents selected', { exact: true })).toBeVisible();
  const rows = page.locator('table.tbl tbody tr');
  await expect(rows).toHaveCount(2);
  const table = page.locator('table.tbl');
  await expect(table).toContainText(`@${handle0}`);
  await expect(table).toContainText(`@${handle1}`);

  // Back to the list, then open a stakeholder group's detail panel.
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const groupRows = page.locator('button.list-row[aria-pressed]');
  await expect(groupRows.first()).toBeVisible();
  const groupName = (await groupRows.first().locator('span').first().textContent())!.trim();
  await groupRows.first().click();

  await expect(page.getByText('Stakeholder group', { exact: true })).toBeVisible();
  await expect(page.locator('p.t-h3').filter({ hasText: groupName })).toBeVisible();
  await expect(page.getByText('Members', { exact: true })).toBeVisible();
  await expect(page.getByText('Most connected agents', { exact: true })).toBeVisible();
  // The panel must name real members, not an empty shell.
  const memberRows = page.locator('.panel-body button.list-row').filter({ hasText: '@' });
  expect(await memberRows.count()).toBeGreaterThan(0);
});

test('the entity list is usable at 390px without horizontal overflow', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chrome', 'this test defines the 390px contract');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/run/${runId}`);
  await openTab(page, 'Connections');

  const boxes = page.getByRole('checkbox', { name: /^Select / });
  await expect(boxes.first()).toBeVisible({ timeout: 30000 });

  // Nothing on the page may overflow the viewport horizontally.
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth, 'the page scrolls horizontally at 390px')
    .toBeLessThanOrEqual(overflow.innerWidth + 1);

  // Every entity row is fully inside the viewport and is a real target.
  const groupRows = page.locator('button.list-row[aria-pressed]');
  const groupCount = await groupRows.count();
  expect(groupCount).toBeGreaterThan(0);
  for (let i = 0; i < groupCount; i++) {
    const box = (await groupRows.nth(i).boundingBox())!;
    expect(box.x, `group row ${i} starts off-screen`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `group row ${i} overflows 390px`).toBeLessThanOrEqual(391);
    expect(box.height, `group row ${i} is too small to tap`).toBeGreaterThanOrEqual(28);
  }

  const agentBox = (await boxes.first().boundingBox())!;
  expect(agentBox.x + agentBox.width).toBeLessThanOrEqual(391);
  const agentRowBox = (await page.locator('label.list-row').first().boundingBox())!;
  expect(agentRowBox.x + agentRowBox.width).toBeLessThanOrEqual(391);

  // A row that is visible but not clickable would be a dead end: use it.
  await groupRows.first().click();
  await expect(page.getByText('Stakeholder group', { exact: true })).toBeVisible();
});

test('a finding opens its passage and the passage leads back to a finding', async ({ page, request }) => {
  await page.goto(`/#/run/${runId}`);
  await openTab(page, 'Findings');

  const article = page.locator('article[id^="finding-"]')
    .filter({ has: page.locator('summary') }).first();
  await expect(article, 'no counted finding carried evidence').toBeVisible({ timeout: 30000 });

  await article.locator('summary').first().click();
  const openPassage = article.getByRole('button', { name: /^Open source passage / });
  await expect(openPassage.first()).toBeVisible();
  const chunkId = (await openPassage.first().getAttribute('aria-label'))!
    .replace('Open source passage ', '');

  // The chunk must really be part of the stored evidence for this finding.
  const narrative = await (await request.get(`/api/runs/${runId}/narrative`)).json();
  const citing = narrative.key_findings.filter((f: any) =>
    (f.evidence ?? []).some((e: any) => e.chunk_id === chunkId));
  expect(citing.length, `no finding cites ${chunkId}`).toBeGreaterThan(0);

  await openPassage.first().click();

  // The Feed's source drawer shows the passage text, not a placeholder.
  const drawer = page.locator('aside.drawer[role="dialog"]');
  await expect(drawer).toBeVisible({ timeout: 15000 });
  await expect(drawer.getByText(chunkId, { exact: false }).first()).toBeVisible();
  const passage = drawer.locator('blockquote.source-text');
  await expect(passage).toBeVisible();
  expect((await passage.textContent())!.trim().length).toBeGreaterThan(40);

  // The drawer lists the findings whose counted evidence includes this chunk.
  const section = drawer.locator('div').filter({ hasText: /^Findings that cite this passage/ }).first();
  await expect(section).toBeVisible({ timeout: 15000 });
  const expected = citing[0];
  const back = drawer.locator('button.list-row', { hasText: expected.headline }).first();
  await expect(back).toBeVisible();
  await back.click();

  // The drawer closes and the matching finding is brought into view.
  await expect(drawer).toHaveCount(0);
  const focused = page.locator(`article[id="finding-${expected.id}"]`);
  await expect(focused).toBeVisible();
  await expect(focused).toHaveAttribute('data-focused', 'true');
});
