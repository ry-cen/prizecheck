import { useCallback, useEffect, useRef, useState } from "react";
import { getCollectionSets } from "../collection_generated";
import type { GalleryHolding, GalleryStatus } from "./galleryModel";
import { focusWorkspaceHeading } from "./SelectionBar";
import { reconcileSelection, type Selection } from "./selectionModel";

export const STALE_MESSAGE =
  "Your collection changed in another tab or session.";
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
  holdings: GalleryHolding[];
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
};

type PendingNote = { snapshot: Selection; key: string; revision: number };

/** Ticket 113: notices that the collection changed elsewhere (another tab, window or device) and
 * offers Reload. Nothing refreshes by itself.
 *
 * Revisions come from three places: every gallery page and tree this tab reads, a revision-only
 * read when the tab regains focus or becomes visible, and the other tabs of this user in this
 * browser, which share each revision they read on a BroadcastChannel. */
export function useStaleCollection({
  userId,
  galleryRevision,
  galleryStatus,
  holdings,
  galleryKey,
  reloadGallery,
  treeRevision,
  treeReady,
  reloadTree,
  selected,
  clearSelection,
  busy,
}: Options) {
  const [latest, setLatest] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const channel = useRef<BroadcastChannel | null>(null);
  const posted = useRef(0);
  const pending = useRef<PendingNote | null>(null);

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

  // A revision-only read when the collector comes back to this tab. The Set list is lock-free and
  // independent of the view; its sets are discarded, so nothing on screen changes.
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const probe = () => {
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      getCollectionSets()
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

  const stale = isStale(
    latest,
    galleryRevision,
    galleryStatus,
    treeRevision,
    treeReady
  );

  // A new banner replaces an old note; so does a different view.
  useEffect(() => {
    if (stale) setNote("");
  }, [stale]);
  useEffect(() => {
    setNote("");
  }, [galleryKey]);

  const live = useRef({
    selected,
    clearSelection,
    reloadGallery,
    reloadTree,
    galleryKey,
    latest,
    busy,
  });
  live.current = {
    selected,
    clearSelection,
    reloadGallery,
    reloadTree,
    galleryKey,
    latest,
    busy,
  };

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
    const byKey = new Map(holdings.map((holding) => [holding.key, holding]));
    // reconcileSelection returns the same object when every selected copy is unchanged.
    if (reconcileSelection(wait.snapshot, byKey) !== wait.snapshot)
      setNote(RELOAD_NOTE);
  }, [galleryKey, galleryStatus, galleryRevision, holdings]);

  const dismissNote = useCallback(() => {
    setNote("");
    focusWorkspaceHeading();
  }, []);

  return { stale, note, reload, dismissNote };
}
