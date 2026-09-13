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
