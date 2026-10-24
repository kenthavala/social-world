/**
 * Shared fixture for specs that need a real run.
 *
 * Everything is created through the public API so the test exercises the same
 * path the UI uses, without paying for the wizard on every test. The source text
 * is long enough to produce several chunks (citations need real chunk ids) and
 * the brief is a complete, sanitised world brief.
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const SOURCE_TEXT = (
  'Transport policy is contested. Supporters say the charge cuts emissions and funds buses. ' +
  'Opponents say it raises costs for households and small shops. Residents near the centre are ' +
  'divided; commuters are more supportive; trade bodies want exemptions; the council must decide ' +
  'before the budget review. '
).repeat(25);

export const BRIEF = {
  summary: 'A council weighs a congestion charge.',
  issues: [1, 2, 3].map((i) => ({
    id: `iss_${i}`,
    name: `Contested Issue ${i}`,
    question: 'How should the council decide?',
    pro_label: 'Support',
    con_label: 'Oppose',
    evidence_chunk_ids: [],
  })),
  stakeholder_groups: [1, 2, 3].map((j) => ({
    name: `Stakeholder Group ${j}`,
    description: 'A group affected by the charge.',
    size_hint: ['small', 'medium', 'large'][(j - 1) % 3],
    stance_by_issue: {
      iss_1: [-0.5, 0.25, 0][(j - 1) % 3],
      iss_2: [0.5, -0.25, 0][(j - 1) % 3],
      iss_3: [0, 0.5, -0.5][(j - 1) % 3],
    },
  })),
  key_claims: [],
  entities: [],
};

export async function createSource(request: APIRequestContext, label = 'run'): Promise<string> {
  const upload = await request.post('/api/sources', {
    multipart: { text: SOURCE_TEXT, filename: `${label}-${Date.now()}.txt` },
  });
  expect(upload.ok(), await upload.text()).toBe(true);
  const src = await upload.json();
  const sourceId: string = src.source_id ?? src.id;
  expect(src.status, 'source must be extracted before a run can use it').toBe('extracted');

  const brief = await request.put(`/api/sources/${sourceId}/brief`, {
    data: { brief: BRIEF },
  });
  expect(brief.ok(), await brief.text()).toBe(true);
  return sourceId;
}

export async function waitForRun(
  request: APIRequestContext, runId: string, statuses: string[], timeout = 180000,
): Promise<any> {
  let last: any = null;
  await expect.poll(async () => {
    last = await (await request.get(`/api/runs/${runId}`)).json();
    return last.status as string;
  }, { timeout, intervals: [250, 500, 1000] }).toMatch(
    new RegExp(`^(${statuses.join('|')})$`));
  return last;
}

/** Create a run from a fresh source and start it. Returns the run id. */
export async function createRun(
  request: APIRequestContext,
  opts: {
    agents?: number; ticks?: number; writes?: number; seed?: number;
    name?: string; sourceId?: string; start?: boolean;
  } = {},
): Promise<string> {
  const sourceId = opts.sourceId ?? await createSource(request);
  const created = await request.post('/api/runs', {
    data: {
      source_id: sourceId,
      name: opts.name ?? `Fixture run ${Date.now()}`,
      config: {
        agents: opts.agents ?? 12,
        ticks: opts.ticks ?? 3,
        writes_per_tick: opts.writes ?? 3,
        seed: opts.seed ?? 20261024,
      },
      scenario_json: {
        question: 'How will residents respond to the congestion charge?',
        events: [],
      },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const run = await created.json();
  if (opts.start !== false) {
    const started = await request.post(`/api/runs/${run.id}/start`);
    expect(started.ok(), await started.text()).toBe(true);
  }
  return run.id as string;
}

/** Create and wait for a completed mock run (the read-only screens need one). */
export async function createCompletedRun(
  request: APIRequestContext,
  opts: Parameters<typeof createRun>[1] = {},
): Promise<string> {
  const id = await createRun(request, opts);
  await waitForRun(request, id, ['completed']);
  return id;
}

/** The run tab navigation the current viewport renders (desktop vs mobile). */
export function runNav(page: Page) {
  const width = page.viewportSize()?.width ?? 1280;
  return width > 820
    ? page.locator('nav[aria-label="Run views"]')
    : page.locator('nav[aria-label="Run sections"]');
}

/** Click a run tab in whichever navigation the current viewport renders. */
export async function openTab(page: Page, label: string) {
  const nav = runNav(page);
  await expect(nav, 'the run navigation never rendered').toBeVisible({ timeout: 30000 });
  await nav.getByRole('button', { name: new RegExp(`^${label}`) }).click();
}
