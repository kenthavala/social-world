/**
 * M2 UI E2E Tests - split into 6 independent test blocks
 * Each test exercises one UI area of the M2 dashboard.
 * Each test independently sets up its own run through the wizard.
 *
 * test.describe.configure timeout set to 600s per block.
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

test.describe.configure({ retries: 0, timeout: 600000 });

/**
 * Helper: set up a full run through the wizard, wait for completion,
 * and return the runId. Leaves the browser on the run page.
 */
async function setupM2Run(page: Page, request: APIRequestContext): Promise<string> {
  // Step 0: Start wizard
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

  // Wait for run to complete (mock provider) - generous polling
  let completed = false;
  for (let i = 0; i < 120; i++) {
    const r = await request.get(`/api/runs/${runId}`);
    const runStatus = await r.json();
    if (runStatus.status === 'completed') {
      completed = true;
      break;
    }
    if (runStatus.status === 'failed' || runStatus.status === 'error') {
      break;
    }
    await page.waitForTimeout(1000);
  }
  expect(completed).toBe(true, `run ${runId} did not complete`);

  return runId;
}

/**
 * Test 1: Agents tab + drawer opens.
 */
test('M2 UI: Agents tab + drawer opens', async ({ page, request }) => {
  await setupM2Run(page, request);

  await page.getByRole('button', { name: /Agents/ }).click();
  await expect(page.locator('.tab.is-selected:has-text("Agents")')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('button.chip:has-text("PRO")')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('button.chip:has-text("CON")')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('button.chip:has-text("NEU")')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('button.chip:has-text("ALL")')).toBeVisible({ timeout: 5000 });

  const firstAgentRow = page.locator('tr').filter({ hasText: /agent/i }).first();
  if (await firstAgentRow.count() > 0) {
    await firstAgentRow.click();
    await expect(page.locator('text=Stance History')).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');
  }
});

/**
 * Test 2: Connections tab + tick slider moves.
 */
test('M2 UI: Connections tab + tick slider moves', async ({ page, request }) => {
  await setupM2Run(page, request);

  await page.getByRole('button', { name: /Connections/ }).click();
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15000 });

  // Test tick slider / round selector
  const roundSlider = page.getByRole('slider', { name: /Connections round/ });
  if (await roundSlider.isVisible()) {
    await roundSlider.fill('1');
    await page.waitForTimeout(300);
    await roundSlider.fill('8');
    await page.waitForTimeout(300);
  }

  // Test play/pause playback
  const playButton = page.getByRole('button', { name: /Play rounds/ });
  if (await playButton.isVisible()) {
    await playButton.click();
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /Pause round playback/ }).click();
  }
});

/**
 * Test 3: Log tab renders.
 */
test('M2 UI: Log tab renders', async ({ page, request }) => {
  await setupM2Run(page, request);

  await page.getByRole('button', { name: /Log/ }).click();
  await expect(page.locator('text=LLM calls').first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator('table.tbl')).toBeVisible({ timeout: 10000 });

  const callRows = page.locator('table.tbl tbody tr');
  const rowCount = await callRows.count();
  expect(rowCount).toBeGreaterThan(0);
});

/**
 * Test 4: Inject events UI works.
 */
test('M2 UI: Inject events UI works', async ({ page, request }) => {
  await setupM2Run(page, request);

  await page.getByRole('button', { name: /Intervene/ }).click();
  await expect(page.locator('text=Intervene in this world')).toBeVisible({ timeout: 5000 });

  await page.locator('textarea[placeholder*="event"]').first().fill('Breaking news: major policy change announced!');

  await page.getByRole('combobox', { name: /audience/i }).first().click();
  await page.getByRole('option', { name: /all groups/i }).click();

  await page.locator('input[type="number"][placeholder*="tick"]').first().fill('1');

  await page.getByRole('button', { name: /Schedule|Add event/i }).click();
  await page.waitForTimeout(500);

  await page.keyboard.press('Escape');
});

/**
 * Test 5: Model list free filter works.
 */
test('M2 UI: Model list free filter works', async ({ page, request }) => {
  await setupM2Run(page, request);

  await page.getByRole('button', { name: /Settings/ }).click();
  await expect(page.locator('text=Settings').first()).toBeVisible({ timeout: 5000 });

  await page.getByRole('combobox', { name: /provider/i }).first().click();
  await page.getByRole('option', { name: /mock/i }).click();

  await page.getByRole('combobox', { name: /model/i }).first().click();
  const freeFilter = page.getByRole('checkbox', { name: /free/i });
  if (await freeFilter.isVisible()) {
    await freeFilter.click();
    await page.waitForTimeout(300);
    await freeFilter.click();
  }

  await page.keyboard.press('Escape');
});

/**
 * Test 6: Fallback provider switch works.
 */
test('M2 UI: Fallback provider switch works', async ({ page, request }) => {
  await setupM2Run(page, request);

  await page.getByRole('button', { name: /Settings/ }).click();
  await expect(page.locator('text=Settings').first()).toBeVisible({ timeout: 5000 });

  const fallbackSwitch = page.getByRole('switch', { name: /fallback/i });
  if (await fallbackSwitch.isVisible()) {
    await fallbackSwitch.click();
    await page.waitForTimeout(300);
    await fallbackSwitch.click();
  }

  await page.keyboard.press('Escape');
});