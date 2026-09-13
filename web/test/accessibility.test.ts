import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replaceList } from '../src/accessibility.ts';

test('live list refreshes keep a focused control and apply only the newest update after focus leaves', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const control = {}, elsewhere = {}, doc = { activeElement: control };
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true });
  let leave: (() => void) | undefined;
  const replacements: unknown[][] = [];
  const list = {
    contains: (node: unknown) => node === control,
    replaceChildren: (...nodes: unknown[]) => replacements.push(nodes),
    addEventListener: (event: string, listener: () => void) => { assert.equal(event, 'focusout'); leave = listener; },
  } as unknown as HTMLElement;
  try {
    replaceList(list, 'first update'); replaceList(list, 'latest update');
    assert.equal(doc.activeElement, control); assert.equal(replacements.length, 0);
    doc.activeElement = elsewhere; leave?.(); await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(replacements, [['latest update']]); assert.equal(doc.activeElement, elsewhere);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('explicit list navigation replaces the focused page immediately without scrolling or applying stale deferred rows', async () => {
  const { beginListNavigation } = await import('../src/accessibility.ts');
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const control = {}, elsewhere = {}, doc = { activeElement: control as unknown };
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true });
  let leave: (() => void) | undefined;
  const replacements: unknown[][] = [], focuses: unknown[] = [];
  const list = {
    contains: (node: unknown) => node === control || node === list,
    replaceChildren: (...nodes: unknown[]) => replacements.push(nodes),
    focus: (options: unknown) => { focuses.push(options); doc.activeElement = list; },
    addEventListener: (_event: string, listener: () => void) => { leave = listener; },
  } as unknown as HTMLElement;
  try {
    replaceList(list, 'stale background update');
    beginListNavigation(list);
    replaceList(list, 'requested page');
    assert.deepEqual(replacements, [[], ['requested page']]);
    assert.deepEqual(focuses, [{ preventScroll: true }]);
    doc.activeElement = elsewhere; leave?.(); await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(replacements, [[], ['requested page']]);
    beginListNavigation(list); replaceList(list, 'another page');
    assert.equal(doc.activeElement, elsewhere, 'navigation must not grab focus from an unrelated field');
    assert.equal(focuses.length, 1);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
