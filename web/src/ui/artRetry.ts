import { useEffect, useState } from "react";

/** Waits before the delayed retries of a picture that failed to load. The art route answers a temporary failure (a busy
 * queue, a fetch in backoff) with a 503 the page can't read from an <img>, and the same picture is usually served
 * moments later, so a failed picture is asked for again after these waits before the page gives up on it. */
export const ART_RETRY_DELAYS_MS = [1500, 5000];

export type ArtRetryState = {
  url: string | null;
  failed: number;
  retried: number;
};

/** "showing": the <img> is on the page. "waiting": a retry is due, and the page draws a blank art surface (no name, no
 * status text). "spent": the retries are used up and the page draws its stand-in for good. */
export type ArtPhase = "showing" | "waiting" | "spent";

export type ArtView = {
  phase: ArtPhase;
  attempt: number;
  delay: number | null;
};

const start = (url: string | null): ArtRetryState => ({
  url,
  failed: 0,
  retried: 0,
});

/** Where a picture stands. The first `immediate` failures retry at once; the delays above apply after them. A new
 * address starts over. `attempt` counts the failures so far: a page keys the <img> by it, or picks another address
 * for a try (`EditionArt` asks for the large file on its odd tries). */
export function artView(
  state: ArtRetryState,
  url: string | null,
  immediate: number
): ArtView {
  const { failed, retried } = state.url === url ? state : start(url);
  if (!url || failed > immediate + ART_RETRY_DELAYS_MS.length)
    return { phase: "spent", attempt: failed, delay: null };
  if (failed <= immediate || failed === retried)
    return { phase: "showing", attempt: failed, delay: null };
  return {
    phase: "waiting",
    attempt: failed,
    delay: ART_RETRY_DELAYS_MS[failed - immediate - 1],
  };
}

/** The state after the picture at `url` fails to load once more. */
export function artFailed(
  state: ArtRetryState,
  url: string | null
): ArtRetryState {
  const base = state.url === url ? state : start(url);
  return { ...base, failed: base.failed + 1 };
}

/** The state once the wait is over and the <img> is on the page again. */
export function artRetried(
  state: ArtRetryState,
  url: string | null
): ArtRetryState {
  const base = state.url === url ? state : start(url);
  return { ...base, retried: base.failed };
}

/** The retry state of one <img>; see `artView`. */
export function useArtRetry(
  url: string | null,
  immediate = 0
): {
  show: boolean;
  waiting: boolean;
  attempt: number;
  onError: () => void;
} {
  const [state, setState] = useState<ArtRetryState>(start(url));
  const view = artView(state, url, immediate);
  const { delay, attempt } = view;
  useEffect(() => {
    if (delay === null) return;
    const timer = setTimeout(
      () => setState((previous) => artRetried(previous, url)),
      delay
    );
    return () => clearTimeout(timer);
  }, [delay, url, attempt]);
  return {
    show: view.phase === "showing",
    waiting: view.phase === "waiting",
    attempt,
    onError: () => setState((previous) => artFailed(previous, url)),
  };
}
