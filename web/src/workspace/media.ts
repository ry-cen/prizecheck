import { useEffect, useState } from "react";

/** The workspace's mobile layout: the Location drawer, the details sheet and Select mode. */
export const MOBILE_QUERY = "(max-width: 760px)";

/** Whether a media query matches now; re-renders when that changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => window.matchMedia(query).matches
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
