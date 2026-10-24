/**
 * Accessibility sweep (item 6).
 *
 * Runs axe-core on every main screen at both configured viewports (1440x900
 * desktop and 390x844 mobile). The gate is: no `serious` or `critical`
 * violations. That is deliberately narrower than a WCAG conformance claim — axe
 * covers a subset of success criteria, and moderate/minor findings are recorded
 * as annotations rather than silently ignored.
 */
import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { createCompletedRun, openTab } from './run-fixture';

test.describe.configure({ retries: 0, timeout: 300000 });

let runA = '';
let runB = '';

test.beforeAll(async ({ request }) => {
  runA = await createCompletedRun(request, { name: 'A11y run A', seed: 20261024 });
  runB = await createCompletedRun(request, { name: 'A11y run B', seed: 20261025 });
});

/** Wait until the screen has painted its real content, then run axe. */
async function audit(page: Page, name: string) {
  await page.waitForTimeout(1200);
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical');

  const summary = results.violations.map(
    (v) => `${v.id} [${v.impact}] x${v.nodes.length}`);
  test.info().annotations.push({
    type: 'axe',
    description: `${name}: ${results.violations.length} violation(s)`
      + (summary.length ? ` — ${summary.join(', ')}` : ''),
  });

  expect(
    blocking,
    `${name} has ${blocking.length} serious/critical violation(s): `
      + blocking.map((v) => `${v.id} [${v.impact}] on ${v.nodes.length} node(s)`).join('; '),
  ).toEqual([]);
}

test('home has no serious or critical violations', async ({ page }) => {
  await page.goto('/#/');
  await expect(page.locator('nav[aria-label="Primary"]').first()).toBeVisible({ timeout: 30000 });
  await audit(page, 'home');
});

test('the run wizard has no serious or critical violations', async ({ page }) => {
  await page.goto('/#/new');
  await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 30000 });
  await audit(page, 'wizard');
});

test('sources has no serious or critical violations', async ({ page }) => {
  await page.goto('/#/documents');
  await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 30000 });
  await audit(page, 'documents');
});

test('settings has no serious or critical violations', async ({ page }) => {
  await page.goto('/#/settings');
  await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 30000 });
  await audit(page, 'settings');
});

for (const [name, tab, marker] of [
  ['run-feed', 'Feed', 'article[data-post-id]'],
  ['run-agents', 'Agents', 'input[aria-label="Search agents"]'],
  ['run-network', 'Connections', 'input[type="checkbox"]'],
  ['run-findings', 'Findings', 'article[id^="finding-"]'],
  ['run-quality', 'Quality', 'h2#overall-h'],
] as const) {
  test(`${name} has no serious or critical violations`, async ({ page }) => {
    await page.goto(`/#/run/${runA}`);
    await expect(page.locator('h1.run-title')).toBeVisible({ timeout: 30000 });
    await openTab(page, tab);
    await expect(page.locator(marker).first()).toBeVisible({ timeout: 60000 });
    await audit(page, name);
  });
}

test('run comparison has no serious or critical violations', async ({ page }) => {
  await page.goto(`/#/compare?a=${runA}&b=${runB}`);
  await expect(page.getByText('Recorded stance by issue')).toBeVisible({ timeout: 30000 });
  await audit(page, 'compare');
});
