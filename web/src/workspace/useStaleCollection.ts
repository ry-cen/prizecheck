import { useCallback, useEffect, useRef, useState } from "react";
import { getCollectionRevision } from "../collection_generated";
import type { GalleryHolding, GalleryStatus } from "./galleryModel";
import { returnRefreshDue } from "./collectionIdle";
import { focusWorkspaceHeading } from "./SelectionBar";
import { reconcileSelection, type Selection } from "./selectionModel";

export const STALE_MESSAGE =
  "Your collection has changed since this view loaded.";
export const RELOAD_NOTE =
  "Collection reloaded. Your selection was cleared because some selected cards had changed.";

/** The workspace shows out-of-date data when a newer owner revision has been seen than the one its
 * tiles or its tree came from. Only settled data counts: while either reloads there is nothing to
 * compare, so the workspace's own reloads never show the banner. */
export function isStale(
  latest: number | null,
  galleryRevision: number | null,
  galleryStatus: GalleryStatus,
  treeRevision: number | null,
  treeReady: boolean
): boolean {
  if (latest === null || galleryRevision === null || treeRevision === null)
    return false;
  if (galleryStatus !== "ready" || !treeReady) return false;
  return latest > Math.min(galleryRevision, treeRevision);
}

type Options = {
  /** The signed-in user. Tabs share revisions on a channel named for them. */
  userId: string;
  galleryRevision: number | null;
  galleryStatus: GalleryStatus;
  /** The gallery's Holdings by key (GalleryData.byKey). */
  byKey: ReadonlyMap<string, GalleryHolding>;
  /** The gallery query's key: a note waiting for a reload is dropped when the view changes. */
  galleryKey: string;
  reloadGallery: () => void;
  treeRevision: number | null;
  treeReady: boolean;
  reloadTree: () => void | Promise<void>;
  selected: Selection;
  clearSelection: () => void;
  /** A Move, Removal or Undo is running; Reload waits for it. */
  busy: boolean;
  /** False while the app shell shows another page. Showing the workspace again reads the revision, as
   * coming back to the tab does (#162). */
  active?: boolean;
  /** isCollectionIdle: nothing selected, running, open or pending. Only an idle Collection refreshes by itself. */
  idle?: boolean;
  /** A quiet re-read of the tiles: they stay on screen until the complete answer replaces them. */
  refreshGallery?: () => void;
};

type PendingNote = { snapshot: Selection; key: string; revision: number };

/** Ticket 113: notices that the collection changed elsewhere (another tab, window or device) and
 * offers Reload. The one thing that refreshes by itself is an idle Collection shown again after another
 * page of the app, in the same tab (slice 5, owner-approved 2026-11-08): it reads the tiles and the tree
 * again quietly, with no banner. A busy Collection, a returning tab and a change from another tab keep
 * the banner and Reload.
 *
 * Revisions come from three places: every gallery page and tree this tab reads, a revision-only
 * read when the tab regains focus or becomes visible, and the other tabs of this user in this
 * browser, which share each revision they read on a BroadcastChannel. */
