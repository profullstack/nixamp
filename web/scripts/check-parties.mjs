// Built app + local API fixtures: no live streams, accounts, or billable providers.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.NIXAMP_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.NIXAMP_CHROMIUM_PATH ? { executablePath: process.env.NIXAMP_CHROMIUM_PATH } : {}) });
const root = fileURLToPath(new URL('../dist', import.meta.url));
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
const origin = 'https://nixamp.com', alpha = 'https://alpha.example.test', beta = 'https://beta.example.test';
let signedIn = true, bridge = [], delayedDirectory = false, activeDirectory = 0, maxDirectory = 0, bridgeRequests = 0;
let streams = [
  { id: 'a', name: 'Alpha server', url: alpha + '/view/view-a', tracks: 0, nowPlaying: '', playing: false, channels: ['Alpha live'], lineup: [{ id: 'same-id', name: 'Alpha live' }] },
  { id: 'b', name: 'Beta server', url: beta + '/view/view-b', tracks: 0, nowPlaying: '', playing: false, channels: ['Beta live'], lineup: [{ id: 'same-id', name: 'Beta live' }] },
];
const state = { revision: 1, tracks: [], trackCount: 0, index: 0, playing: false, position: 0, bars: [], levels: [0, 0], silent: true, note: '', root: '' };
let holdAlpha = false, releaseAlpha, alphaHeld = false;
await context.route('**/*', async route => {
  const url = new URL(route.request().url()), path = url.pathname;
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
  if (![origin, alpha, beta].includes(url.origin)) return route.abort();
  if (path === '/api/v1/auth/me') return signedIn ? json({ account: { id: 'fixture-account', email: 'fixture@example.test' } }) : json({ error: 'Sign in' }, 401);
  if (path === '/api/v1/auth/logout') { signedIn = false; return json({ ok: true }); }
  if (path === '/api/v1/auth/providers') return json({ providers: [] });
  if (path === '/api/v1/translation-passes') return json({ required: false, available: false, plans: [], coins: [], orders: [] });
  if (path === '/api/health') return json({ name: 'nixamp', version: 'fixture' });
  if (path === '/api/state') return json(state);
  if (path === '/api/directory') {
    activeDirectory += 1; maxDirectory = Math.max(maxDirectory, activeDirectory);
    if (delayedDirectory) await new Promise(resolve => setTimeout(resolve, 3200));
    try { return await json({ streams, recent: [] }); } finally { activeDirectory -= 1; }
  }
  if (path === '/api/v1/watch-parties') { bridgeRequests += 1; return signedIn ? json({ parties: bridge }) : json({ error: 'Sign in' }, 401); }
  if (path === '/api/streams') {
    if (url.origin === alpha && holdAlpha) { alphaHeld = true; await new Promise(resolve => { releaseAlpha = resolve; }); }
    const name = url.origin === alpha ? 'Alpha server' : 'Beta server';
    return json({ server: { name, nowPlaying: '', tracks: 0, playing: false, live: false, code: '', url: url.origin + '/view/key' }, channels: [{ id: 'same-id', name: name === 'Alpha server' ? 'Old alpha response' : 'Beta live', via: 'pull', listeners: 1, startedAt: 1, kind: 'audio' }] });
  }
  if (path === '/jingles/index.json') return json([]);
  if (path.startsWith('/api/')) return json({ error: 'Fixture endpoint unavailable' }, 404);
  if (url.origin !== origin) return route.abort();
  const file = Bun.file(root + (path === '/' ? '/index.html' : path));
  return await file.exists() ? route.fulfill({ contentType: file.type, body: Buffer.from(await file.arrayBuffer()) }) : route.fulfill({ status: 404, body: '' });
});
await context.addInitScript(() => {
  localStorage.setItem('nixamp.welcome', 'hidden');
  localStorage.setItem('nixamp.panels', JSON.stringify({ order: [], placement: {}, collapsed: ['panels-panel'], closed: ['panels-panel'] }));
  window.EventSource = class { constructor() { setTimeout(() => this.onopen?.({}), 0); } close() {} addEventListener() {} removeEventListener() {} };
});
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('#parties-list').getByText('Beta live', { exact: true }).waitFor();
  assert.equal(await page.locator('#parties-panel').count(), 1);
  assert.equal(await page.locator('#onair-panel').count(), 0);
  assert.deepEqual(await page.locator('#parties-list h3').allTextContents(), ['Alpha server', 'Beta server']);
  assert.equal(await page.locator('#remote-panel').getByText('nixamp serve ~/Music').count(), 0);
  // Closed and shaded saved states both reopen on the first activation.
  const toggle = page.locator('#panels-toggle'), chooser = page.locator('#panels-panel');
  await toggle.click();
  await page.locator('#panels-list input').first().waitFor({ state: 'visible' });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('#panels-list .name').getByText('Parties', { exact: true }).count(), 1);
  await chooser.locator('.panel-tools button').last().click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await toggle.click(); assert.ok(await chooser.isVisible());
  await chooser.locator('.panel-tools button[aria-expanded]').click();
  await toggle.click(); assert.ok(await page.locator('#panels-list').isVisible());
  await toggle.focus(); await page.keyboard.press('Enter'); assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await page.keyboard.press('Enter'); assert.ok(await page.locator('#panels-list').isVisible());
  assert.ok(await page.evaluate(() => document.querySelector('#panels-panel').contains(document.activeElement)), 'keyboard navigation did not enter Panels');
  await page.keyboard.press('Escape');
  await chooser.waitFor({ state: 'hidden' });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');

  // Keeping focus inside one row must not freeze new rows or other servers.
  const marker = await page.evaluate(() => {
    window.scrollTo(0, 240);
    const control = document.querySelector('#parties-list .party-row button');
    control.focus({ preventScroll: true }); window.__partyFocus = control;
    return { scroll: scrollY, panel: document.querySelector('#parties-list').scrollTop };
  });
  streams[0].channels.push('New sports live');
  streams[0].lineup.push({ id: 'sports', name: 'New sports live' });
  bridge = [{ party: { roomId: 'room-1', slug: 'movie', origin: 'Cinema', partyCode: 'ABC123', partyUrl: 'https://cinema.example.test/watch/abc', mediaTitle: 'Movie night', positionNow: 5, playing: true }, event: { id: 'event-1', title: 'Movie night', status: 'live' }, links: { partyUrl: 'https://cinema.example.test/watch/abc', nixampUrl: 'https://nixamp.com/room/abc', roomUrl: 'https://nixamp.com/room/abc' }, host: false }];
  await page.locator('#parties-list').getByText('New sports live', { exact: true }).waitFor({ timeout: 4500 });
  await page.locator('#parties-list').getByText('Movie night', { exact: true }).waitFor({ timeout: 4500 });
  assert.ok(await page.evaluate(() => document.activeElement === window.__partyFocus && window.__partyFocus.isConnected));
  assert.deepEqual(await page.evaluate(() => ({ scroll: scrollY, panel: document.querySelector('#parties-list').scrollTop })), marker);
  assert.equal(await page.locator('.party-server').filter({ has: page.getByRole('heading', { name: 'Alpha server', exact: true }) }).getByText('New sports live', { exact: true }).count(), 1);
  const draft = await page.evaluate(() => {
    const input = document.querySelector('#remote-url'); input.value = 'keep my draft'; input.focus({ preventScroll: true }); input.setSelectionRange(2, 5);
    return { scroll: scrollY, panel: document.querySelector('#parties-list').scrollTop };
  });
  bridge = [];
  await page.locator('#parties-list').getByText('Movie night', { exact: true }).waitFor({ state: 'detached', timeout: 4500 });
  assert.deepEqual(await page.locator('#remote-url').evaluate(input => [input.value, input.selectionStart, input.selectionEnd]), ['keep my draft', 2, 5]);
  assert.deepEqual(await page.evaluate(() => ({ scroll: scrollY, panel: document.querySelector('#parties-list').scrollTop })), draft);
  delayedDirectory = true; maxDirectory = 0;
  await page.waitForTimeout(6500);
  assert.ok(maxDirectory <= 1, 'slow directory responses stacked requests'); delayedDirectory = false;

  // A late response from the previous server cannot overwrite the new server.
  holdAlpha = true;
  await page.locator('#remote-url').fill(alpha + '/view/view-a');
  await page.locator('#remote-form').evaluate(form => form.requestSubmit());
  await page.waitForFunction(() => document.querySelector('#remote-state').dataset.status === 'live');
  for (let i = 0; i < 50 && !alphaHeld; i++) await page.waitForTimeout(20);
  assert.ok(alphaHeld);
  await page.locator('#remote-url').fill(beta + '/view/view-b');
  await page.locator('#remote-form').evaluate(form => form.requestSubmit());
  await page.waitForFunction(() => document.querySelector('#source').textContent.includes('Beta server'));
  releaseAlpha?.(); holdAlpha = false;
  await page.waitForTimeout(2300);
  assert.equal(await page.locator('#parties-list').getByText('Old alpha response', { exact: true }).count(), 0);
  assert.equal(await page.locator('#parties-list h3').getByText('Beta server', { exact: true }).count(), 1, 'connected server was duplicated');

  // Signing out keeps public parties while dropping account-only reads.
  await page.locator('#account-sign-out').evaluate(button => button.click());
  await page.waitForTimeout(2300);
  const requestsAfterSignOut = bridgeRequests;
  await page.waitForTimeout(2300);
  assert.equal(bridgeRequests, requestsAfterSignOut);
  assert.ok(await page.locator('#parties-list').getByText('Beta live', { exact: true }).isVisible());
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator('#parties-list').evaluate(list => list.scrollWidth <= list.clientWidth + 1));
  assert.ok(await page.locator('#parties-list .party-row').first().evaluate(row => row.getBoundingClientRect().height <= 40), 'party rows are no longer compact');
  await page.screenshot({ path: '/tmp/nixamp-parties-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PARTIES CHECK: one panel, server groups, live add/end, focus/caret/scroll, bounded requests, late responses, sign-out, compact mobile, Panels reopen');
} finally { releaseAlpha?.(); await browser.close(); }
