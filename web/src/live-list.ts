/** Update independent live rows without retiring the control being used.
 * A focused row can wait; newly started parties and other servers cannot. */
const pending = new WeakMap<HTMLElement, HTMLElement[]>();
const listening = new WeakSet<HTMLElement>();

export function updateLiveList(list: HTMLElement, rows: HTMLElement[]): void {
  const previous = new Map([...list.children].map(node => [(node as HTMLElement).dataset['liveKey'], node]));
  const wanted = new Set(rows.map(row => row.dataset['liveKey']));
  let deferred = false;
  for (const row of rows) {
    const old = previous.get(row.dataset['liveKey']);
    if (!old) list.append(row);
    else if (old !== row && !old.isEqualNode(row)) {
      if (old.contains(document.activeElement) || old.querySelector('details[open]')) deferred = true;
      else old.replaceWith(row);
    }
  }
  for (const [key, old] of previous) {
    if (wanted.has(key)) continue;
    if (old.contains(document.activeElement)) deferred = true;
    else old.remove();
  }
  if (deferred) pending.set(list, rows);
  else pending.delete(list);
  if (listening.has(list)) return;
  listening.add(list);
  const flush = (): void => {
    const latest = pending.get(list);
    if (latest) updateLiveList(list, latest);
  };
  list.addEventListener('focusout', () => { setTimeout(flush, 0); });
  list.addEventListener('toggle', flush, true);
}
