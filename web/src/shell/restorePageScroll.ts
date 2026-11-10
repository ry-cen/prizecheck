/** How long a clamped position keeps being retried when no layout event announces the content arriving. */
export const RESTORE_WINDOW_MS = 5000;
export const RESTORE_POLL_MS = 100;

/** Retry a clamped history position as content arrives; release it on success, interaction or after a bounded wait. */
export function restorePageScroll(
  container: HTMLElement | null | undefined,
  target: number
): () => void {
  let stopped = false;
  let frame = 0;
  let observer: ResizeObserver | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  // Where the last restore left the page; a scroll that lands elsewhere was not ours.
  let left = window.scrollY;
  const stop = () => {
    stopped = true;
    observer?.disconnect();
    cancelAnimationFrame(frame);
    clearInterval(poll);
    window.removeEventListener("pointerdown", stop);
    window.removeEventListener("keydown", stop);
    window.removeEventListener("wheel", stop);
    window.removeEventListener("touchstart", stop);
    window.removeEventListener("scroll", foreign);
  };
  // Scrollbar drags, find-in-page and assistive scrolling fire no input event. Any scroll we did not cause
  // (including a clamp or scroll anchoring) releases the restoration, the cautious choice.
  function foreign() {
    if (window.scrollY !== left) stop();
  }
  const restore = () => {
    frame = 0;
    if (stopped) return;
    if (window.scrollY !== target) window.scrollTo(0, target);
    left = window.scrollY;
    if (left === target) stop();
  };
  restore();
  // First loads and already laid-out pages need no observer or input listeners.
  if (stopped) return stop;
  observer = new ResizeObserver(() => {
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
