/** Only explicitly marked application text is localized. Media, transcripts,
 * messages, form values and names are never sent through this layer. */
import { i18n, t, UI_LANGUAGES, UI_LANGUAGE_KEY, uiLanguage, preferredUiLanguage } from '../../src/i18n.ts';
export { i18n, t } from '../../src/i18n.ts';
const bindings = new Map<Node, Map<string, () => void>>();
function bind(node: Node, property: string, update: () => void): void {
  let properties = bindings.get(node);
  if (!properties) { properties = new Map(); bindings.set(node, properties); }
  properties.set(property, update);
  update();
}
export function uiText(element: Node, render: () => string | null | undefined): string {
  if (element instanceof Element) element.removeAttribute('data-i18n');
  let value = '';
  let written: string | undefined;
  bind(element, 'text', () => {
    // A later icon/template update owns the element; do not resurrect an old status.
    if (written !== undefined && element.textContent !== written) { bindings.get(element)?.delete('text'); return; }
    value = render() ?? '';
    written = value;
    if (element.textContent !== value) element.textContent = value;
  });
  return value;
}
export function uiAttribute(element: Element, name: string, render: () => string | undefined): string {
  element.removeAttribute(`data-i18n-${name}`);
  let value = '';
  let written: string | undefined;
  bind(element, name, () => {
    if (written !== undefined && element.getAttribute(name) !== written) { bindings.get(element)?.delete(name); return; }
    value = render() ?? '';
    written = value;
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  });
  return value;
}
const attributes = ['aria-label', 'title', 'placeholder', 'data-title'] as const;
const selector = ['[data-i18n]', ...attributes.map(name => `[data-i18n-${name}]`)].join(',');
function localize(root: ParentNode): void {
  const elements = [...root.querySelectorAll<HTMLElement>(selector)];
  if (root instanceof HTMLElement && root.matches(selector)) elements.unshift(root);
  for (const element of elements) {
    if (element.closest('[translate="no"], [contenteditable="true"]')) continue;
    const message = element.getAttribute('data-i18n');
    if (message) {
      let written = element.textContent;
      bind(element, 'text', () => {
        if (element.textContent !== written) { bindings.get(element)?.delete('text'); element.removeAttribute('data-i18n'); return; }
        written = t(message);
        if (element.textContent !== written) element.textContent = written;
      });
    }
    for (const name of attributes) {
      const message = element.getAttribute(`data-i18n-${name}`);
      if (message) {
        let written = element.getAttribute(name);
        bind(element, name, () => {
          if (element.getAttribute(name) !== written) { bindings.get(element)?.delete(name); element.removeAttribute(`data-i18n-${name}`); return; }
          written = t(message);
          if (element.getAttribute(name) !== written) element.setAttribute(name, written);
        });
      }
    }
  }
}
function applyLanguage(): void {
  document.documentElement.lang = i18n.language;
  document.documentElement.dir = i18n.direction;
  for (const [node, properties] of bindings) {
    if (!node.isConnected) { bindings.delete(node); continue; }
    for (const update of properties.values()) update();
  }
  for (const select of document.querySelectorAll<HTMLSelectElement>('[data-ui-language]')) select.value = i18n.language;
}
let change = 0;
export async function chooseUiLanguage(value: unknown): Promise<void> {
  const current = ++change;
  try {
    if (!await i18n.setLanguage(value) || current !== change) return;
    try { localStorage.setItem(UI_LANGUAGE_KEY, i18n.language); } catch { /* Private storage: use it for this page. */ }
    void window.nixampLanguage?.set(i18n.language).catch(() => {});
  } catch {
    // A failed lazy chunk keeps the previous language and the player running.
    applyLanguage();
  }
}
declare global {
  interface Window {
    nixampLanguage?: { get(): Promise<string>; set(code: string): Promise<void>; subscribe(listener: (code: string) => void): void };
  }
}
export async function installI18n(): Promise<void> {
  let saved = preferredUiLanguage(null, navigator.languages);
  try { saved = preferredUiLanguage(await window.nixampLanguage?.get() ?? localStorage.getItem(UI_LANGUAGE_KEY), navigator.languages); } catch { /* Use system preferences without storage. */ }
  for (const select of document.querySelectorAll<HTMLSelectElement>('[data-ui-language]')) {
    select.replaceChildren(...UI_LANGUAGES.map(language => {
      const option = new Option(language.label, language.code);
      option.lang = language.code; option.dir = 'auto'; return option;
    }));
    select.addEventListener('change', () => { void chooseUiLanguage(select.value); });
  }
  localize(document);
  applyLanguage();
  i18n.onChange(applyLanguage);
  // New templates carry explicit markers. Never inspect or rewrite live content.
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node instanceof Element) localize(node);
    }
    // Dynamic lists may retire bound nodes without another language change.
    for (const node of bindings.keys()) if (!node.isConnected) bindings.delete(node);
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('storage', event => { if (event.key === UI_LANGUAGE_KEY) void i18n.setLanguage(preferredUiLanguage(event.newValue, navigator.languages)).catch(() => {}); });
  window.nixampLanguage?.subscribe(code => { if (code !== i18n.language) void i18n.setLanguage(code).catch(() => {}); });
  // Playback starts immediately; a slow language file never blocks the player.
  try { await i18n.setLanguage(saved); } catch { /* Keep the working English UI. */ }
}
