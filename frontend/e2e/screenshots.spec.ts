/**
 * M4 Visual QA - Screenshot tests for all routes at multiple viewports
 * test.describe.configure timeout set to 600s per block.
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

test.describe.configure({ retries: 0, timeout: 600000 });

/**
 * Helper: wait for run to complete
 */
async function waitForRunCompletion(page: Page, request: APIRequestContext, runId: string) {
  for (let i = 0; i < 120; i++) {
    const r = await request.get(`/api/runs/${runId}`);
    const runStatus = await r.json();
    if (runStatus.status === 'completed') {
      return true;
    }
    if (runStatus.status === 'failed' || runStatus.status === 'error') {
      return false;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

/**
 * Helper: set up a run and return runId
 */
async function setupRun(page: Page, request: APIRequestContext): Promise<string> {
  // Go to wizard
  await page.goto('http://localhost:5173/#/new');
  await page.waitForLoadState('domcontentloaded');

  // Upload sample source
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: 'attached' });
  await fileInput.setInputFiles('e2e/fixtures/sample_source.txt');

  // Navigate through wizard
  const draftButton = page.getByRole('button', { name: /Draft the scenario/i });
  const reviewButton = page.getByRole('button', { name: /Review the scenario/i });
  await expect(page.getByRole('button', { name: /(?:Draft|Review) the scenario/i }))
    .toBeVisible({ timeout: 30000 });

  if (await draftButton.isVisible()) {
    await draftButton.click();
    await page.locator('textarea').first().fill('How will residents respond to the new policy?');
    await page.getByRole('button', { name: /Draft the scenario/i }).click();
  } else {
    await reviewButton.click();
  }

  // Wait for brief generation
  await expect(page.getByText(/Issues \(\d+\)/)).toBeVisible({ timeout: 30000 });
  await expect(page.getByText(/Stakeholder Groups \(\d+\)/)).toBeVisible({ timeout: 30000 });

  // Add issues and groups (5 issues, 6 groups)
  await page.getByRole('button', { name: /Issues \(\d+\)/ }).click();
  let issues = await page.locator('span.t-id:has-text("iss_")').all();
  let issuesToAdd = Math.max(0, 5 - issues.length);
  for (let i = 0; i < issuesToAdd; i++) {
    await page.getByRole('button', { name: /\+ Add Issue/i }).click();
    await page.waitForTimeout(300);
  }
  await expect(page.locator('span.t-id:has-text("iss_")')).toHaveCount(5);

  await page.getByRole('button', { name: /Stakeholder Groups \(\d+\)/ }).click();
  let groups = await page.locator('span.t-id:has-text("Group")').all();
  let groupsToAdd = Math.max(0, 6 - groups.length);
  for (let i = 0; i < groupsToAdd; i++) {
    await page.getByRole('button', { name: /\+ Add Group/i }).click();
    await page.waitForTimeout(300);
  }
  await expect(page.locator('span.t-id:has-text("Group")')).toHaveCount(6);

  // Set agents and start run
  await page.getByRole('button', { name: /Set up agents/i }).click();
  const agentsSlider = page.getByRole('slider', { name: /^Agents/ });
  await agentsSlider.fill('5');
  await expect(page.getByText(/5 agents/)).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: /Review & launch/i }).click();
  await page.getByRole('button', { name: /Start run/i }).click();
  await page.waitForURL(/\/run\/run_[a-f0-9]+/, { timeout: 10000 });
  const url = page.url();
  const match = url.match(/\/run\/(run_[a-f0-9]+)/);
  expect(match).toBeTruthy();
  const runId = match![1];

  // Wait for run to complete
  const completed = await waitForRunCompletion(page, request, runId);
  expect(completed).toBe(true, `run ${runId} did not complete`);
  return runId;
}

/**
 * Test 1: Home page.
 */
test('Visual QA: Home page', async ({ page, request }) => {
  await page.goto('http://localhost:5173/');
  await page.waitForLoadState('domcontentloaded');
  // Take screenshots at different viewports
  const viewports = ['1440x900', '1280x800', '390x844'];
  for (const viewport of viewports) {
    const [width, height] = viewport.split('x').map(Number);
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `docs/screenshots/pass1/home_${viewport}.png`, fullPage: true });
  }
});

