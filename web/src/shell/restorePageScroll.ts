/** Retry a clamped history position as content arrives; release it on success or interaction. */
export function restorePageScroll(
  container: HTMLElement | null | undefined,
  target: number
): () => void {
  let stopped = false;
  let frame = 0;
  let observer: ResizeObserver | undefined;
  const stop = () => {
    stopped = true;
    observer?.disconnect();
    cancelAnimationFrame(frame);
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
  window.addEventListener("pointerdown", stop, { once: true });
  window.addEventListener("keydown", stop, { once: true });
  window.addEventListener("wheel", stop, { once: true });
  window.addEventListener("touchstart", stop, { once: true });
  return stop;
}
