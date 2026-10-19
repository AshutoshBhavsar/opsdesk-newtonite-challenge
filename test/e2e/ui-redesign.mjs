// UI behaviour test for the redesigned interface (Playwright). NOT part of `npm test`; run it like ui-smoke.mjs:
//   npm run migrate && npm run seed && npm run build:web && (npm run dev &) && npm run test:e2e:ui
// Covers what ui-smoke.mjs does not: sign-in error, no horizontal overflow at 3 widths, the mobile drawer,
// a version conflict shown INSIDE the dialog, explained (blocked) actions, row navigation, a confirm dialog
// for removing a member, and the skip link.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const PW = 'Passw0rd!demo';
const exe = process.env.CHROMIUM_PATH;
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--no-sandbox'] });
const step = (m) => console.log('  ok -', m);

async function open(email, viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { throw e; });
  await page.goto(BASE);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('main').waitFor();
  await page.getByRole('heading', { name: 'Needs attention' }).waitFor();
  return { ctx, page };
}

try {
  // 1. A wrong password is explained on the login screen.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE);
    await page.getByLabel('Email').fill('zoya@kaveri.test');
    await page.getByLabel('Password').fill('definitely-wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('alert').filter({ hasText: /incorrect email or password/i }).waitFor();
    await ctx.close();
    step('wrong password shows a specific error');
  }

  // 2. No horizontal overflow on any route at desktop, tablet and phone widths.
  for (const [label, viewport] of [['desktop', { width: 1280, height: 800 }], ['tablet', { width: 820, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
    const { ctx, page } = await open('ananya@kaveri.test', viewport);
    for (const hash of ['#/', '#/items', '#/new', '#/notifications', '#/members']) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForTimeout(500);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.equal(over, 0, `${label}: horizontal overflow of ${over}px on ${hash}`);
    }
    await ctx.close();
  }
  step('no horizontal overflow on 5 routes at 1280 / 820 / 390 px');

  // 3. Phone: the navigation is a drawer that opens with the button and closes with Escape.
  {
    const { ctx, page } = await open('priya@kaveri.test', { width: 390, height: 844 });
    const nav = page.getByRole('navigation', { name: 'Main' });
    assert.equal(await nav.isVisible(), false, 'drawer is closed at first');
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await nav.waitFor();
    await page.keyboard.press('Escape');
    await nav.waitFor({ state: 'hidden' });
    step('mobile navigation drawer opens and closes with Escape');
    await ctx.close();
  }

  // Shared setup: a fresh unassigned Platform item created through the API.
  const ava = await open('ananya@kaveri.test');
  const me = await (await ava.ctx.request.get(`${BASE}/api/me`)).json();
  const platform = me.teams.find((t) => t.name === 'Platform');
  const title = `Redesign check ${Date.now()}`;
  const created = await ava.ctx.request.post(`${BASE}/api/items`, { data: { teamId: platform.id, title, kind: 'task', priority: 'medium' } });
  assert.equal(created.status(), 201);
  const item = await created.json();

  // 4. The list row is clickable and keyboard reachable (the title is a real link).
  await ava.page.evaluate(() => { location.hash = '#/items'; });
  await ava.page.getByLabel('Search').fill(title);
  const row = ava.page.getByRole('row').filter({ hasText: title });
  await row.waitFor();
  await row.getByText('Platform').first().click(); // click the row, not the link
  await ava.page.waitForURL(`**/#/items/${item.id}`);
  step('clicking anywhere on a list row opens the item');

  // 5. Blocked actions are explained in the page, not only in a tooltip.
  await ava.page.getByRole('heading', { name: 'Not available right now' }).waitFor();
  assert.ok(await ava.page.locator('.unavailable li').first().innerText());
  step('unavailable actions are listed with the server-provided reason');

  // 6. A version conflict is shown INSIDE the open dialog (errors used to appear behind the modal).
  await ava.page.getByRole('button', { name: 'Edit', exact: true }).click();
  const dlg = ava.page.getByRole('dialog');
  await dlg.waitFor();
  const cur = await (await ava.ctx.request.get(`${BASE}/api/items/${item.id}`)).json();
  const bump = await ava.ctx.request.patch(`${BASE}/api/items/${item.id}`, { data: { expectedVersion: cur.version, title: `${title} (edited elsewhere)` } });
  assert.equal(bump.status(), 200);
  await dlg.getByLabel('Title').fill(`${title} (my edit)`);
  await dlg.getByRole('button', { name: 'Save changes' }).click();
  await dlg.locator('.banner.warn, .error').first().waitFor({ timeout: 5000 });
  assert.ok(await dlg.isVisible(), 'dialog stays open so the user can see the problem');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await ava.page.getByText(/Latest version is v/).waitFor();
  step('version conflict is explained inside the dialog and in the page; nothing was overwritten');
  const after = await (await ava.ctx.request.get(`${BASE}/api/items/${item.id}`)).json();
  assert.equal(after.title, `${title} (edited elsewhere)`);

  // 7. Removing a member needs an explicit confirmation; cancelling changes nothing.
  await ava.page.evaluate(() => { location.hash = '#/members'; });
  await ava.page.getByRole('table').waitFor();
  const before = await (await ava.ctx.request.get(`${BASE}/api/teams/${platform.id}/members`)).json();
  await ava.page.getByRole('button', { name: 'Remove' }).first().click();
  const confirmDlg = ava.page.getByRole('dialog');
  await confirmDlg.getByRole('heading', { name: /^Remove / }).waitFor();
  await confirmDlg.getByRole('button', { name: 'Cancel' }).click();
  await confirmDlg.waitFor({ state: 'hidden' });
  const same = await (await ava.ctx.request.get(`${BASE}/api/teams/${platform.id}/members`)).json();
  assert.equal(same.length, before.length);
  step('member removal asks for confirmation; Cancel leaves the team unchanged');
  await ava.ctx.close();

  // 8. Keyboard: the first Tab stop is the skip link.
  {
    const { ctx, page } = await open('vikram@kaveri.test');
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.keyboard.press('Tab');
    assert.match(await page.evaluate(() => document.activeElement?.textContent ?? ''), /Skip to content/);
    step('first Tab stop is the "Skip to content" link');
    await ctx.close();
  }

  console.log('UI REDESIGN TEST PASSED');
} catch (e) {
  console.error('UI REDESIGN TEST FAILED:', e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
