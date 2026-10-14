import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyUndo,
  dismissUndo,
  listUndo,
  removeInventory,
  type UndoEntry,
} from "../inventoryUndo";
import {
  commitMove,
  MoveError,
  stageMove,
  startMove,
} from "../moves_generated";
import {
  appendedFrom,
  EMPTY_GALLERY,
  plural,
  type GalleryHolding,
  type GalleryStatus,
} from "./galleryModel";
import {
  cardLabel,
  cardText,
  countText,
  describeFailure,
  STAGE_BATCH,
  trimOldest,
  type ActionTarget,
  type CardLabel,
  type RemovalRow,
} from "./inventoryActionsModel";
import type { LocationIndex } from "./locationTree";
import { focusWorkspaceHeading } from "./SelectionBar";
import {
  reconcileSelection,
  selectedGroups,
  type SelectedGroup,
  type Selection,
} from "./selectionModel";
import type { SelectionState } from "./useSelection";

/** The fewest names and paths kept after trimming; see the labels effect. */
const LABEL_CACHE_FLOOR = 1_000;

/** The success and Undo toast. `entry` is the newest Undo record, or null when none is offered. */
export type ToastState = {
  id: number;
  message: string;
  entry: UndoEntry | null;
  /** The API refused this Undo as incompatible: it shows as unavailable and can be dismissed. */
  unavailable: boolean;
  /** The collector acted on the toast (Undo, Dismiss Undo): its first usable button takes focus. */
  focus?: boolean;
};

type Options = {
  selection: SelectionState;
  holdings: GalleryHolding[];
  /** The gallery's Holdings by key (GalleryData.byKey). */
  byKey: ReadonlyMap<string, GalleryHolding>;
  status: GalleryStatus;
  index: LocationIndex;
  reloadGallery: () => void;
  reloadTree: () => void | Promise<void>;
};

/** A staged manifest and its idempotency key. A retry of the same selection to the same target
 * reuses both, so a commit whose response was lost applies once. */
type Pending = { manifestId: string; key: string; signature: string };

type FocusTarget = "heading" | "actions";

/** A failure whose refresh may empty the selection: its toast text and the selection it was about. */
type Carried = { toastText: string; selection: Selection };

