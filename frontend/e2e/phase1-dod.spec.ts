/**
 * Phase 1 DoD E2E Test - Single continuous flow
 * Tests: upload -> issues -> groups -> reload -> edit -> launch -> verify
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { normaliseGroups, normaliseIssues, railStep } from './wizard-counts';

async function getRunDetail(request: APIRequestContext, runId: string) {
  const r = await request.get(`/api/runs/${runId}`);
  return await r.json();
}

async function getSource(request: APIRequestContext, sourceId: string) {
  const r = await request.get(`/api/sources/${sourceId}`);
  return await r.json();
}

// The flow drives a real simulation run (seeding + rounds), which outlasts the
// 30s default test timeout; the assertions themselves are unchanged.
test.describe.configure({ retries: 0, timeout: 300000 });

test.describe('Phase 1 DoD: Wizard Flow', () => {

  test('complete 5-issue / 6-group / 16-agent pipeline', async ({ page, request }) => {
    // === Step 0: Start wizard ===
    await page.goto('http://localhost:5173/#/new');
    await page.waitForLoadState('domcontentloaded');

    // === Step 0: Upload the sample source ===
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached' });
    await fileInput.setInputFiles('e2e/fixtures/sample_source.txt');

    // === Step 1: Choose the source and reach the question step ===
    // The wizard is 8 steps; rail buttons carry names like "3 Issues 5 issue(s)
    // defined", and the nav uses labels such as "Draft the scenario"/"Review
    // issues". Substring matching collides (the rail's empty-state label is
    // "Issues Draft the scenario first"), so nav matches here are exact.
    const draftNav = page.getByRole('button', { name: 'Draft the scenario', exact: true });
    const reviewNav = page.getByRole('button', { name: 'Review the scenario', exact: true });
    // The nav's primary button only exists once the upload has settled and the
    // source is usable (onNext is undefined while busy/extracting).
    await expect(draftNav.or(reviewNav)).toBeVisible({ timeout: 30000 });

    if (await draftNav.isVisible()) {
      await draftNav.click();
      // Name + question live on step 2 ("Research question").
      await page.locator('textarea').first().fill('How will residents respond to the new policy?');
      // "Draft the brief" generates the brief on step 2.
      await page.getByRole('button', { name: 'Draft the brief', exact: true }).click();
    } else {
      await reviewNav.click();        // a brief already exists: step 1 -> step 2
    }
    // The brief is ready when the rail shows its defined counts.
    await expect(page.getByText(/issue\(s\) defined/)).toBeVisible({ timeout: 60000 });
    // Advance to the issues step; the "Review issues" nav is enabled once a brief exists.
    await page.getByRole('button', { name: 'Review issues', exact: true }).click();

    // === Step 2: Add 5 issues and 6 groups ===
    await expect(page.getByText(/Issues — \d+/).first()).toBeVisible({ timeout: 30000 });

    // Normalise to exactly 5 issues: the generated brief is never truncated, so
    // it may propose more than the target; extras are removed explicitly.
    await normaliseIssues(page, 5);
    const issues = await page.locator('span.t-id:has-text("iss_")').all();
    expect(issues.length).toBe(5);
    const uuidsBefore = await page.locator('span.t-id:has-text("iss_")').allTextContents();
    const inputIssueUuids: string[] = [];
    for (const el of issues) {
      const text = await el.textContent();
      if (text?.startsWith('iss_')) inputIssueUuids.push(text.trim());
    }

    // Normalise to exactly 6 groups (extras from an untruncated brief are removed).
    await page.getByRole('button', { name: 'Review stakeholders', exact: true }).click();
    await normaliseGroups(page, 6);
    const groups = await page.locator('span.t-id:has-text("Group")').all();
    expect(groups.length).toBe(6);
    const namesBefore = await page.locator('span.t-id:has-text("Group")').allTextContents();
    // A group row's `span.t-id` is the row's ordinal ("Group 2"), not data — it is
    // only good for matching rows across a reload. The group's own NAME lives in
    // its Name field, and that is the value the run's outputs must carry.
    const inputGroupLabels: string[] = [];
    for (const el of groups) {
      const text = await el.textContent();
      if (text?.startsWith('Group')) inputGroupLabels.push(text.trim());
    }
    const groupRows = page.locator('.panel-2').filter({
      has: page.locator('span.t-id', { hasText: /^Group \d+$/ }),
    });
    const inputGroupNames: string[] = [];
    for (const row of await groupRows.all()) {
      inputGroupNames.push(await row.getByRole('textbox', { name: 'Name', exact: true }).inputValue());
    }

    // === Step 3: Reload mid-wizard ===
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    // The draft persists its step, so the Stakeholders stage re-opens (that is
    // where we were), and the rail is the only way back to the previous stage.
    await expect(page.getByText(/Stakeholder Groups — \d+/).first()).toBeVisible({ timeout: 10000 });

    const namesAfterReload = await page.locator('span.t-id:has-text("Group")').allTextContents();
    await railStep(page, 'Issues').click();
    await expect(page.getByText(/Issues — \d+/).first()).toBeVisible({ timeout: 10000 });
    const uuidsAfterReload = await page.locator('span.t-id:has-text("iss_")').allTextContents();
    const issBefore = uuidsBefore.filter(t => t.startsWith('iss_'));
    const issAfter = uuidsAfterReload.filter(t => t.startsWith('iss_'));
    const groupBefore = namesBefore.filter(t => t.startsWith('Group'));
    const groupAfter = namesAfterReload.filter(t => t.startsWith('Group'));
    // Every issue and group must survive the reload intact — strict equality.
    // (This was previously weakened to a subset check, which hid a real bug
    // where 5 issues became 2 after reload. Reverted — do not soften again.)
    expect(issAfter.sort()).toEqual(issBefore.sort());
    expect(groupAfter.sort()).toEqual(groupBefore.sort());

    // === Step 4: Edit issue field, navigate away, back ===
    // Issue rows render only on the Issues stage. Scope the row by its own panel
    // rather than by DOM depth: span.t-id sits below the panel's header row, which
    // holds the move/duplicate/remove buttons and no inputs.
    const firstIssueUuid = issAfter[0];
    const issueRow = page.locator('.panel-2').filter({
        has: page.locator('span.t-id', { hasText: firstIssueUuid }),
    });
    const issueNameInput = issueRow.getByRole('textbox', { name: 'Name', exact: true });
    await issueNameInput.fill('TEST_EDIT_' + Date.now());
    await page.keyboard.press('Tab');

    // Navigate away FORWARD through the nav button, back through the rail (the
    // rail only enables steps already visited). The edit must survive both.
    await page.getByRole('button', { name: 'Review stakeholders', exact: true }).click();
    await railStep(page, 'Issues').click();
    await expect(page.getByText(/Issues — \d+/).first()).toBeVisible({ timeout: 10000 });

    const nameValue = await issueRow.getByRole('textbox', { name: 'Name', exact: true }).inputValue();
    expect(nameValue).toContain('TEST_EDIT_');

    // === Step 5: Away / back / reload again ===
    await page.getByRole('button', { name: 'Review stakeholders', exact: true }).click();
    await railStep(page, 'Issues').click();
    await expect(page.getByText(/Issues — \d+/).first()).toBeVisible({ timeout: 10000 });
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByText(/Issues — \d+/).first()).toBeVisible({ timeout: 10000 });

    const uuidsFinal = await page.locator('span.t-id:has-text("iss_")').allTextContents();
    // Group rows render only on the Stakeholder Groups stage (forward via nav).
    await page.getByRole('button', { name: 'Review stakeholders', exact: true }).click();
    await expect(page.getByText(/Stakeholder Groups — \d+/).first()).toBeVisible({ timeout: 10000 });
    const namesFinal = await page.locator('span.t-id:has-text("Group")').allTextContents();
    const issFinal = uuidsFinal.filter(t => t.startsWith('iss_'));
    const groupFinal = namesFinal.filter(t => t.startsWith('Group'));
    expect(issFinal.sort()).toEqual(inputIssueUuids.sort());
    expect(groupFinal.sort()).toEqual(inputGroupLabels.sort());
    expect(issFinal.length).toBe(5);
    expect(groupFinal.length).toBe(6);

    // === Step 6: 16 agents, then through Settings/Review to Launch ===
    await page.getByRole('button', { name: 'Set up the population', exact: true }).click();
    // Anchor the name: the writes-per-round slider's accessible name includes a
    // hint that mentions "agent", so /Agents/i matches two sliders.
    const agentsSlider = page.getByRole('slider', { name: /^Agents/ });
    await agentsSlider.fill('16');
    await expect(agentsSlider).toHaveValue('16');

    // Steps 5 -> 6 -> 7 -> 8 in the 8-step wizard (nav labels are exact).
    await page.getByRole('button', { name: 'Simulation settings', exact: true }).click();
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByText(/Pre-launch check/)).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Continue to launch', exact: true }).click();

    // === Step 7: Launch run ===
    await page.getByRole('button', { name: 'Start run', exact: true }).click();
    await page.waitForURL(/\/run\/run_[a-f0-9]+/, { timeout: 10000 });
    const url = page.url();
    const match = url.match(/\/run\/(run_[a-f0-9]+)/);
    expect(match).toBeTruthy();
    const runId = match![1];

    // === Step 8: Wait for run completion ===
    let completed = false;
    for (let i = 0; i < 30; i++) {
      const r = await request.get(`/api/runs/${runId}`);
      const runStatus = await r.json();
      if (runStatus.status === 'completed') {
        completed = true;
        break;
      }
      await page.waitForTimeout(2000);
    }
    expect(completed).toBe(true);

    // === Step 9: Verify run config has 5 issues + 6 groups ===
    const run = await getRunDetail(request, runId);
    const source = await getSource(request, run.source_id);
    const brief = source.brief;
    expect(brief).not.toBeNull();
    const configIssueIds = brief.issues?.map((i: any) => i.id) || [];
    const configGroupNames = brief.stakeholder_groups?.map((g: any) => g.name) || [];
    expect(configIssueIds.length).toBe(5);
    expect(configGroupNames.length).toBe(6);
    expect(configIssueIds.sort()).toEqual(inputIssueUuids.sort());

    // === Step 10: Assert report mentions all issue/group names ===
    const reportResp = await request.get(`/api/runs/${runId}/report`);
    const reportJson = await reportResp.json();
    if (reportJson.report_md) {
      const md = reportJson.report_md;
      for (const uuid of inputIssueUuids) {
        const issue = brief.issues.find((i: any) => i.id === uuid);
        if (issue) expect(md).toContain(issue.name);
      }
      for (const g of inputGroupNames) expect(md).toContain(g);
    }

    // === Step 11: Assert findings mention all issue/group names ===
    const findingsResp = await request.get(`/api/runs/${runId}/findings`);
    const findingsJson = await findingsResp.json();
    if (findingsJson.findings) {
      const allText = JSON.stringify(findingsJson.findings);
      for (const uuid of inputIssueUuids) {
        const issue = brief.issues.find((i: any) => i.id === uuid);
        if (issue) expect(allText).toContain(issue.name);
      }
      for (const g of inputGroupNames) expect(allText).toContain(g);
    }

    console.log('Phase 1 DoD E2E test PASSED!');
  });
});