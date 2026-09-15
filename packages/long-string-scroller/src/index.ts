/** A wrapped long string that pans with a fine mouse and stays touch-safe. */
export function attachLongStringScroller(viewport: HTMLElement, content: HTMLElement): void {
  viewport.classList.add("long-string-scroller");
  content.classList.add("long-string-scroller-content");
  content.title = content.textContent ?? "";
  let frame = 0;
  let lastX = 0;
  viewport.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "mouse") content.dataset["pan"] = "true";
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
  });
}
