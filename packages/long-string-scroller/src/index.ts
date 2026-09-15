/** A wrapped long string that pans with a fine mouse and stays touch-safe. */
export function attachLongStringScroller(viewport: HTMLElement, content: HTMLElement): void {
  viewport.classList.add("long-string-scroller");
  content.classList.add("long-string-scroller-content");
  content.title = content.textContent ?? "";
  let frame = 0;
  let lastX = 0;
  let releaseHeight: ReturnType<typeof setTimeout> | null = null;
  viewport.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "mouse") return;
    if (releaseHeight !== null) {
      clearTimeout(releaseHeight);
      releaseHeight = null;
    }
    // Switching to nowrap makes a wrapped path shorter. Hold the original
    // viewport height so the row never jumps while the pointer is moving.
    viewport.style.minHeight = `${viewport.getBoundingClientRect().height}px`;
    content.dataset["pan"] = "true";
  });
  viewport.addEventListener("pointermove", (event) => {
    if (content.dataset["pan"] !== "true") return;
    lastX = event.clientX;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const overflow = viewport.scrollWidth - viewport.clientWidth;
      if (overflow <= 0) return;
      const box = viewport.getBoundingClientRect();
      const raw = Math.max(0, Math.min(1, (lastX - box.left) / Math.max(1, box.width)));
      const eased = raw * raw * (3 - 2 * raw);
      content.style.setProperty("--path-shift", `${-overflow * eased}px`);
    });
  });
  viewport.addEventListener("pointerleave", () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    delete content.dataset["pan"];
    content.style.removeProperty("--path-shift");
    releaseHeight = setTimeout(() => {
      releaseHeight = null;
      viewport.style.removeProperty("min-height");
    }, 280);
  });
}