export function useStaleCollection({
  userId,
  galleryRevision,
  galleryStatus,
  byKey,
  galleryKey,
  reloadGallery,
  treeRevision,
  treeReady,
  reloadTree,
  selected,
  clearSelection,
  busy,
  active = true,
  idle = false,
  refreshGallery,
}: Options) {
  const [latest, setLatest] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const channel = useRef<BroadcastChannel | null>(null);
  const posted = useRef(0);
  const pending = useRef<PendingNote | null>(null);
  // Showing Collection again after another page, while it is idle, reads the revision before the banner may
  // appear: a change seen meanwhile is refreshed away instead. Set while rendering, so no frame shows the banner.
  const [checking, setChecking] = useState(false);
  const [wasShown, setWasShown] = useState(active);
  if (active !== wasShown) {
    setWasShown(active);
    setChecking(active && idle);
  }

  const live = useRef({
    selected,
    clearSelection,
    reloadGallery,
    reloadTree,
    galleryKey,
    latest,
    busy,
    galleryRevision,
    galleryStatus,
    treeRevision,
    treeReady,
    idle,
    refreshGallery,
  });
  live.current = {
    selected,
    clearSelection,
    reloadGallery,
    reloadTree,
    galleryKey,
    latest,
    busy,
    galleryRevision,
    galleryStatus,
    treeRevision,
    treeReady,
    idle,
    refreshGallery,
  };

  /** Records a revision. `share` posts it to the other tabs; revisions they sent are not echoed. */
  const observe = useCallback((revision: number, share: boolean) => {
    setLatest((previous) =>
      previous === null || revision > previous ? revision : previous
    );
    if (share && revision > posted.current) {
      posted.current = revision;
      channel.current?.postMessage({ revision });
    }
  }, []);

  // Declared first so the channel exists before the first revision is shared.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const shared = new BroadcastChannel(`prizecheck-owner-revision:${userId}`);
    channel.current = shared;
    shared.onmessage = (event: MessageEvent) => {
      const revision = (event.data as { revision?: unknown } | null)?.revision;
      if (
        typeof revision === "number" &&
        Number.isSafeInteger(revision) &&
        revision > 0
      )
        observe(revision, false);
    };
    return () => {
      shared.close();
      if (channel.current === shared) channel.current = null;
    };
  }, [userId, observe]);

  useEffect(() => {
    if (galleryRevision !== null) observe(galleryRevision, true);
  }, [galleryRevision, observe]);
  useEffect(() => {
    if (treeReady && treeRevision !== null) observe(treeRevision, true);
  }, [treeReady, treeRevision, observe]);

  // A revision-only read when the collector comes back to this tab: one row, no lock, nothing on screen changes.
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const probe = () => {
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      getCollectionRevision()
        .then((result) => {
          if (alive && Number.isSafeInteger(result.owner_revision))
            observe(result.owner_revision, true);
        })
        .catch(() => {
          /* The next focus tries again; actions still fail safely on the API's checks. */
        })
        .finally(() => {
          inFlight = false;
        });
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") probe();
    };
    window.addEventListener("focus", probe);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      window.removeEventListener("focus", probe);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [observe]);

  // Shown again by the app shell after another page, where Holdings may have changed: the same
  // revision-only read. When Collection is idle and settled and the revision has moved past what the
  // tiles or the tree came from, both are read again quietly; otherwise the banner says so.
  const wasActive = useRef(active);
  useEffect(() => {
    const returning = active && !wasActive.current;
    wasActive.current = active;
    if (!returning) return;
    let alive = true;
    const settle = (revision: number | null) => {
      const now = live.current;
      const shown =
        now.galleryRevision !== null && now.treeRevision !== null
          ? Math.min(now.galleryRevision, now.treeRevision)
          : null;
      if (
        now.refreshGallery &&
        returnRefreshDue({
          idle: now.idle,
          settled: now.galleryStatus === "ready" && now.treeReady,
          shownRevision: shown,
          newestRevision:
            now.latest === null && revision === null
              ? null
              : Math.max(now.latest ?? 0, revision ?? 0),
        })
      ) {
        now.refreshGallery();
        void now.reloadTree();
      }
      if (revision !== null) observe(revision, true);
      setChecking(false);
    };
    // A failed read still settles: a change already seen refreshes, or shows the banner. The next focus or
    // return tries the read again.
    getCollectionRevision().then(
      (result) => {
        if (alive)
          settle(
            Number.isSafeInteger(result.owner_revision)
              ? result.owner_revision
              : null
          );
      },
      () => {
        if (alive) settle(null);
      }
    );
    return () => {
      alive = false;
    };
  }, [active, observe]);

  const stale =
    isStale(latest, galleryRevision, galleryStatus, treeRevision, treeReady) &&
    !(checking && idle);

  // A new banner replaces an old note; so does a different view.
  useEffect(() => {
    if (stale) setNote("");
  }, [stale]);
  useEffect(() => {
    setNote("");
  }, [galleryKey]);

  /** The banner's Reload: clears the selection, refetches the gallery and the tree, and once the
   * gallery has caught up says so if any selected copies had changed. */
  const reload = useCallback(() => {
    const now = live.current;
    if (now.busy) return;
    pending.current =
      now.selected.size && now.latest !== null
        ? { snapshot: now.selected, key: now.galleryKey, revision: now.latest }
        : null;
    setNote("");
    // The Reload button goes with the banner; focus must not fall to the page.
    focusWorkspaceHeading();
    now.clearSelection();
    now.reloadGallery();
    void now.reloadTree();
  }, []);

  useEffect(() => {
    const wait = pending.current;
    if (!wait) return;
    if (wait.key !== galleryKey) {
      pending.current = null;
      return;
    }
    if (
      galleryStatus !== "ready" ||
      galleryRevision === null ||
      galleryRevision < wait.revision
    )
      return;
    pending.current = null;
    // reconcileSelection returns the same object when every selected copy is unchanged.
    if (reconcileSelection(wait.snapshot, byKey) !== wait.snapshot)
      setNote(RELOAD_NOTE);
  }, [galleryKey, galleryStatus, galleryRevision, byKey]);

  const dismissNote = useCallback(() => {
    setNote("");
    focusWorkspaceHeading();
  }, []);

  return { stale, note, reload, dismissNote };
}
