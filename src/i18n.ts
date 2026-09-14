import en from './locales/en.ts';
import { aliases } from './ui-aliases.ts';
import { uiLanguage, type UiLanguage } from './ui-languages.ts';
export { UI_LANGUAGES, UI_LANGUAGE_KEY, uiLanguage, preferredUiLanguage, terminalUiLanguage } from './ui-languages.ts';
export type { UiLanguage } from './ui-languages.ts';
export type Message = keyof typeof en;
export type Catalogue = Record<Message, string>;
const loaders = {
  en: async () => ({ default: en }),
  de: () => import('./locales/de.ts'), sv: () => import('./locales/sv.ts'),
  es: () => import('./locales/es.ts'), fr: () => import('./locales/fr.ts'),
  it: () => import('./locales/it.ts'), nl: () => import('./locales/nl.ts'),
  da: () => import('./locales/da.ts'), fi: () => import('./locales/fi.ts'),
  ru: () => import('./locales/ru.ts'), uk: () => import('./locales/uk.ts'),
  cs: () => import('./locales/cs.ts'), hu: () => import('./locales/hu.ts'),
  zh: () => import('./locales/zh.ts'), ar: () => import('./locales/ar.ts'),
  hi: () => import('./locales/hi.ts'), vi: () => import('./locales/vi.ts'),
  id: () => import('./locales/id.ts'),
} satisfies Record<UiLanguage, () => Promise<{ default: Catalogue }>>;
/** Independent instances prevent one server request from changing another's locale. */
export class I18n {
  private code: UiLanguage = 'en';
  get language(): UiLanguage { return this.code; }
  constructor(private readonly load = async (language: UiLanguage): Promise<Catalogue> => (await loaders[language]()).default) {}
  private messages: Catalogue = en;
  private revision = 0;
  private numberFormats = new Map<string, Intl.NumberFormat>();
  private dateFormats = new Map<string, Intl.DateTimeFormat>();
  private listeners = new Set<() => void>();
  async setLanguage(value: unknown): Promise<boolean> {
    const revision = ++this.revision;
    const language = uiLanguage(value);
    const catalogue = await this.load(language);
    if (revision !== this.revision) return false;
    this.code = language;
    this.messages = catalogue;
    this.numberFormats.clear(); this.dateFormats.clear();
    for (const changed of this.listeners) changed();
    return true;
  }
  onChange(changed: () => void): () => void {
    this.listeners.add(changed);
    return () => this.listeners.delete(changed);
  }
  text(source: string, values: Record<string, string | number> = {}): string {
    const key = (this.language !== 'en' && Object.hasOwn(aliases, source) ? aliases[source] : source) as Message;
    let translated = Object.hasOwn(this.messages, key) ? this.messages[key] : source;
    if (this.language !== 'en' && Object.hasOwn(aliases, source)) {
      translated = (source.match(/^[▶■●⤓]\s+/)?.[0] ?? '') + translated + (source.endsWith(' ✓') ? ' ✓' : '');
    }
    return translated.replace(/\{([\w]+)\}/g, (original, name: string) => Object.hasOwn(values, name) ? String(values[name]) : original);
  }
  number(value: number, options?: Intl.NumberFormatOptions): string {
    const key = JSON.stringify(options ?? {});
    let formatter = this.numberFormats.get(key);
    if (!formatter) {
      if (this.numberFormats.size >= 64) this.numberFormats.clear();
      formatter = new Intl.NumberFormat(this.language, options); this.numberFormats.set(key, formatter);
    }
    return formatter.format(value);
  }
  date(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
    const key = JSON.stringify(options ?? {});
    let formatter = this.dateFormats.get(key);
    if (!formatter) {
      if (this.dateFormats.size >= 64) this.dateFormats.clear();
      formatter = new Intl.DateTimeFormat(this.language, options); this.dateFormats.set(key, formatter);
    }
    return formatter.format(value);
  }
  get direction(): 'ltr' | 'rtl' { return this.language === 'ar' ? 'rtl' : 'ltr'; }
}
export const i18n = new I18n();
export const t = (source: string, values?: Record<string, string | number>): string => i18n.text(source, values);