/**
 * Test 2: Simulations page.
 */
test('Visual QA: Simulations page', async ({ page, request }) => {
  await page.goto('http://localhost:5173/#/simulations');
  await page.waitForLoadState('domcontentloaded');
  const viewports = ['1440x900', '1280x800', '390x844'];
  for (const viewport of viewports) {
    const [width, height] = viewport.split('x').map(Number);
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `docs/screenshots/pass1/simulations_${viewport}.png`, fullPage: true });
  }
});

/**
 * Test 3: Documents page.
 */
test('Visual QA: Documents page', async ({ page, request }) => {
  await page.goto('http://localhost:5173/#/documents');
  await page.waitForLoadState('domcontentloaded');
  const viewports = ['1440x900', '1280x800', '390x844'];
  for (const viewport of viewports) {
    const [width, height] = viewport.split('x').map(Number);
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `docs/screenshots/pass1/documents_${viewport}.png`, fullPage: true });
  }
});

/**
 * Test 4: Settings page.
 */
test('Visual QA: Settings page', async ({ page, request }) => {
  await page.goto('http://localhost:5173/#/settings');
  await page.waitForLoadState('domcontentloaded');
  const viewports = ['1440x900', '1280x800', '390x844'];
  for (const viewport of viewports) {
    const [width, height] = viewport.split('x').map(Number);
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `docs/screenshots/pass1/settings_${viewport}.png`, fullPage: true });
  }
});

/**
 * Test 5: Run page (Agents tab).
 */
test('Visual QA: Run page - Agents tab', async ({ page, request }) => {
  // Set up a run first
  const runId = await setupRun(page, request);

  // Go to run page
  await page.goto(`http://localhost:5173/#/run/${runId}`);
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `docs/screenshots/pass1/run_agents_1440x900.png`, fullPage: true });

  // Also screenshot at other viewports
  for (const viewport of ['1280x800', '390x844']) {
    const [width, height] = viewport.split('x').map(Number);
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `docs/screenshots/pass1/run_agents_${viewport}.png`, fullPage: true });
  }
});

/**
 * Test 6: Run page - Network tab.
 */
test('Visual QA: Run page - Network tab', async ({ page, request }) => {
  const runId = await setupRun(page, request);

  await page.goto(`http://localhost:5173/#/run/${runId}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: /Connections/ }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `docs/screenshots/pass1/run_network_1440x900.png`, fullPage: true });

  for (const viewport of ['1280x800', '390x844']) {
    const [width, height] = viewport.split('x').map(Number);
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `docs/screenshots/pass1/run_network_${viewport}.png`, fullPage: true });
  }
});

/**
 * Test 7: Run page - Log tab.
 */
test('Visual QA: Run page - Log tab', async ({ page, request }) => {
  const runId = await setupRun(page, request);

  await page.goto(`http://localhost:5173/#/run/${runId}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: /Log/ }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `docs/screenshots/pass1/run_log_1440x900.png`, fullPage: true });

  for (const viewport of ['1280x800', '390x844']) {
    const [width, height] = viewport.split('x').map(Number);
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `docs/screenshots/pass1/run_log_${viewport}.png`, fullPage: true });
  }
});

/**
 * Test 8: Settings page - Model list.
 */
test('Visual QA: Settings page - Model list', async ({ page, request }) => {
  await page.goto('http://localhost:5173/#/settings');
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `docs/screenshots/pass1/settings_1440x900.png`, fullPage: true });

  for (const viewport of ['1280x800', '390x844']) {
    const [width, height] = viewport.split('x').map(Number);
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `docs/screenshots/pass1/settings_${viewport}.png`, fullPage: true });
  }
});

/**
 * Test 9: Wizard page.
 */
test('Visual QA: Wizard page', async ({ page, request }) => {
  await page.goto('http://localhost:5173/#/new');
  await page.waitForLoadState('domcontentloaded');
  const viewports = ['1440x900', '1280x800', '390x844'];
  for (const viewport of viewports) {
    const [width, height] = viewport.split('x').map(Number);
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `docs/screenshots/pass1/wizard_${viewport}.png`, fullPage: true });
  }
});