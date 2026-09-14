/** The UI and audio-translation menus share the same supported targets. */
export const UI_LANGUAGES = [
  { code: 'en', label: 'English' }, { code: 'de', label: 'Deutsch' },
  { code: 'sv', label: 'Svenska' }, { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' }, { code: 'it', label: 'Italiano' },
  { code: 'nl', label: 'Nederlands' }, { code: 'da', label: 'Dansk' },
  { code: 'fi', label: 'Suomi' }, { code: 'ru', label: 'Русский' },
  { code: 'uk', label: 'Українська' }, { code: 'cs', label: 'Čeština' },
  { code: 'hu', label: 'Magyar' }, { code: 'zh', label: '中文' },
  { code: 'ar', label: 'العربية' }, { code: 'hi', label: 'हिन्दी' },
  { code: 'vi', label: 'Tiếng Việt' }, { code: 'id', label: 'Bahasa Indonesia' },
] as const;
export type UiLanguage = typeof UI_LANGUAGES[number]['code'];
export const UI_LANGUAGE_KEY = 'nixamp.ui.language';
export function uiLanguage(value: unknown): UiLanguage {
  const code = typeof value === 'string' ? value.trim().toLowerCase().split(/[-_.@]/)[0] : '';
  return UI_LANGUAGES.find(language => language.code === code)?.code ?? 'en';
}
/** A saved choice wins; otherwise use the first supported system preference. */
export function preferredUiLanguage(saved: unknown, system: readonly unknown[] = []): UiLanguage {
  const match = (value: unknown): UiLanguage | undefined => {
    const code = typeof value === 'string' ? value.trim().toLowerCase().split(/[-_.@]/)[0] : '';
    return UI_LANGUAGES.find(language => language.code === code)?.code;
  };
  return match(saved) ?? system.map(match).find(Boolean) ?? 'en';
}
export function terminalUiLanguage(env: Record<string, string | undefined>): UiLanguage {
  if (env['NIXAMP_UI_LANGUAGE']) return uiLanguage(env['NIXAMP_UI_LANGUAGE']);
  if (env['LC_ALL']) return preferredUiLanguage(null, [env['LC_ALL']]);
  return preferredUiLanguage(null, env['LANGUAGE']?.split(':') ?? [env['LC_MESSAGES'] || env['LANG']]);
}
