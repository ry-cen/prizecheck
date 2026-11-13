import { useCallback, useEffect, useRef, useState } from "react";
import { PAGES, opensPage, isViewAddress } from "./routes";
import {
  saveFocus,
  createPageEntryFocus,
  type PageEntryFocus,
  type SavedFocus,
  type PageFocus,
} from "./restorePageFocus";

/** Session-only history positions: keep recent entries without growing with every navigation. */
const SCROLL_CACHE_LIMIT = 128;
function save<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > SCROLL_CACHE_LIMIT)
    cache.delete(cache.keys().next().value!);
}

export type Route = {
  /** The address bar's path. */
  path: string;
  /** Full path and query; query-only navigation also rerenders consumers. */
  address: string;
  /** Identity of the current browser history entry. */
  entry: string;
  /** Pushes (or replaces) an address and shows it, without a page load. An open leave guard that blocks asks first;
   * `force` skips it, for sign-out. */
  navigate: (
    to: string,
    options?: {
      replace?: boolean;
      force?: boolean;
      preserveScroll?: boolean;
      overlay?: boolean;
    }
  ) => void;
  /** Closes a pushed overlay by going back one entry, or replaces a directly opened overlay address. Closing the
   * same pushed entry again before its Back lands (a double tap, then Escape) goes back only once. */
  closeOverlay: (to: string) => void;
  /** The current entry's saved scroll, with a last-visited fallback for tab roots. */
  scrollFor: (path: string) => number;
  /** The entry's heading request, or the saved opener for a history traversal. */
  focusFor: () => PageFocus | null;
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
  const addressAt = () => window.location.pathname + window.location.search;
  const entryAt = () => {
    if (!window.history.state?.prizecheckEntry)
      window.history.replaceState(
        { ...window.history.state, prizecheckEntry: crypto.randomUUID() },
        ""
      );
    return window.history.state.prizecheckEntry as string;
  };
  const [address, setAddress] = useState(addressAt);
  const [entry, setEntry] = useState(entryAt);
  const [path, setPath] = useState(() => window.location.pathname);
  // Intent is session-only: reloads and history traversal never invent a forward entry.
  const headingEntry = useRef<{
    entry: string;
    request: PageEntryFocus;
  } | null>(null);
  const currentEntry = useRef(entry);
  const currentState = useRef(window.history.state);
  const positions = useRef(new Map<string, number>()).current;
  const focuses = useRef(new Map<string, SavedFocus | null>()).current;
  const update = () => {
    setPath(window.location.pathname);
    setAddress(addressAt());
    const nextEntry = entryAt();
    setEntry(nextEntry);
    currentEntry.current = nextEntry;
    currentState.current = window.history.state;
  };
  const current = useRef(path);
  current.current = path;
  const currentAddress = useRef(address);
  currentAddress.current = address;
  const scrolls = useRef(new Map<string, number>()).current;
  const addresses = useRef(new Map<string, string>()).current;
  // Approval belongs to these exact registrations, never to an unconditional next popstate.
  const leaving = useRef<Set<RegisteredGuard> | null>(null);
  // The pushed overlay entry whose Back is already on its way; cleared by the next popstate or navigation.
  const closing = useRef<string | null>(null);

  useEffect(() => {
    const onPopState = () => {
      closing.current = null;
      const approved = leaving.current ?? new Set<RegisteredGuard>();
      leaving.current = null;
      if (blocking(approved) && addressAt() !== currentAddress.current) {
        window.history.pushState(
          currentState.current,
          "",
          currentAddress.current
        );
        askToLeave(() => {
          leaving.current = approved;
          window.history.back();
        }, approved);
        return;
      }
      save(scrolls, current.current, window.scrollY);
      save(addresses, current.current, currentAddress.current);
      save(positions, currentEntry.current, window.scrollY);
      save(focuses, currentEntry.current, saveFocus());
      headingEntry.current = null;
      update();
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
        preserveScroll = false,
        overlay = false,
      }: {
        replace?: boolean;
        force?: boolean;
        preserveScroll?: boolean;
        overlay?: boolean;
      } = {}
    ) => {
      const go = () => {
        closing.current = null;
        save(scrolls, current.current, window.scrollY);
        save(addresses, current.current, currentAddress.current);
        save(positions, currentEntry.current, window.scrollY);
        // A replaced entry shows another address: the control that left it is not on it.
        if (replace) focuses.delete(currentEntry.current);
        else save(focuses, currentEntry.current, saveFocus());
        if (replace)
          window.history.replaceState(
            {
              prizecheckEntry: currentEntry.current,
              // Normalizing an overlay address keeps ownership of its pushed entry.
              ...(overlay && currentState.current?.prizecheckOverlayParent
                ? {
                    prizecheckOverlayParent:
                      currentState.current.prizecheckOverlayParent,
                  }
                : {}),
            },
            "",
            to
          );
        else {
          const nextEntry = crypto.randomUUID();
          if (preserveScroll) save(positions, nextEntry, window.scrollY);
          window.history.pushState(
            {
              prizecheckEntry: nextEntry,
              ...(overlay
                ? { prizecheckOverlayParent: currentAddress.current }
                : {}),
            },
            "",
            to
          );
        }
        const target = new URL(to, window.location.href).pathname;
        // A replace can continue pending entry intent, but returning to a view ends it.
        if (!replace)
          headingEntry.current =
            !overlay && opensPage(current.current, target)
              ? {
                  entry: window.history.state.prizecheckEntry,
                  request: createPageEntryFocus(),
                }
              : null;
        else if (
          headingEntry.current?.entry === currentEntry.current &&
          isViewAddress(target)
        ) {
          headingEntry.current.request.state = "cancelled";
          headingEntry.current = null;
        }
        update();
      };
      if (
        !force &&
        blocking() &&
        new URL(to, window.location.href).pathname +
          new URL(to, window.location.href).search !==
          currentAddress.current
      ) {
        askToLeave(go);
        return;
      }
      go();
    },
    [scrolls]
  );
  const scrollFor = useCallback(
    (at: string) =>
      positions.get(entry) ??
      (PAGES.some((page) => page.path === at) && addresses.get(at) === address
        ? (scrolls.get(at) ?? 0)
        : 0),
    [scrolls, entry, address]
  );
  const closeOverlay = useCallback(
    (to: string) => {
      if (typeof window.history.state?.prizecheckOverlayParent === "string") {
        if (closing.current === currentEntry.current) return;
        closing.current = currentEntry.current;
        window.history.back();
      } else navigate(to, { replace: true, preserveScroll: true });
    },
    [navigate]
  );
  const focusFor = useCallback(
    () =>
      headingEntry.current?.entry === entry
        ? headingEntry.current.request
        : (focuses.get(entry) ?? null),
    [entry, address]
  );
  return { path, address, entry, navigate, closeOverlay, scrollFor, focusFor };
}
