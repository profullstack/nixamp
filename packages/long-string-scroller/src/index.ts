/** A wrapped long string that pans with a fine mouse and stays touch-safe. */
export function attachLongStringScroller(viewport: HTMLElement, content: HTMLElement): void {
  if (viewport.dataset.longStringScroller === "true") return;
  viewport.dataset.longStringScroller = "true";
  viewport.classList.add("long-string-scroller");
  content.classList.add("long-string-scroller-content");
  content.title = content.textContent ?? "";
  let frame = 0;
  let target = 0;
  let position = 0;
  let returning = false;
  let releaseHeight: ReturnType<typeof setTimeout> | null = null;
  const animate = (): void => {
    frame = 0;
    const next = matchMedia("(prefers-reduced-motion: reduce)").matches ? target : position + (target - position) * 0.22;
    position = Math.abs(target - next) < 0.5 ? target : next;
    content.style.setProperty("--path-shift", `${position}px`);
    if (Math.abs(target - position) >= 0.5) {
      frame = requestAnimationFrame(animate);
      return;
    }
    if (returning) {
      returning = false;
      delete content.dataset["pan"];
      content.style.removeProperty("--path-shift");
      releaseHeight = setTimeout(() => {
        releaseHeight = null;
        viewport.style.removeProperty("min-height");
      }, 280);
    }
  };
  const wake = (): void => {
    if (!frame) frame = requestAnimationFrame(animate);
  };
  viewport.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "mouse" || !matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (releaseHeight !== null) {
      clearTimeout(releaseHeight);
      releaseHeight = null;
    }
    // Switching to nowrap makes a wrapped path shorter. Hold the original
    // viewport height so the row never jumps while the pointer is moving.
    viewport.style.minHeight = `${viewport.getBoundingClientRect().height}px`;
    returning = false;
    content.dataset["pan"] = "true";
  });
  viewport.addEventListener("pointermove", (event) => {
    if (content.dataset["pan"] !== "true") return;
    const style = getComputedStyle(viewport);
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    // The viewport's scrollWidth includes the transformed child and changes
    // while panning. Measure the untransformed content against the text area.
    const overflow = Math.max(0, content.scrollWidth - (viewport.clientWidth - padding));
    if (overflow <= 0) return;
    const box = viewport.getBoundingClientRect();
    const raw = Math.max(0, Math.min(1, (event.clientX - box.left) / Math.max(1, box.width)));
    // Reserve a small edge band for the physical limits of a mouse: the
    // pointer rarely lands on the exact last pixel, but the string must still
    // reach both ends. Smoothstep gives the acceleration/deceleration curve in
    // the usable middle.
    if (raw <= 0.02) target = 0;
    else if (raw >= 0.98) target = -overflow;
    else {
      const eased = raw * raw * (3 - 2 * raw);
      target = -overflow * eased;
    }
    wake();
  });
  viewport.addEventListener("pointerleave", () => {
    target = 0;
    returning = true;
    wake();
  });
}
