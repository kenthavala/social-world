/**
 * Phase 1 DoD E2E Test - Single continuous flow
 * Tests: upload -> issues -> groups -> reload -> edit -> launch -> verify
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

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

    // === Step 1: Upload sample source ===
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached' });
    await fileInput.setInputFiles('e2e/fixtures/sample_source.txt');

    // The source might already exist with a brief (from a previous test run)
    // Click the appropriate button to proceed to step 2
    const draftButton = page.getByRole('button', { name: /Draft the scenario/i });
    const reviewButton = page.getByRole('button', { name: /Review the scenario/i });

    // Nav renders the primary button only once the upload has settled and the
    // source is usable (onNext is undefined while busy/extracting), so probe
    // only after it exists — otherwise we race the upload and take the branch
    // that never becomes valid on a fresh data dir.
    await expect(page.getByRole('button', { name: /(?:Draft|Review) the scenario/i }))
      .toBeVisible({ timeout: 30000 });

    if (await draftButton.isVisible()) {
        await draftButton.click();
        // Enter a scenario question on step 2
        await page.locator('textarea').first().fill('How will residents respond to the new policy?');
        // Generate the brief on step 2
        await page.getByRole('button', { name: /Draft the scenario/i }).click();
    } else {
        await reviewButton.click();
        // Brief already generated, skip to checking issues
    }

    // Wait for brief generation - issues count should appear
    await expect(page.getByText(/Issues \(\d+\)/)).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/Stakeholder Groups \(\d+\)/)).toBeVisible({ timeout: 30000 });

    // === Step 2: Add 5 issues and 6 groups ===
    await page.getByRole('button', { name: /Issues \(\d+\)/ }).click();

    // Add issues until 5 total
    let issues = await page.locator('span.t-id:has-text("iss_")').all();
    const issuesToAdd = Math.max(0, 5 - issues.length);
    for (let i = 0; i < issuesToAdd; i++) {
      await page.getByRole('button', { name: /\+ Add Issue/i }).click();
      await page.waitForTimeout(300);
    }
    await expect(page.locator('span.t-id:has-text("iss_")')).toHaveCount(5);
    issues = await page.locator('span.t-id:has-text("iss_")').all();
    expect(issues.length).toBe(5);
    const uuidsBefore = await page.locator('span.t-id:has-text("iss_")').allTextContents();
    const inputIssueUuids: string[] = [];
    for (const el of issues) {
      const text = await el.textContent();
      if (text?.startsWith('iss_')) inputIssueUuids.push(text.trim());
    }

    // Add groups until 6 total
    await page.getByRole('button', { name: /Stakeholder Groups \(\d+\)/ }).click();
    let groups = await page.locator('span.t-id:has-text("Group")').all();
    const groupsToAdd = Math.max(0, 6 - groups.length);
    for (let i = 0; i < groupsToAdd; i++) {
      await page.getByRole('button', { name: /\+ Add Group/i }).click();
      await page.waitForTimeout(300);
    }
    await expect(page.locator('span.t-id:has-text("Group")')).toHaveCount(6);
    groups = await page.locator('span.t-id:has-text("Group")').all();
    expect(groups.length).toBe(6);
    const namesBefore = await page.locator('span.t-id:has-text("Group")').allTextContents();
    const inputGroupNames: string[] = [];
    for (const el of groups) {
      const text = await el.textContent();
      if (text?.startsWith('Group')) inputGroupNames.push(text.trim());
    }

    // === Step 3: Reload mid-wizard ===
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByText(/Issues \(\d+\)/)).toBeVisible({ timeout: 10000 });

    const uuidsAfterReload = await page.locator('span.t-id:has-text("iss_")').allTextContents();
    await page.getByRole('button', { name: /Stakeholder Groups \(\d+\)/ }).click();
    const namesAfterReload = await page.locator('span.t-id:has-text("Group")').allTextContents();
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
    // The group count above left the Stakeholder Groups tab active, and issue
    // rows render only on the Issues tab. Scope the row by its own panel rather
    // than by DOM depth: span.t-id sits below the panel's header row, which
    // holds the move/duplicate/remove buttons and no inputs.
    await page.getByRole('button', { name: /Issues \(\d+\)/ }).click();
    const firstIssueUuid = issAfter[0];
    const issueRow = page.locator('.panel-2').filter({
        has: page.locator('span.t-id', { hasText: firstIssueUuid }),
    });
    const issueNameInput = issueRow.getByRole('textbox', { name: 'Name', exact: true });
    await issueNameInput.fill('TEST_EDIT_' + Date.now());
    await page.keyboard.press('Tab');

    await page.getByRole('button', { name: /Set up agents/i }).click();
    await page.getByRole('button', { name: /Back/i }).first().click();
    await expect(page.getByText(/Issues \(\d+\)/)).toBeVisible({ timeout: 10000 });

    const nameValue = await issueRow.getByRole('textbox', { name: 'Name', exact: true }).inputValue();
    expect(nameValue).toContain('TEST_EDIT_');

    // === Step 5: Next / back / reload again ===
    await page.getByRole('button', { name: /Set up agents/i }).click();
    await page.getByRole('button', { name: /Back/i }).first().click();
    await expect(page.getByText(/Issues \(\d+\)/)).toBeVisible({ timeout: 10000 });
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByText(/Issues \(\d+\)/)).toBeVisible({ timeout: 10000 });

    const uuidsFinal = await page.locator('span.t-id:has-text("iss_")').allTextContents();
    // Group rows render only on the Stakeholder Groups tab.
    await page.getByRole('button', { name: /Stakeholder Groups \(\d+\)/ }).click();
    const namesFinal = await page.locator('span.t-id:has-text("Group")').allTextContents();
    const issFinal = uuidsFinal.filter(t => t.startsWith('iss_'));
    const groupFinal = namesFinal.filter(t => t.startsWith('Group'));
    expect(issFinal.sort()).toEqual(inputIssueUuids.sort());
    expect(groupFinal.sort()).toEqual(inputGroupNames.sort());
    expect(issFinal.length).toBe(5);
    expect(groupFinal.length).toBe(6);

    // === Step 6: Set agents to 16 ===
    await page.getByRole('button', { name: /Set up agents/i }).click();
    // Anchor the name: the writes-per-round slider's accessible name includes a
    // hint that mentions "agent", so /Agents/i matches two sliders.
    const agentsSlider = page.getByRole('slider', { name: /^Agents/ });
    await agentsSlider.fill('16');
    await expect(page.getByText(/16 agents/)).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: /Review & launch/i }).click();

    // === Step 7: Launch run ===
    await page.getByRole('button', { name: /Start run/i }).click();
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