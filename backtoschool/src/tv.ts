import { isTelevision } from "../../web/src/tv.ts";

export function isTv(): boolean {
  return /BackToSchoolFireTV/i.test(navigator.userAgent) || isTelevision(navigator.userAgent, location.search, navigator.maxTouchPoints);
}

/** The app owns focus, including the player. Only a remote press moves it. */
export function installTvNavigation(): void {
  if (!isTv()) return;
  document.documentElement.classList.add("tv");
  document.addEventListener("keydown", event => {
    if (!event.key.startsWith("Arrow") || event.altKey || event.ctrlKey || event.metaKey) return;
    const active = document.activeElement as HTMLElement | null;
    if (active?.matches("input, textarea, select, [contenteditable=true]")) return;
    const scope = document.querySelector("dialog[open]") ?? document.querySelector(".classroom-player.is-expanded") ?? document;
    const targets = [...scope.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex='0']")]
      .filter(el => el.getClientRects().length && !el.closest("[hidden], [inert]") && getComputedStyle(el).visibility !== "hidden");
    const origin = active?.getBoundingClientRect();
    let next: HTMLElement | undefined;
    if (!origin || !targets.includes(active!)) next = targets[0];
    else {
      const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
      const sign = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
      let best = Infinity;
      for (const el of targets) {
        if (el === active) continue;
        const r = el.getBoundingClientRect();
        const dx = (r.left + r.right - origin.left - origin.right) / 2;
        const dy = (r.top + r.bottom - origin.top - origin.bottom) / 2;
        const forward = sign * (horizontal ? dx : dy);
        const across = Math.abs(horizontal ? dy : dx);
        if (forward <= 1) continue;
        const score = forward + across * 3;
        if (score < best) { best = score; next = el; }
      }
    }
    event.preventDefault();
    if (next) { next.focus({ preventScroll: true }); next.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" }); }
  });
}
