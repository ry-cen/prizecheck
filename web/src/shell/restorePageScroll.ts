/** How long a clamped position keeps being retried when no layout event announces the content arriving. */
export const RESTORE_WINDOW_MS = 5000;
export const RESTORE_POLL_MS = 100;

/** Guard a history position while content arrives; release it on interaction or after a bounded wait. */
export function restorePageScroll(
  container: HTMLElement | null | undefined,
  target: number
): () => void {
  // Suppress anchoring while restoration owns the page, including late content above the viewport.
  const root = document.documentElement;
  const body = document.body;
  const previousBodyAnchor = body?.style.getPropertyValue("overflow-anchor");
  const previousBodyAnchorPriority =
    body?.style.getPropertyPriority("overflow-anchor");
  const previousAnchor = root.style.getPropertyValue("overflow-anchor");
  const previousAnchorPriority =
    root.style.getPropertyPriority("overflow-anchor");
  if (target !== 0) {
    root.style.setProperty("overflow-anchor", "none", previousAnchorPriority);
    body?.style.setProperty(
      "overflow-anchor",
      "none",
      previousBodyAnchorPriority
    );
  }
  let stopped = false;
  let frame = 0;
  let observer: ResizeObserver | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  // Where the last restore left the page; a scroll that lands elsewhere was not ours.
  let left = window.scrollY;
  let attempted = false;
  // Geometry may grow again before a queued scroll event or retry sees the clamp.
  const ends = new Set<number>();
  function observeEnd() {
    const end = Math.max(0, root.scrollHeight - root.clientHeight);
    if (end < target) ends.add(end);
  }
  const stop = () => {
    if (stopped) return;
    stopped = true;
    root.style.setProperty(
      "overflow-anchor",
      previousAnchor,
      previousAnchorPriority
    );
    body?.style.setProperty(
      "overflow-anchor",
      previousBodyAnchor ?? "",
      previousBodyAnchorPriority
    );
    observer?.disconnect();
    cancelAnimationFrame(frame);
    clearInterval(poll);
    window.removeEventListener("pointerdown", stop);
    window.removeEventListener("keydown", stop);
    window.removeEventListener("wheel", stop);
    window.removeEventListener("touchstart", stop);
    window.removeEventListener("scroll", reconcile);
  };
  function isClamp(at: number) {
    return (
      at < left &&
      at < target &&
      [...ends].some((end) => at >= end - 1 && at <= end)
    );
  }
  // Ownership continues only for our write's echo or an observed shrink clamp; every other movement releases it.
  // A collector's scroll landing exactly on an observed short end before the next tick is indistinguishable
  // from a clamp, and is accepted by design.
  function reconcile() {
    observeEnd();
    const at = window.scrollY;
    if (at === left) return;
    if (isClamp(at)) left = at;
    else stop();
  }
  const restore = () => {
    frame = 0;
    if (stopped) return;
    observeEnd();
    // Scroll events are queued: a poll or resize callback may see a newer position first.
    if (attempted) reconcile();
    if (stopped) return;
    attempted = true;
    if (window.scrollY !== target) {
      window.scrollTo(0, target);
    }
    ends.clear();
    left = window.scrollY;
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
  // A page that is still reading its data (a remounted detail page) says so with `data-page-loading` or a loading
  // heading, so the wait does not run out before the content has arrived: the window counts from when loading
  // ends. A visible marker only; a hidden or inert subtree is not the page being shown.
  const loading = () =>
    [
      ...(container?.querySelectorAll(
        '[data-page-loading], h1[data-page-heading="loading"]'
      ) ?? []),
    ].some((element) => !element.closest("[hidden],[inert]"));
  // In run 42882196433 the observer was seen to miss content growth after Back; why is unknown. A bounded retry
  // covers it.
  let until = Date.now() + RESTORE_WINDOW_MS;
  poll = setInterval(() => {
    if (loading()) until = Date.now() + RESTORE_WINDOW_MS;
    if (Date.now() > until) stop();
    else restore();
  }, RESTORE_POLL_MS);
  window.addEventListener("pointerdown", stop, { once: true });
  window.addEventListener("keydown", stop, { once: true });
  window.addEventListener("wheel", stop, { once: true });
  window.addEventListener("touchstart", stop, { once: true });
  window.addEventListener("scroll", reconcile, { passive: true });
  return stop;
}
