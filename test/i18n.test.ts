import { test } from 'node:test';
import assert from 'node:assert/strict';
import { I18n, UI_LANGUAGES, preferredUiLanguage, terminalUiLanguage, type Catalogue } from '../src/i18n.ts';
import en from '../src/locales/en.ts';
import { LANGUAGE_CHOICES, CAPTIONS_LANGUAGE_KEY, captionsLanguage } from '../web/src/captions.ts';

test('UI targets match audio targets; system preferences select a supported language with English fallback', () => {
  assert.deepEqual(UI_LANGUAGES.map(language => language.code), LANGUAGE_CHOICES.filter(language => language.code).map(language => language.code));
  assert.equal(preferredUiLanguage(null, ['es-MX', 'en-US']), 'es');
  assert.equal(preferredUiLanguage(null, ['ja-JP', 'de-DE']), 'de');
  assert.equal(preferredUiLanguage(null, ['ja-JP']), 'en');
  assert.equal(preferredUiLanguage(null, []), 'en');
  assert.equal(preferredUiLanguage('en', ['de-DE']), 'en', 'explicit English overrides the system');
  assert.equal(preferredUiLanguage('fr', ['es-ES']), 'fr');
  assert.equal(preferredUiLanguage('garbage', ['de-DE']), 'de');
  assert.equal(terminalUiLanguage({ LANG: 'de_DE.UTF-8' }), 'de');
  assert.equal(terminalUiLanguage({ LANGUAGE: 'ja:uk:en', LANG: 'de_DE.UTF-8' }), 'uk');
  assert.equal(terminalUiLanguage({ LC_ALL: 'fr_FR.UTF-8', LANG: 'de_DE.UTF-8' }), 'fr');
  assert.equal(terminalUiLanguage({ NIXAMP_UI_LANGUAGE: 'en', LANG: 'de_DE.UTF-8' }), 'en');
  assert.equal(terminalUiLanguage({ LANG: 'C.UTF-8' }), 'en');
  assert.equal(terminalUiLanguage({ LC_ALL: 'C', LANGUAGE: 'es', LANG: 'de_DE.UTF-8' }), 'en');
});

test('all 18 catalogs contain every shared control and preserve placeholders', async () => {
  const baseline = Object.keys(en).sort();
  for (const language of UI_LANGUAGES) {
    const { default: catalogue } = await import(`../src/locales/${language.code}.ts`) as { default: Catalogue };
    assert.deepEqual(Object.keys(catalogue).sort(), baseline, language.code);
    for (const [key, value] of Object.entries(catalogue)) {
      assert.ok(value.trim(), `${language.code}: ${key}`);
      assert.deepEqual(value.match(/\{\w+\}/g), key.match(/\{\w+\}/g), `${language.code}: ${key}`);
    }
    const locale = new I18n();
    await locale.setLanguage(language.code);
    assert.equal(locale.text('Play'), catalogue.Play);
    assert.equal(locale.direction, language.code === 'ar' ? 'rtl' : 'ltr');
  }
});

test('locale formats display amounts and dates without changing caption-language preferences', async () => {
  const locale = new I18n();
  const date = new Date('2026-09-14T10:00:00Z');
  await locale.setLanguage('de');
  assert.equal(locale.number(1234.5), '1.234,5');
  assert.equal(locale.date(date, { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }), '14.09.2026');
  assert.equal(locale.number(12.5, { style: 'currency', currency: 'USD' }), new Intl.NumberFormat('de', { style: 'currency', currency: 'USD' }).format(12.5));
  assert.equal(captionsLanguage(key => key === CAPTIONS_LANGUAGE_KEY ? 'sv' : null), 'sv');
  assert.equal(locale.text('Missing message {name}', { name: '<script>$&</script>' }), 'Missing message <script>$&</script>');
  assert.equal(locale.text('toString'), 'toString');
  await locale.setLanguage('xx');
  assert.equal(locale.text('Play'), 'Play');
});

test('the last language choice wins; a failed load preserves the working language', async () => {
  let complete: ((catalogue: Catalogue) => void) | undefined;
  const locale = new I18n(language => language === 'de' ? new Promise(resolve => { complete = resolve; }) : language === 'fr' ? Promise.reject(new Error('offline')) : Promise.resolve(en));
  const first = locale.setLanguage('de');
  await locale.setLanguage('en');
  complete!(en);
  assert.equal(await first, false);
  assert.equal(locale.language, 'en');
  await assert.rejects(locale.setLanguage('fr'), /offline/);
  assert.equal(locale.language, 'en');
});

test('independent translator instances do not leak another interface or account language', async () => {
  const first = new I18n(), second = new I18n();
  await first.setLanguage('de'); await second.setLanguage('es');
  assert.equal(first.text('Play'), 'Abspielen'); assert.equal(second.text('Play'), 'Reproducir');
  await first.setLanguage('ar');
  assert.equal(first.direction, 'rtl'); assert.equal(second.direction, 'ltr');
});

test('the terminal uses translated controls and leaves track titles untouched', async () => {
  const { i18n } = await import('../src/i18n.ts');
  const { renderToText } = await import('@profullstack/hqtui');
  const { createState, view } = await import('../src/main.ts');
  try {
    await i18n.setLanguage('de');
    const state = createState([{ path: '/fixture.mp3', title: 'Play', artist: '', album: '', duration: 60 }], '/fixtures', false);
    const screen = renderToText(args => view(args, state), { width: 120, height: 30 });
    assert.match(screen, /Aktuelle Wiedergabe/);
    assert.match(screen, /Abspielen/);
    assert.match(screen, /Play/);
  } finally { await i18n.setLanguage('en'); }
});