/** Move, Inventory Removal and Undo for the workspace (ticket 107), on the multi-source manifest API. */
export function useInventoryActions({
  selection,
  holdings,
  byKey,
  status,
  index,
  reloadGallery,
  reloadTree,
}: Options) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [barError, setBarError] = useState("");
  const [dialog, setDialog] = useState<"move" | "remove" | null>(null);
  const [dialogError, setDialogError] = useState("");
  const [toast, setToast] = useState<ToastState | null>(null);
  const busyRef = useRef(false);
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  const toastLive = useRef(toast);
  toastLive.current = toast;
  const toastId = useRef(0);
  const pending = useRef<Pending | null>(null);
  const undoKeys = useRef(new Map<string, string>());
  const focusAfter = useRef<FocusTarget | null>(null);
  const carried = useRef<Carried | null>(null);
  const holdingsRef = useRef(holdings);
  holdingsRef.current = holdings;
  const byKeyRef = useRef(byKey);
  byKeyRef.current = byKey;
  const actionsButton = useRef<HTMLButtonElement>(null);
  // Names and paths outlive a gallery reload, which empties the listing while it refetches.
  const labels = useRef(new Map<string, CardLabel>()).current;
  const paths = useRef(new Map<string, string>()).current;
  const live = useRef({ selection, index, reloadGallery, reloadTree });
  live.current = { selection, index, reloadGallery, reloadTree };

  const seen = useRef<GalleryHolding[]>([]);
  useEffect(() => {
    // Only the rows a new page added: earlier pages of this walk are already cached.
    const from = appendedFrom(seen.current, holdings);
    seen.current = holdings;
    for (let index = from; index < holdings.length; index++) {
      const entry = holdings[index];
      // Re-inserting moves a key to the newest end, so trimming drops the longest-unlisted entries first.
      labels.delete(entry.key);
      labels.set(entry.key, cardLabel(entry.holding));
      paths.delete(entry.holding.location_id);
      paths.set(entry.holding.location_id, entry.holding.location_path);
    }
    // Once the listing is complete, keep at most twice its size (never fewer than the floor). Every listed and
    // selected key is among the newest, and recent older names still cover an Undo's former sources.
    if (status === "ready") {
      const limit = Math.max(LABEL_CACHE_FLOOR, 2 * holdings.length);
      trimOldest(labels, limit);
      trimOldest(paths, limit);
    }
  }, [holdings, status, labels, paths]);

  const place = useCallback(
    (id: string) => {
      const tree = live.current.index;
      return tree.byId.has(id)
        ? tree.path(id)
        : (paths.get(id) ?? "Unknown location");
    },
    [paths]
  );
  const card = useCallback(
    (sourceId: string, editionId: string) => {
      const label = labels.get(`${sourceId}:${editionId}`);
      return label ? cardText(label) : "a card";
    },
    [labels]
  );

  const showToast = useCallback((next: Omit<ToastState, "id">) => {
    toastId.current += 1;
    setToast({ ...next, id: toastId.current });
  }, []);

  /** A tile that holds focus unmounts when the gallery reloads or the selection clears: move focus
   * to a stable control first. Tiles carry data-gallery-tile, not a class, since #164 moved them onto
   * the kit's CopyTile. */
  const keepFocus = (to: "heading" | "actions") => {
    if (!document.activeElement?.closest("[data-gallery-tile]")) return;
    if (to === "actions" && actionsButton.current?.isConnected)
      actionsButton.current.focus({ preventScroll: true });
    else focusWorkspaceHeading();
  };

  const finish = () => {
    busyRef.current = false;
    setBusy(false);
    setProgress("");
  };

  const run = useCallback(
    async (
      target: ActionTarget,
      groups: SelectedGroup[],
      surface: "dialog" | "bar"
    ) => {
      if (busyRef.current || !groups.length) return;
      busyRef.current = true;
      setBusy(true);
      setBarError("");
      setDialogError("");
      carried.current = null;
      const signature = JSON.stringify([target, groups]);
      try {
        let attempt =
          pending.current?.signature === signature ? pending.current : null;
        if (!attempt) {
          pending.current = null;
          setProgress("Preparing…");
          const manifest = await startMove();
          for (let start = 0; start < groups.length; start += STAGE_BATCH) {
            await stageMove(
              manifest.id,
              groups.slice(start, start + STAGE_BATCH)
            );
            const done = Math.min(start + STAGE_BATCH, groups.length);
            setProgress(
              `Prepared ${done.toLocaleString("en-US")} of ${plural(groups.length, "selected holding", "selected holdings")}…`
            );
          }
          attempt = {
            manifestId: manifest.id,
            key: crypto.randomUUID(),
            signature,
          };
          pending.current = attempt;
        }
        setProgress(target.kind === "move" ? "Moving…" : "Removing…");
        const result =
          target.kind === "move"
            ? await commitMove(
                attempt.manifestId,
                target.destinationId,
                attempt.key
              )
            : await removeInventory(attempt.manifestId, attempt.key);
        pending.current = null;
        const copies = countText(result.copy_count, "copy", "copies");
        const stayed =
          result.already_at_destination_count !== "0"
            ? ` ${countText(result.already_at_destination_count, "copy", "copies")} already there stayed.`
            : "";
        const message =
          target.kind === "move"
            ? `Moved ${copies} to ${place(target.destinationId)}.${stayed}`
            : `Removed ${copies} from your Collection.`;
        // One batch: the selection clears, the dialog closes and the toast shows. Focus then goes to
        // the heading if it was in the dialog or the bar, which are gone.
        focusAfter.current = "heading";
        keepFocus("heading");
        live.current.selection.clear();
        setDialog(null);
        showToast({ message, entry: null, unavailable: false });
        live.current.reloadGallery();
        void live.current.reloadTree();
        const id = toastId.current;
        const entries = await listUndo().catch(() => [] as UndoEntry[]);
        // Offer Undo only for the record this action made, and only while it is the newest (Undo applies the
        // newest record alone). The result names its record; only a previous-release API process during a deploy
        // omits the id, and then the record is recognised by its shape as before.
        const newest = entries[0];
        const mine = !newest
          ? null
          : result.undo_id
            ? newest.id === result.undo_id
              ? newest
              : null
            : newest.action === target.kind &&
                newest.source_count === result.source_count &&
                (target.kind !== "move" ||
                  newest.destination_id === target.destinationId)
              ? newest
              : null;
        setToast((current) =>
          current && current.id === id ? { ...current, entry: mine } : current
        );
      } catch (cause) {
        const failure = describeFailure(target, cause, { place, card });
        if (!failure.retrySame) pending.current = null;
        // Only a refresh can empty the kept selection; then the empty-selection effect below moves
        // this failure to the toast.
        carried.current = failure.reloadGallery
          ? {
              toastText: failure.toastText,
              selection: live.current.selection.selected,
            }
          : null;
        if (failure.reloadGallery) {
          if (surface === "bar") keepFocus("actions");
          live.current.reloadGallery();
        }
        // A reload after a failure refreshes the tree too, so the workspace catches up with the
        // newest owner revision and no stale-collection banner (ticket 113) follows this message.
        if (failure.reloadTree || failure.reloadGallery)
          void live.current.reloadTree();
        if (surface === "dialog" && dialogRef.current)
          setDialogError(failure.text);
        else setBarError(failure.text);
      } finally {
        finish();
      }
    },
    [place, card, showToast]
  );

  const openMove = useCallback(() => {
    carried.current = null;
    setBarError("");
    setDialogError("");
    setDialog("move");
  }, []);
  const openRemoval = useCallback(() => {
    carried.current = null;
    setBarError("");
    setDialogError("");
    setDialog("remove");
  }, []);
  /** Cancel, Escape or the backdrop. `forced` is a close the browser already made. */
  const closeDialog = useCallback((forced = false) => {
    if (busyRef.current && !forced) return;
    focusAfter.current = "actions";
    setDialog(null);
    setDialogError("");
  }, []);
  const confirmMove = useCallback(
    (destinationId: string) =>
      void run(
        { kind: "move", destinationId },
        selectedGroups(live.current.selection.selected),
        "dialog"
      ),
    [run]
  );
  const confirmRemoval = useCallback(
    () =>
      void run(
        { kind: "remove" },
        selectedGroups(live.current.selection.selected),
        "dialog"
      ),
    [run]
  );
  /** A drop on a valid sidebar Storage Leaf moves at once; errors show in the selection bar. */
  const dropMove = useCallback(
    (destinationId: string, groups: SelectedGroup[]) =>
      void run({ kind: "move", destinationId }, groups, "bar"),
    [run]
  );
  const clearSelection = useCallback(() => {
    carried.current = null;
    setBarError("");
    live.current.selection.clear();
  }, []);

  const undo = useCallback(async () => {
    const current = toastLive.current;
    const entry = current?.entry;
    if (!current || !entry || current.unavailable || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const key = undoKeys.current.get(entry.id) ?? crypto.randomUUID();
    undoKeys.current.set(entry.id, key);
    try {
      const result = await applyUndo(entry.id, key);
      undoKeys.current.delete(entry.id);
      showToast({
        message: `Undo restored ${countText(result.copy_count, "copy", "copies")} to ${plural(result.source_count, "location", "locations")}.`,
        entry: null,
        unavailable: false,
        focus: true,
      });
      live.current.reloadGallery();
      void live.current.reloadTree();
    } catch (cause) {
      const code = cause instanceof MoveError ? cause.code : "";
      if (code === "UNDO_INCOMPATIBLE") {
        undoKeys.current.delete(entry.id);
        const { source_id, destination_id, edition_id } = (cause as MoveError)
          .detail;
        const reason =
          source_id && edition_id
            ? `copies of ${card(source_id, edition_id)} it would return to ${place(source_id)} have changed`
            : source_id || destination_id
              ? `${place((source_id ?? destination_id)!)} can no longer hold cards`
              : "the cards have changed";
        showToast({
          message: `Undo unavailable: ${reason}, so nothing was restored. Dismiss it to reach an earlier action.`,
          entry,
          unavailable: true,
          focus: true,
        });
      } else if (
        code === "UNDO_EXPIRED" ||
        code === "UNDO_NOT_FOUND" ||
        code === "UNDO_NOT_NEWEST"
      ) {
        undoKeys.current.delete(entry.id);
        const entries = await listUndo().catch(() => [] as UndoEntry[]);
        showToast({
          message: entries[0]
            ? "That Undo is no longer available. The newest action can still be undone."
            : "That Undo is no longer available.",
          entry: entries[0] ?? null,
          unavailable: false,
          focus: true,
        });
      } else if (!(cause instanceof MoveError) || cause.status >= 500) {
        // Unknown outcome (no response or a server error): the same key makes a retry apply once.
        showToast({
          ...current,
          message: "Undo may not have finished. Try again to check safely.",
        });
      } else if (code === "REPLAY_OUTCOME_UNAVAILABLE") {
        undoKeys.current.delete(entry.id);
        showToast({
          message:
            "Undo may have already finished, and your collection was refreshed. Review it before trying again.",
          entry: null,
          unavailable: false,
          focus: true,
        });
        live.current.reloadGallery();
        void live.current.reloadTree();
      } else {
        // Any other refusal is definite: nothing was restored, and a retry takes a new key.
        undoKeys.current.delete(entry.id);
        showToast({
          ...current,
          message: "Undo couldn't be completed. Nothing was restored.",
        });
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [place, card, showToast]);

  const dismiss = useCallback(async () => {
    const current = toastLive.current;
    const entry = current?.entry;
    if (!current || !entry || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      try {
        await dismissUndo(entry.id);
      } catch (cause) {
        if (!(cause instanceof MoveError && cause.status === 404)) {
          showToast({
            ...current,
            message: "Couldn't dismiss this Undo. Try again.",
          });
          return;
        }
      }
      const entries = await listUndo().catch(() => [] as UndoEntry[]);
      const next = entries[0] ?? null;
      showToast({
        message: next
          ? `Dismissed. The earlier ${next.action === "move" ? "Move" : "Inventory Removal"} can be undone.`
          : "Dismissed. There is no earlier action to undo.",
        entry: next,
        unavailable: false,
        focus: true,
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [showToast]);

  // Dismiss is pressed inside the toast, which goes away with this. The heading takes focus now, while
  // the toast is still there, rather than in an effect that can run before the toast is removed.
  const closeToast = useCallback(() => {
    focusWorkspaceHeading();
    setToast(null);
  }, []);

  // An Undo record expires after ten minutes; its button goes with it.
  const entryId = toast?.entry?.id;
  const entryExpires = toast?.entry?.expires_at;
  useEffect(() => {
    if (!entryId || !entryExpires) return;
    const timer = window.setTimeout(
      () =>
        setToast((current) =>
          current?.entry?.id === entryId
            ? {
                ...current,
                message: "Undo expired.",
                entry: null,
                unavailable: false,
              }
            : current
        ),
      Math.max(0, Date.parse(entryExpires) - Date.now())
    );
    return () => window.clearTimeout(timer);
  }, [entryId, entryExpires]);

  // Runs after the commit that closed a dialog or changed the toast, once the dialog has left the
  // top layer, so the page is no longer inert and focus can move. A toast the collector acted on takes
  // focus itself, in the kit's toast host (ToastState.focus).
  useEffect(() => {
    const target = focusAfter.current;
    if (!target) return;
    // An earlier render's pending effects can run before the commit that closes the dialog. Focus can't
    // leave an open modal, so keep the request for the commit that closes it.
    if (document.activeElement?.closest("dialog[open]")) return;
    focusAfter.current = null;
    if (target === "actions" && actionsButton.current?.isConnected) {
      actionsButton.current.focus();
      return;
    }
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected)
      focusWorkspaceHeading();
  });

  // An empty selection has no bar and nothing to act on: its error goes, and an idle dialog closes
  // (another tab can empty the selection by removing every selected copy). Declared after the focus
  // effect on purpose: the focus it asks for is applied in the next commit, once the dialog is gone.
  const empty = selection.summary.copies === 0;
  useEffect(() => {
    if (!empty) return;
    // A failure stays on screen when its refresh is what emptied the selection: the settled listing
    // (not the loading placeholder, EMPTY_GALLERY.holdings) has none of the copies it was about.
    // A clear by the collector (Escape, empty space, another view) leaves those copies listed, or
    // happens while a new view loads, so the failure goes with the bar.
    const failure = carried.current;
    carried.current = null;
    const listing = holdingsRef.current;
    if (
      failure &&
      listing !== EMPTY_GALLERY.holdings &&
      reconcileSelection(failure.selection, byKeyRef.current).size === 0
    ) {
      showToast({
        message: failure.toastText,
        entry: toastLive.current?.entry ?? null,
        unavailable: toastLive.current?.unavailable ?? false,
      });
      // The bar and Actions unmount with the selection; focus would fall to <body>.
      focusAfter.current = "heading";
    }
    setBarError("");
    if (dialogRef.current && !busyRef.current) {
      focusAfter.current = "heading";
      setDialog(null);
      setDialogError("");
    }
  }, [empty, showToast]);

  // The Removal confirmation lists the current selection; names come from the cache, so a reload
  // after a failure doesn't blank them.
  const removalRows: RemovalRow[] = useMemo(
    () =>
      dialog === "remove"
        ? Array.from(selection.selected.values(), (entry) => {
            const label = labels.get(entry.key);
            return {
              key: entry.key,
              quantity: entry.count,
              card: label ? cardText(label) : "Unknown card",
              locationId: entry.locationId,
              path: place(entry.locationId),
            };
          })
        : [],
    [dialog, selection.selected, labels, place]
  );

  return {
    busy,
    progress,
    barError,
    dialog,
    dialogError,
    removalRows,
    toast,
    actionsButton,
    openMove,
    openRemoval,
    closeDialog,
    confirmMove,
    confirmRemoval,
    dropMove,
    clearSelection,
    undo,
    dismiss,
    closeToast,
  };
}
