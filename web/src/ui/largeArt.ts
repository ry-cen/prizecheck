import { largeArtUrl } from "./artRoute";
import { useArtRetry } from "./artRetry";

/**
 * The artwork for a large card view (a card popup, Collection's inspector). Collection, Deck and Friend reads send
 * the gallery's small artwork (the art route's `small` size); a large view asks for the same card's `large` size
 * instead and falls back to the small one if that fails. When both have failed it retries after a short wait, as a
 * tile does (artRetry.ts). It reports `src: null` while it waits (`waiting` is then true), once the retries are spent or
 * when there is no artwork. An address that isn't an art-route small address is used as it is. Failures count per address, so a new card
 * starts from its large artwork in the same render.
 */
export function useLargeArt(
  url: string | null,
  largeUrl?: string | null
): {
  src: string | null;
  /** A retry is due: draw a blank art surface, with no status text. */
  waiting: boolean;
  onError: () => void;
} {
  const large = largeUrl ?? (url ? largeArtUrl(url) : null);
  const sources = large ? [large, url] : [url];
  // The first failure of a large view moves to the small artwork at once; the rest wait.
  const art = useArtRetry(url ?? large, large ? 1 : 0);
  return {
    src: art.show ? (sources[art.attempt % sources.length] ?? null) : null,
    waiting: art.waiting,
    onError: art.onError,
  };
}
