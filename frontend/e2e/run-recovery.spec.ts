/**
 * Run recovery (item 1, browser half).
 *
 * A reload while a run is active must not strand the room: the same run must
 * render, the selected view must come back, the header must follow the run to
 * completion, and every number on screen must still match what the API stored.
 * Reloading a draft would prove nothing, so the test waits until the run is
 * actually producing posts before it reloads.
 */
import { test, expect } from '@playwright/test';
import { createRun, openTab, runNav, waitForRun } from './run-fixture';

test.describe.configure({ retries: 0, timeout: 300000 });

test('a reload during an active run restores the run, its view and its numbers', async ({ page, request }) => {
  // Long enough that the reload lands mid-run; small enough that the feed still
  // loads quickly afterwards.
  const runId = await createRun(request, {
    agents: 30, ticks: 300, writes: 20, start: false, name: 'Recovery run',
  });

  await page.goto(`/#/run/${runId}`);
  await expect(page.getByRole('heading', { name: 'Recovery run' })).toBeVisible({ timeout: 30000 });

  // Choose a non-default view so the reload has a choice to restore.
  await openTab(page, 'Agents');
  await expect(runNav(page).locator('button[aria-current="page"]')).toHaveText(/^Agents/);

  await page.getByRole('button', { name: 'Start', exact: true }).click();

  // Reload only once the run is really producing posts.
  await expect.poll(async () => {
    const r = await (await request.get(`/api/runs/${runId}`)).json();
    return r.posts as number;
  }, { timeout: 90000, intervals: [200, 400, 800] }).toBeGreaterThan(0);

  const statusBefore = (await (await request.get(`/api/runs/${runId}`)).json()).status as string;
  expect(['running', 'seeding']).toContain(statusBefore);

  await page.reload();

  // Same run, same view, and the reload itself surfaced no error.
  await expect(page.getByRole('heading', { name: 'Recovery run' })).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.run-meta')).toContainText(runId);
  await expect(runNav(page).locator('button[aria-current="page"]')).toHaveText(/^Agents/);
  await expect(page.locator('.banner-err')).toHaveCount(0);

  const done = await waitForRun(request, runId, ['completed']);
  const total = done.posts as number;
  expect(total).toBeGreaterThan(0);

  // The room follows the run to completion rather than freezing at the reload.
  await expect(page.locator('h1.run-title + .status')).toContainText('Completed', { timeout: 90000 });

  // The header's Posts stat equals what the API stored.
  const postsStat = page.locator('.run-stats .stat').filter({ hasText: 'Posts' }).locator('.num');
  await expect(postsStat).toHaveText(String(total));

  // The feed shows each recorded post once: no duplicated cards after reload.
  await openTab(page, 'Feed');
  const ids = await page.locator('article[data-post-id]').evaluateAll(
    (els) => els.map((e) => (e as HTMLElement).dataset.postId ?? ''));
  expect(ids.length).toBeGreaterThan(0);
  expect(ids.every((id) => id.length > 0)).toBe(true);
  expect(new Set(ids).size, 'the feed rendered the same post twice').toBe(ids.length);
  await expect(page.locator('.banner-err')).toHaveCount(0);
});
