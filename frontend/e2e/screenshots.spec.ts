/**
 * M4 Visual QA - Screenshot tests for all routes at multiple viewports
 * test.describe.configure timeout set to 600s per block.
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { normaliseGroups, normaliseIssues } from './wizard-counts';

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

  // Navigate through the 8-step wizard. Rail buttons carry names like
  // "3 Issues 5 issue(s) defined", so every nav match must be exact.
  const draftNav = page.getByRole('button', { name: 'Draft the scenario', exact: true });
  const reviewNav = page.getByRole('button', { name: 'Review the scenario', exact: true });
  await expect(draftNav.or(reviewNav)).toBeVisible({ timeout: 30000 });

  if (await draftNav.isVisible()) {
    await draftNav.click();
    await page.locator('textarea').first().fill('How will residents respond to the new policy?');
    await page.getByRole('button', { name: 'Draft the brief', exact: true }).click();
  } else {
    await reviewNav.click();        // a brief already exists: step 1 -> step 2
  }
  // The brief is ready when the rail shows its defined counts; advance to issues.
  await expect(page.getByText(/issue\(s\) defined/)).toBeVisible({ timeout: 60000 });
  await page.getByRole('button', { name: 'Review issues', exact: true }).click();

  // Normalise to exactly 5 issues / 6 groups (a brief is never truncated).
  await normaliseIssues(page, 5);
  // Forward through the nav; the rail only jumps backwards.
  await page.getByRole('button', { name: 'Review stakeholders', exact: true }).click();
  await normaliseGroups(page, 6);

  // Population, then through Settings and Review to Launch (nav labels exact).
  await page.getByRole('button', { name: 'Set up the population', exact: true }).click();
  await page.getByRole('slider', { name: /^Agents/ }).fill('5');
  await page.getByRole('button', { name: 'Simulation settings', exact: true }).click();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Continue to launch', exact: true }).click();
  await page.getByRole('button', { name: 'Start run', exact: true }).click();
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
  // Two run navigations exist: "Run views" (desktop tabs) and "Run sections"
  // (mobile bottom bar). Resizing does not unmount the mobile bar
  // synchronously, so an unscoped /Connections/ matches both for a moment.
  // Scope to the desktop navigation; the click below is a desktop viewport.
  await page.getByRole('navigation', { name: 'Run views' })
    .getByRole('button', { name: 'Connections' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `docs/screenshots/pass1/run_network_1440x900.png`, fullPage: true });

  for (const viewport of ['1280x800', '390x844']) {
    const [width, height] = viewport.split('x').map(Number);
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `docs/screenshots/pass1/run_network_${viewport}.png`, fullPage: true });
  }
});

/**
 * Test 7: Run page - LLM call log (Run details drawer).
 *
 * RUN_TABS is Feed/Agents/Connections/Findings/Quality: there is no Log tab.
 * The call log renders inside the "Run details" drawer, so the screenshot is
 * taken with that drawer open and its heading asserted first.
 */
test('Visual QA: Run page - Log tab', async ({ page, request }) => {
  const runId = await setupRun(page, request);

  await page.goto(`http://localhost:5173/#/run/${runId}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Run details' }).click();
  await expect(page.getByRole('dialog')).toContainText('LLM calls', { timeout: 15000 });
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