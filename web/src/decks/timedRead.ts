export const READ_TIMEOUT_MS = 3_500;

/** Sends one read now, with its own deadline counted from now. `parent` aborting (supersede, unmount) cancels it.
 *  Settles at abort or deadline even if the reader ignores its signal. */
export function timedRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
  timeoutMs = READ_TIMEOUT_MS
): Promise<T> {
  if (parent?.aborted) return Promise.reject(parent.reason);
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason);
  let stop!: (reason: unknown) => void;
  const stopped = new Promise<never>((_, reject) => (stop = reject));
  const onAbort = () => stop(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  parent?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("Read timed out")),
    timeoutMs
  );
  // new Promise turns a synchronous throw from `read` into a rejection, so cleanup always runs.
  const sent = new Promise<T>((resolve) => resolve(read(controller.signal)));
  return Promise.race([sent, stopped]).finally(() => {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
  });
}
