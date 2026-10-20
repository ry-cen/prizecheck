import { useCallback, useEffect, useRef, useState } from "react";

export type Route = {
  /** The address bar's path. */
  path: string;
  /** Pushes (or replaces) an address and shows it, without a page load. An open leave guard that blocks asks first;
   * `force` skips it, for sign-out. */
  navigate: (
    to: string,
    options?: { replace?: boolean; force?: boolean }
  ) => void;
  /** The window scroll position the page at `path` had when it was last left, or 0. */
  scrollFor: (path: string) => number;
};

/** A page that can't be left without asking (the proposal builder, Trading #284). */
export type LeaveGuard = {
  /** Whether leaving now would lose something, so it must ask. */
  blocks: () => boolean;
  /** Asks the collector; `leave` completes the navigation that was asked for. */
  ask: (leave: () => void) => void;
};

// One router per tab, so one guard at a time.
let active: LeaveGuard | null = null;

/** Registers `guard` while the calling page is mounted. */
export function useLeaveGuard(guard: LeaveGuard): void {
  useEffect(() => {
    active = guard;
    return () => {
      if (active === guard) active = null;
    };
  }, [guard]);
}

/**
 * Client-side routing on the History API. Each change records the scroll position of the page being left first, so a
 * kept-mounted page can be shown again where it was (the shell restores it).
 *
 * A leave guard (`useLeaveGuard`) can hold a page in place. Two paths reach it. `navigate` is every in-app address
 * change: when the guard blocks and the target is another path, it asks and runs the change only if the collector
 * agrees. Browser Back and Forward arrive in `onPopState` after the browser has already moved: the guard's entry is
 * pushed back on top (which drops the entry Back left and, for Forward, sits after the target), then it asks, and
 * agreeing calls `history.back()` once, which lands on the target in both directions. That one popstate is let through
 * unasked.
 */
export function useRoute(): Route {
  const [path, setPath] = useState(() => window.location.pathname);
  const current = useRef(path);
  current.current = path;
  const scrolls = useRef(new Map<string, number>()).current;
  // Set when a guarded Back or Forward was agreed to: the popstate that history.back() raises is let through.
  const leaving = useRef(false);

  useEffect(() => {
    const onPopState = () => {
      if (leaving.current) leaving.current = false;
      else if (
        active?.blocks() &&
        window.location.pathname !== current.current
      ) {
        window.history.pushState(null, "", current.current);
        const guard = active;
        guard.ask(() => {
          leaving.current = true;
          window.history.back();
        });
        return;
      }
      scrolls.set(current.current, window.scrollY);
      setPath(window.location.pathname);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [scrolls]);

  const navigate = useCallback(
    (
      to: string,
      {
        replace = false,
        force = false,
      }: { replace?: boolean; force?: boolean } = {}
    ) => {
      const go = () => {
        scrolls.set(current.current, window.scrollY);
        if (replace) window.history.replaceState(null, "", to);
        else window.history.pushState(null, "", to);
        setPath(window.location.pathname);
      };
      if (
        !force &&
        active?.blocks() &&
        new URL(to, window.location.href).pathname !== current.current
      ) {
        active.ask(go);
        return;
      }
      go();
    },
    [scrolls]
  );
  const scrollFor = useCallback(
    (at: string) => scrolls.get(at) ?? 0,
    [scrolls]
  );
  return { path, navigate, scrollFor };
}
