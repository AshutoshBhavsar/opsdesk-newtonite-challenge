// UI smoke test (Playwright). NOT part of `npm test`: run it against a running, seeded server:
//   npm run migrate && npm run seed && npm run build:web && (npm run dev &) && npm run test:e2e
// Flow: login -> Needs attention groups -> new item (via API) -> two users open it -> first claims in the UI
//       -> second user (stale page) clicks Claim -> sees who owns it, UI rolled back.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const PW = 'Passw0rd!demo';
const exe = process.env.CHROMIUM_PATH; // optional override for sandboxes with a pre-installed browser

const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--no-sandbox'] });
const step = (m) => console.log('  ok -', m);

async function login(email) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { throw e; });
  await page.goto(BASE);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation', { name: 'Main' }).waitFor();
  return { ctx, page };
}

try {
  // 1. Admin sees the Needs-attention home with groups and their visible rule text
  const ava = await login('ananya@kaveri.test');
  await ava.page.getByRole('heading', { name: /Waiting for your approval/ }).waitFor();
  assert.ok(await ava.page.getByText(/Pending approval, in a team where you are an approver/).isVisible());
  step('login + Needs attention groups with rule text');

  // 2. Priya creates a fresh unassigned Platform item through the API
  const noor = await login('priya@kaveri.test');
  const me = await (await noor.ctx.request.get(`${BASE}/api/me`)).json();
  const platform = me.teams.find((t) => t.name === 'Platform');
  const title = `Smoke test item ${Date.now()}`;
  const created = await noor.ctx.request.post(`${BASE}/api/items`, { data: { teamId: platform.id, title, kind: 'task', priority: 'medium' } });
  assert.equal(created.status(), 201);
  const item = await created.json();
  step('created item via API');

  // 3. Siddharth (also Platform) opens the same item; Priya's page claims it first
  const sam = await login('siddharth@kaveri.test');
  await sam.page.goto(`${BASE}/#/items/${item.id}`);
  await sam.page.getByRole('button', { name: 'Claim it' }).waitFor();
  await noor.page.goto(`${BASE}/#/items/${item.id}`);
  await noor.page.getByRole('button', { name: 'Claim it' }).click();
  await noor.page.getByText(/Priya Sharma/).first().waitFor();
  step('Priya claimed in the UI');

  // 4. Sam's page is stale (may or may not have received the SSE banner yet) -> clicking Claim must NOT win
  const btn = sam.page.getByRole('button', { name: 'Claim it' });
  if (await btn.count()) {
    await btn.click();
    await sam.page.getByText(/Priya Sharma/).first().waitFor();
    const text = await sam.page.locator('main').innerText();
    assert.match(text, /Priya Sharma/);
    step('Siddharth saw the conflict / owner = Priya');
  } else {
    step('Sam page already refreshed via live update (no stale Claim button)');
  }
  const final = await (await sam.ctx.request.get(`${BASE}/api/items/${item.id}`)).json();
  assert.equal(final.assignee.name, 'Priya Sharma');
  assert.equal(final.version, 2);
  step('server state: assignee Priya, version 2 (exactly one winner)');

  console.log('UI SMOKE TEST PASSED');
} catch (e) {
  console.error('UI SMOKE TEST FAILED:', e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
