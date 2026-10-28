import { useState } from "react";
import { largeArtUrl } from "./artRoute";

/**
 * The artwork for a large card view (a card popup, Collection's inspector). Collection, Deck and Friend reads send
 * the gallery's small artwork (the art route's `small` size); a large view asks for the same card's `large` size
 * instead, falls back to the small one if that fails, and reports `src: null` once both have failed or there is none.
 * An address that isn't an art-route small address is used as it is. Failures count per address, so a new card
 * starts from its large artwork in the same render.
 */
export function useLargeArt(
  url: string | null,
  largeUrl?: string | null
): {
  src: string | null;
  onError: () => void;
} {
  const [failure, setFailure] = useState({ url, count: 0 });
  const attempt = failure.url === url ? failure.count : 0;
  const large = largeUrl ?? (url ? largeArtUrl(url) : null);
  const sources = large ? [large, url] : [url];
  return {
    src: sources[attempt] ?? null,
    onError: () =>
      setFailure((current) => ({
        url,
        count: (current.url === url ? current.count : 0) + 1,
      })),
  };
}
