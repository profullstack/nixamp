// Actual built interfaces, with local fixtures and no paid/network API access.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.NIXAMP_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.NIXAMP_CHROMIUM_PATH ? { executablePath: process.env.NIXAMP_CHROMIUM_PATH } : {}) });
try {
  for (const site of ['nixamp', 'backtoschool']) {
    const context = await browser.newContext({ locale: 'es-MX', viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const root = fileURLToPath(new URL(site === 'nixamp' ? '../dist' : '../../backtoschool/dist', import.meta.url));
    const requests = [];
    const origin = site === 'nixamp' ? 'https://nixamp.com' : 'https://backtoschool.help';
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.origin !== origin) return route.abort();
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (path.startsWith('/api/')) requests.push({ path, method: request.method(), body: request.postData() });
      if (path === '/api/v1/auth/me') return json({ error: 'Sign in' }, 401);
      if (path === '/api/v1/auth/providers') return json({ providers: [] });
      if (path === '/api/v1/auth/login') return json({ error: 'Fixture sign-in response' }, 401);
      if (path === '/api/v1/events') return json({ events: [] });
      if (path === '/api/v1/translation-passes') return json({ required: false, available: false, plans: [], coins: [], orders: [] });
      if (path === '/api/state') return json({ revision: 1, tracks: [], trackCount: 0, playing: false, position: 0, bars: Array(24).fill(0), levels: [0, 0], silent: true });
      if (path === '/api/health') return json({ name: 'nixamp', version: 'fixture' });
      if (path === '/jingles/index.json') return json([]);
      if (path.startsWith('/api/')) return json({ error: 'Fixture endpoint unavailable' }, 404);
      const file = Bun.file(root + (path === '/' ? '/index.html' : path));
      return await file.exists() ? route.fulfill({ contentType: file.type, body: Buffer.from(await file.arrayBuffer()) }) : route.fulfill({ status: 404, body: '' });
    });
    await context.addInitScript(() => {
      localStorage.setItem('nixamp.captions.native-v2.language', 'sv');
      localStorage.setItem('nixamp.welcome', 'hidden');
      window.EventSource = class { close() {} addEventListener() {} removeEventListener() {} };
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const language = page.locator('[data-ui-language]');
    await page.waitForFunction(() => document.documentElement.lang === 'es' && document.querySelector('[data-ui-language]')?.options.length === 18);
    assert.equal(await language.inputValue(), 'es');
    assert.equal(await page.locator('[data-i18n="Interface language"]').textContent(), 'Idioma de la interfaz');
    await language.selectOption('de');
    await page.waitForFunction(() => document.documentElement.lang === 'de');
    assert.equal(await language.getAttribute('aria-label'), 'Sprache der Oberfläche');
    assert.equal(await page.evaluate(() => localStorage.getItem('nixamp.captions.native-v2.language')), 'sv');
    if (site === 'nixamp') {
      const contrast = await page.locator('#transcript-language').evaluate(select => {
        const luminance = color => {
          const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(value => { const v = Number(value) / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
          return .2126 * r + .7152 * g + .0722 * b;
        };
        return [select, select.options[0]].map(element => {
          const style = getComputedStyle(element), fg = luminance(style.color), bg = luminance(style.backgroundColor);
          return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
        });
      });
      assert.ok(contrast.every(ratio => ratio >= 4.5), `unreadable language select: ${contrast}`);
      const marker = await page.evaluate(() => {
        const field = document.querySelector('#filter'); field.value = 'Keep this draft'; field.focus({ preventScroll: true }); field.setSelectionRange(2, 5);
        const line = document.createElement('li'); line.textContent = 'Play'; document.querySelector('#transcript-list').append(line);
        return { scroll: scrollY, field: field.id };
      });
      // A preference update from another tab must not move focus/caret/scroll.
      await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'nixamp.ui.language', newValue: 'fr' })));
      await page.waitForFunction(() => document.documentElement.lang === 'fr');
      assert.deepEqual(await page.evaluate(() => ({ scroll: scrollY, field: document.activeElement.id })), marker);
      assert.deepEqual(await page.locator('#filter').evaluate(field => [field.value, field.selectionStart, field.selectionEnd]), ['Keep this draft', 2, 5]);
      assert.equal(await page.locator('#transcript-list li').last().textContent(), 'Play', 'user content must remain untouched');
      assert.equal(await page.locator('#play-pause').getAttribute('aria-label'), 'Lire');
    } else {
      await page.locator('#account-button').click();
      await page.locator('#account-form [name="email"]').fill('localization@example.test');
      await page.locator('#account-form [name="password"]').fill('Fixture-only-Password-123!');
      await page.locator('#account-form button[type="submit"]').click();
      await page.waitForFunction(() => document.querySelector('#account-error').textContent.length > 0);
      const login = requests.find(request => request.path === '/api/v1/auth/login');
      assert.ok(login, 'translated form did not submit');
      assert.deepEqual(JSON.parse(login.body), { email: 'localization@example.test', password: 'Fixture-only-Password-123!' });
      await page.locator('#account-dialog [data-close]').click();
    }
    await language.selectOption('ar');
    await page.waitForFunction(() => document.documentElement.dir === 'rtl');
    assert.equal(await language.inputValue(), 'ar');
    await page.setViewportSize({ width: 390, height: 844 });
    const rect = await language.boundingBox();
    assert.ok(rect.width > 20 && rect.x >= 0 && rect.x + rect.width <= 390, `${site}: language menu overflows mobile viewport`);
    await language.focus();
    await page.keyboard.press('Home'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.documentElement.lang === 'en' && document.documentElement.dir === 'ltr');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.lang === 'en' && document.querySelector('[data-ui-language]')?.value === 'en');
    assert.ok(!requests.some(request => /speech|translate/.test(request.path) && request.method === 'POST'), 'UI language called a translation provider');
    assert.deepEqual(errors, []);
    console.log('INTERFACE CHECK', site, 'system language, saved choice, contrast, RTL, mobile, keyboard, stable content');
    await context.close();
  }
} finally { await browser.close(); }
