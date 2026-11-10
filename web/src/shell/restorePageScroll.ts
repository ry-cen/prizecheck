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
  const stop = () => {
    stopped = true;
    observer?.disconnect();
    cancelAnimationFrame(frame);
    clearInterval(poll);
    window.removeEventListener("pointerdown", stop);
    window.removeEventListener("keydown", stop);
    window.removeEventListener("wheel", stop);
    window.removeEventListener("touchstart", stop);
  };
  const restore = () => {
    frame = 0;
    if (stopped) return;
    if (window.scrollY !== target) window.scrollTo(0, target);
    if (window.scrollY === target) stop();
  };
  restore();
  // First loads and already laid-out pages need no observer or input listeners.
  if (stopped) return stop;
  observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(restore);
  });
  if (container) observer.observe(container);
  // Layout that grows without resizing the observed page (late rows, a sibling above) still gets its retry.
  const until = Date.now() + RESTORE_WINDOW_MS;
  poll = setInterval(() => {
    if (Date.now() > until) stop();
    else restore();
  }, RESTORE_POLL_MS);
  window.addEventListener("pointerdown", stop, { once: true });
  window.addEventListener("keydown", stop, { once: true });
  window.addEventListener("wheel", stop, { once: true });
  window.addEventListener("touchstart", stop, { once: true });
  return stop;
}
