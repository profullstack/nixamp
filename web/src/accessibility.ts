/** Operational announcements are separate from visual updates. Never announce
 * every frame, steal focus, or flood a screen reader with incoming transcripts. */
export function installAccessibility(): void {
  const output = document.getElementById("sr-status");
  if (!output) return;
  const ids = ["note", "account-note", "remote-state", "transcript-audio-note", "notify-note", "notify-phone-note", "persona-note"];
  const last = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = "";
  for (const id of ids) {
    const element = document.getElementById(id);
    if (!element) continue;
    last.set(id, element.textContent?.trim() ?? "");
    new MutationObserver(() => {
      const text = element.textContent?.trim() ?? "";
      if (last.get(id) === text) return;
      last.set(id, text);
      if (!text || element.closest("[hidden], [data-closed], [data-collapsed]")) return;
      pending = text;
      clearTimeout(timer);
      timer = setTimeout(() => { if (output.textContent !== pending) output.textContent = pending; }, 200);
    }).observe(element, { childList: true, characterData: true, subtree: true });
  }
}

const deferred = new WeakMap<HTMLElement, (Node | string)[]>();
/** Polling must not remove the control someone is using. Keep the latest
 * replacement until focus leaves the list, without moving focus ourselves. */
export function replaceList(element: HTMLElement, ...children: (Node | string)[]): void {
  if (!element.contains(document.activeElement)) { deferred.delete(element); element.replaceChildren(...children); return; }
  const waiting = deferred.has(element);
  deferred.set(element, children);
  if (waiting) return;
  const commit = (): void => {
    const latest = deferred.get(element);
    if (!latest) return;
    if (element.contains(document.activeElement)) { element.addEventListener("focusout", leave, { once: true }); return; }
    deferred.delete(element); element.replaceChildren(...latest);
  };
  const leave = (): void => { setTimeout(commit, 0); };
  element.addEventListener("focusout", leave, { once: true });
}
