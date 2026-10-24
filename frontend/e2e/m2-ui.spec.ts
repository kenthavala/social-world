/**
 * M2 UI E2E Tests - split into 6 independent test blocks
 * Each test exercises one UI area of the M2 dashboard.
 * Each test independently sets up its own run through the wizard.
 *
 * test.describe.configure timeout set to 600s per block.
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { normaliseGroups, normaliseIssues } from './wizard-counts';

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

  // Add issues and groups, then normalise: a brief is never truncated, so it
  // may propose more than the test's target (5 issues, 6 groups).
  await normaliseIssues(page, 5);
  // Forward navigation must use the nav button; the rail only jumps backwards
  // (future steps are disabled, so a rail click here waits forever).
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
  // Two tab navigations exist: the desktop strip (hidden at <=820px) and the
  // mobile bottom nav. Assert selection in whichever one this viewport shows.
  const narrow = (page.viewportSize()?.width ?? 1440) <= 820;
  const selected = narrow
    ? page.locator('nav[aria-label="Run sections"] button[aria-current="page"]').filter({ hasText: 'Agents' })
    : page.locator('.tab.is-selected').filter({ hasText: 'Agents' });
  await expect(selected).toBeVisible({ timeout: 10000 });
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

  // The LLM call log lives in the Run details drawer, not in a tab.
  await page.getByRole('button', { name: 'Run details' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('Run details');
  await expect(drawer.locator('text=LLM calls').first()).toBeVisible({ timeout: 10000 });
  await expect(drawer.locator('table.tbl')).toBeVisible({ timeout: 10000 });

  const callRows = drawer.locator('table.tbl tbody tr');
  const rowCount = await callRows.count();
  expect(rowCount).toBeGreaterThan(0);
});

/**
 * Test 4: Inject events UI works.
 */
test('M2 UI: Inject events UI works', async ({ page, request }) => {
  // Interventions can only be recorded on a controllable run; setupM2Run leaves
  // a COMPLETED one, where the button is correctly disabled. Use its source to
  // create a draft run and schedule there.
  const completedId = await setupM2Run(page, request);
  const detail = await (await request.get(`/api/runs/${completedId}`)).json();
  const created = await request.post('/api/runs', {
    data: {
      source_id: detail.source_id,
      name: 'Draft for intervention',
      scenario_json: { question: 'How will people respond?', events: [] },
      config: { agents: 6, ticks: 4, writes_per_tick: 2, seed: 424242 },
    },
  });
  expect(created.ok()).toBeTruthy();
  const draft = await created.json();
  expect(draft.status).toBe('draft');

  await page.goto(`/#/run/${draft.id}`);
  await page.getByRole('button', { name: 'Intervene', exact: true }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('Intervene in this world');

  await drawer.locator('textarea').first().fill('Breaking news: major policy change announced!');
  await drawer.getByLabel('Audience').selectOption('all');
  await drawer.getByLabel(/Deliver at round/).fill('1');
  await drawer.getByRole('button', { name: /Record intervention/ }).click();

  // The schedule is persisted server-side and listed immediately.
  await expect(drawer.getByText(/SCHEDULED/).first()).toBeVisible({ timeout: 10000 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

/**
 * Test 5: Model list free filter works.
 *
 * The provider is a native <select>, the model field is a text input with a
 * "List" button, and the free filter is a counted checkbox that replaces the
 * model list with the free subset. The models endpoint is stubbed so the test
 * does not depend on a live provider credential (the endpoint's own free_only
 * derivation is asserted by the backend API test); the UI must still render
 * exactly the payload it was given, including the explicit empty state.
 */
test('M2 UI: Model list free filter works', async ({ page, request }) => {
  await setupM2Run(page, request);

  const models = ['alpha:free', 'beta-large', 'gamma-FREE', 'delta'];
  const freeOnly = ['alpha:free', 'gamma-FREE'];
  const stub = (free: string[]) =>
    page.route('**/api/providers/*/models', async (route) => {
      const provider = new URL(route.request().url()).pathname.split('/')[3];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ provider, models, free_only: free }),
      });
    });
  await stub(freeOnly);

  await page.goto('http://localhost:5173/#/settings');
  await expect(page.getByRole('heading', { name: /LLM provider/i })).toBeVisible({ timeout: 10000 });

  await page.getByRole('combobox', { name: /^Provider/ }).selectOption('mock');
  await page.getByRole('button', { name: 'List', exact: true }).click();

  const modelField = page.locator('.field').filter({ has: page.getByLabel('Model', { exact: true }) });
  const modelSelect = modelField.locator('select');
  await expect(modelSelect).toBeVisible({ timeout: 15000 });
  await expect(modelSelect.locator('option')).toHaveCount(models.length + 1);
  for (const m of models) {
    await expect(modelSelect.locator('option', { hasText: m })).toHaveCount(1);
  }

  const free = page.getByRole('checkbox', { name: /Free models only/ });
  await expect(free).toBeVisible();
  await expect(free).not.toBeChecked();
  await expect(free).toHaveAccessibleName(
    new RegExp(`Free models only \\(${freeOnly.length} of ${models.length} listed\\)`),
  );

  await free.check();
  await expect(modelSelect.locator('option')).toHaveCount(freeOnly.length + 1);
  for (const m of freeOnly) {
    await expect(modelSelect.locator('option', { hasText: m })).toHaveCount(1);
  }
  await expect(modelSelect.locator('option', { hasText: 'beta-large' })).toHaveCount(0);

  await free.uncheck();
  await expect(modelSelect.locator('option')).toHaveCount(models.length + 1);

  // An empty free set must be stated explicitly, never shown as a silent empty list.
  await page.unroute('**/api/providers/*/models');
  await stub([]);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(free).not.toBeChecked();   // re-listing resets the filter
  await free.check();
  await expect(modelSelect.locator('option')).toHaveCount(2);
  await expect(modelSelect.locator('option', { hasText: 'no free models listed' })).toHaveCount(1);
});

/**
 * Test 6: Fallback provider switch works.
 *
 * The fallback is a select, and a change is only real if it survives the save
 * round trip, so the test reloads and re-reads it.
 */
test('M2 UI: Fallback provider switch works', async ({ page, request }) => {
  await setupM2Run(page, request);

  await page.goto('http://localhost:5173/#/settings');
  await expect(page.getByRole('heading', { name: /LLM provider/i })).toBeVisible({ timeout: 10000 });

  const fallback = page.getByLabel(/^Fallback provider/);
  const original = await fallback.inputValue();
  const target = original === 'nvidia_nim' ? 'mock' : 'nvidia_nim';
  await fallback.selectOption(target);
  await page.getByRole('button', { name: /^Save/ }).click();

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByLabel(/^Fallback provider/)).toHaveValue(target, { timeout: 15000 });

  // Leave the shared settings as they were for the rest of the suite.
  await page.getByLabel(/^Fallback provider/).selectOption(original);
  await page.getByRole('button', { name: /^Save/ }).click();
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByLabel(/^Fallback provider/)).toHaveValue(original, { timeout: 15000 });
});