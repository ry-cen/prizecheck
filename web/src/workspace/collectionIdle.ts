/** What the collector is doing in Collection that a quiet refresh must not disturb. */
export type CollectionActivity = {
  /** Copies selected in the gallery. */
  selectedCopies: number;
  /** A Move, Inventory Removal or Undo is running. */
  working: boolean;
  /** A tile drag is under way. */
  dragging: boolean;
  /** The Move or Removal dialog is open (its destination or amounts are unsaved input). */
  actionDialogOpen: boolean;
  /** A Move is held for recovery: pending, checking or of unknown outcome, here or in another tab. */
  pendingCommand: boolean;
  /** A card's details sheet is open. */
  detailsOpen: boolean;
  /** A drawer, dialog or form other than the action dialogs is open: Add cards, Location create, settings or
   * manage, Lend to a Friend…, the Lent out and Borrowed lists, or the Locations and Filters drawers. */
  overlayOpen: boolean;
};

/** Ticket 113, scope of the return refresh: Collection is idle when nothing in it would be lost or changed under
 * the collector by reading the tiles and the tree again. Every condition counts on its own. An offered Undo does not:
 * Undo is checked by the API, and Move, Removal and Add read the gallery again themselves while it is offered. */
export function isCollectionIdle(activity: CollectionActivity): boolean {
  return (
    activity.selectedCopies === 0 &&
    !activity.working &&
    !activity.dragging &&
    !activity.actionDialogOpen &&
    !activity.pendingCommand &&
    !activity.detailsOpen &&
    !activity.overlayOpen
  );
}

/** What the return refresh knows when Collection is shown again after another page. */
export type ReturnRead = {
  idle: boolean;
  /** The tiles and the tree both came from complete reads; one still loading has nothing to compare. */
  settled: boolean;
  /** The older of the revisions the tiles and the tree came from. */
  shownRevision: number | null;
  /** The newest owner revision seen: the revision-only read on return, or one seen while away. */
  newestRevision: number | null;
};

/** Whether the tiles and the tree should be read again by themselves: only an idle, settled Collection whose
 * owner revision has moved. Anything else leaves the banner (isStale) to say so. */
export function returnRefreshDue(read: ReturnRead): boolean {
  return (
    read.idle &&
    read.settled &&
    read.shownRevision !== null &&
    read.newestRevision !== null &&
    read.newestRevision > read.shownRevision
  );
}
