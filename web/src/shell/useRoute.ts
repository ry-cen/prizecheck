import { useCallback, useEffect, useRef, useState } from "react";

export type Route = {
  /** The address bar's path. */
  path: string;
  /** Pushes (or replaces) an address and shows it, without a page load. */
  navigate: (to: string, options?: { replace?: boolean }) => void;
  /** The window scroll position the page at `path` had when it was last left, or 0. */
  scrollFor: (path: string) => number;
};

/** Client-side routing on the History API. Each change records the scroll position of the page being
 * left first, so a kept-mounted page can be shown again where it was (the shell restores it). */
export function useRoute(): Route {
  const [path, setPath] = useState(() => window.location.pathname);
  const current = useRef(path);
  current.current = path;
  const scrolls = useRef(new Map<string, number>()).current;

  useEffect(() => {
    const onPopState = () => {
      scrolls.set(current.current, window.scrollY);
      setPath(window.location.pathname);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [scrolls]);

  const navigate = useCallback(
    (to: string, { replace = false }: { replace?: boolean } = {}) => {
      scrolls.set(current.current, window.scrollY);
      if (replace) window.history.replaceState(null, "", to);
      else window.history.pushState(null, "", to);
      setPath(window.location.pathname);
    },
    [scrolls]
  );
  const scrollFor = useCallback(
    (at: string) => scrolls.get(at) ?? 0,
    [scrolls]
  );
  return { path, navigate, scrollFor };
}
