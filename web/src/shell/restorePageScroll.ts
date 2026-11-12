/** How long a clamped position keeps being retried when no layout event announces the content arriving. */
export const RESTORE_WINDOW_MS = 5000;
export const RESTORE_POLL_MS = 100;

/** Guard a history position while content arrives; release it on interaction or after a bounded wait. */
export function restorePageScroll(
  container: HTMLElement | null | undefined,
  target: number
): () => void {
  // Anchoring late content can move the page again after scrollTo first reaches the target.
  // Keep the saved position authoritative only within the existing restore window.
  const root = document.documentElement;
  const previousAnchor = root.style.getPropertyValue("overflow-anchor");
  const previousAnchorPriority =
    root.style.getPropertyPriority("overflow-anchor");
  if (target !== 0)
    root.style.setProperty("overflow-anchor", "none", previousAnchorPriority);
  let stopped = false;
  let frame = 0;
  let observer: ResizeObserver | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  // Where the last restore left the page; a scroll that lands elsewhere was not ours.
  let left = window.scrollY;
  let attempted = false;
  // Geometry may grow again before a queued scroll event or retry sees the clamp.
  const observedEnds = new Set<number>();
  let lastEnd = Math.max(0, root.scrollHeight - root.clientHeight);
  const observedGrowth = new Set<number>();
  function observeEnd() {
    const end = Math.max(0, root.scrollHeight - root.clientHeight);
    if (end > lastEnd) observedGrowth.add(end - lastEnd);
    lastEnd = end;
    if (end < target) observedEnds.add(end);
  }
  const stop = () => {
    if (stopped) return;
    stopped = true;
    root.style.setProperty(
      "overflow-anchor",
      previousAnchor,
      previousAnchorPriority
    );
    observer?.disconnect();
    cancelAnimationFrame(frame);
    clearInterval(poll);
    window.removeEventListener("pointerdown", stop);
    window.removeEventListener("keydown", stop);
    window.removeEventListener("wheel", stop);
    window.removeEventListener("touchstart", stop);
    window.removeEventListener("scroll", foreign);
  };
  // Scrollbar drags, find-in-page and assistive scrolling fire no input event, so a scroll we did not cause counts
  // as the collector's unless it is the browser clamping to the page's end while content is still arriving, or
  // scroll anchoring carrying the view from where we left it up to the saved position. A scroll past the saved
  // position without evidence of being carried along the page end, or any other move, releases the restoration.
  function foreign() {
    observeEnd();
    const at = window.scrollY;
    if (at === left) return;
    // A shrink and growth with no rendering/observer delivery or other sample in between
    // leaves no clamp evidence; release an unexplained move just like an app scroll.
    const clamped =
      at < target &&
      [...observedEnds].some((end) => at >= end - 1 && at <= end);
    // Native layout movement can carry even a reached target by exactly the content's growth.
    // Geometry is required: an unrelated scroll past the target still releases ownership.
    const carried = at > left && observedGrowth.has(at - left);
    const toward =
      Math.sign(at - left) === Math.sign(target - left) &&
      Math.abs(at - left) <= Math.abs(target - left);
    if (clamped || carried || toward) left = at;
    else stop();
  }
  const restore = () => {
    frame = 0;
    if (stopped) return;
    observeEnd();
    // Scroll events are queued: a poll or resize callback may see a newer position first.
    if (attempted) foreign();
    if (stopped) return;
    attempted = true;
    if (window.scrollY !== target) {
      window.scrollTo(0, target);
      observedEnds.clear();
      observedGrowth.clear();
      observeEnd();
    }
    left = window.scrollY;
    observedGrowth.clear();
    if (target === 0 && left === target) stop();
  };
  restore();
  // Fresh top-of-page visits need no guard; nonzero history positions can still shift as content arrives.
  if (stopped) return stop;
  observer = new ResizeObserver(() => {
    if (stopped) return;
    observeEnd();
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(restore);
  });
  if (container) observer.observe(container);
  // In run 42882196433 the observer was seen to miss content growth after Back; why is unknown. A bounded retry
  // covers it.
  const until = Date.now() + RESTORE_WINDOW_MS;
  poll = setInterval(() => {
    if (Date.now() > until) stop();
    else restore();
  }, RESTORE_POLL_MS);
  window.addEventListener("pointerdown", stop, { once: true });
  window.addEventListener("keydown", stop, { once: true });
  window.addEventListener("wheel", stop, { once: true });
  window.addEventListener("touchstart", stop, { once: true });
  window.addEventListener("scroll", foreign, { passive: true });
  return stop;
}
