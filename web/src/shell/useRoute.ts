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

// Pages and nested command dialogs can independently own a leave boundary.
// Keep registrations separate so settling one never unregisters another.
type RegisteredGuard = { guard: LeaveGuard };
const guards: RegisteredGuard[] = [];
const blocking = (approved = new Set<RegisteredGuard>()) =>
  guards.some((entry) => !approved.has(entry) && entry.guard.blocks());

function askToLeave(
  leave: () => void,
  approved = new Set<RegisteredGuard>()
): void {
  const next = [...guards]
    .reverse()
    .find((entry) => !approved.has(entry) && entry.guard.blocks());
  if (!next) {
    leave();
    return;
  }
  next.guard.ask(() => {
    approved.add(next);
    // Recheck live authorities: another command may start while a collector
    // is answering a different surface's discard question.
    askToLeave(leave, approved);
  });
}

/** Registers this surface's guard while mounted; nested guards compose. */
export function useLeaveGuard(guard: LeaveGuard): void {
  useEffect(() => {
    const entry = { guard };
    guards.push(entry);
    return () => {
      const index = guards.indexOf(entry);
      if (index >= 0) guards.splice(index, 1);
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
 * agreeing calls `history.back()` once, which lands on the target in both directions. Only those registrations are
 * approved for that popstate; a new pending command must still answer before navigation.
 */
export function useRoute(): Route {
  const [path, setPath] = useState(() => window.location.pathname);
  const current = useRef(path);
  current.current = path;
  const scrolls = useRef(new Map<string, number>()).current;
  // Approval belongs to these exact registrations, never to an unconditional next popstate.
  const leaving = useRef<Set<RegisteredGuard> | null>(null);

  useEffect(() => {
    const onPopState = () => {
      const approved = leaving.current ?? new Set<RegisteredGuard>();
      leaving.current = null;
      if (blocking(approved) && window.location.pathname !== current.current) {
        window.history.pushState(null, "", current.current);
        askToLeave(() => {
          leaving.current = approved;
          window.history.back();
        }, approved);
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
        blocking() &&
        new URL(to, window.location.href).pathname !== current.current
      ) {
        askToLeave(go);
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
