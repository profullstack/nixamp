/** A wrapped long string that pans with a fine mouse and stays touch-safe. */
export function attachLongStringScroller(viewport: HTMLElement, content: HTMLElement): void {
  content.title = content.textContent ?? "";
  viewport.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "mouse") content.dataset["pan"] = "true";
  });
  viewport.addEventListener("pointermove", (event) => {
    if (content.dataset["pan"] !== "true") return;
    const overflow = content.scrollWidth - viewport.clientWidth;
    if (overflow <= 0) return;
    const box = viewport.getBoundingClientRect();
    const raw = Math.max(0, Math.min(1, (event.clientX - box.left) / Math.max(1, box.width)));
    const eased = raw * raw * (3 - 2 * raw);
    content.style.setProperty("--path-shift", `${-overflow * eased}px`);
  });
  viewport.addEventListener("pointerleave", () => {
    delete content.dataset["pan"];
    content.style.removeProperty("--path-shift");
  });
}
