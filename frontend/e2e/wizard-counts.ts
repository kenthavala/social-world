/**
 * Wizard count helpers.
 *
 * The brief a provider proposes is never truncated (silently dropping a
 * configured issue or group is a data-loss bug), so a generated brief may
 * legitimately contain more issues or groups than a test wants. Tests that
 * assert an exact count must therefore normalise the count explicitly:
 * add when short, remove when long, then assert.
 *
 * The Remove control in both builders is a `<button title="Remove">×</button>`
 * inside the row it deletes; only one builder is rendered at a time, so
 * targeting the last one trims from the end of the visible list.
 */
import { expect, type Page } from '@playwright/test';

export const ISSUE_ROWS = 'span.t-id:has-text("iss_")';
export const GROUP_ROWS = 'span.t-id:has-text("Group")';

/**
 * A button in the step rail. The rail rewrites a completed step's accessible name
 * from "<n> Label <status>" to "✓ Label done", so numeric anchors (/^3 Issues/)
 * stop matching as soon as the step is finished. Scope to the rail container and
 * match the label instead: only one rail button carries each label.
 */
export function railStep(page: Page, label: string) {
  return page.locator('.steps').getByRole('button', { name: new RegExp(label) });
}

async function trim(page: Page, rows: string, target: number): Promise<void> {
  for (let guard = 0; guard < 60; guard++) {
    if ((await page.locator(rows).count()) <= target) return;
    await page.locator('button[title="Remove"]').last().click();
    await page.waitForTimeout(150);
  }
  throw new Error(`could not trim rows to ${target}`);
}

/** Make the Issues step hold exactly `target` issues (5 by default). */
export async function normaliseIssues(page: Page, target = 5): Promise<void> {
  const add = page.getByRole('button', { name: /\+ Add Issue/i });
  for (let guard = 0; guard < 60; guard++) {
    if ((await page.locator(ISSUE_ROWS).count()) >= target) break;
    await add.click();
    await page.waitForTimeout(200);
  }
  await trim(page, ISSUE_ROWS, target);
  await expect(page.locator(ISSUE_ROWS)).toHaveCount(target);
}

/** Make the Stakeholder groups step hold exactly `target` groups (6 by default). */
export async function normaliseGroups(page: Page, target = 6): Promise<void> {
  const add = page.getByRole('button', { name: /\+ Add Group/i });
  for (let guard = 0; guard < 60; guard++) {
    if ((await page.locator(GROUP_ROWS).count()) >= target) break;
    await add.click();
    await page.waitForTimeout(200);
  }
  await trim(page, GROUP_ROWS, target);
  await expect(page.locator(GROUP_ROWS)).toHaveCount(target);
}
