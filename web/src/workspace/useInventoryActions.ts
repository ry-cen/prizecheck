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
import { plural, type GalleryHolding } from "./galleryModel";
import {
  cardLabel,
  cardText,
  countText,
  describeFailure,
  STAGE_BATCH,
  type ActionTarget,
  type CardLabel,
  type RemovalRow,
} from "./inventoryActionsModel";
import type { LocationIndex } from "./locationTree";
import { focusWorkspaceHeading } from "./SelectionBar";
import { selectedGroups, type SelectedGroup } from "./selectionModel";
import type { SelectionState } from "./useSelection";

/** The success and Undo toast. `entry` is the newest Undo record, or null when none is offered. */
export type ToastState = {
  id: number;
  message: string;
  entry: UndoEntry | null;
  /** The API refused this Undo as incompatible: it shows as unavailable and can be dismissed. */
  unavailable: boolean;
};

type Options = {
  selection: SelectionState;
  holdings: GalleryHolding[];
  index: LocationIndex;
  reloadGallery: () => void;
  reloadTree: () => void | Promise<void>;
};

/** A staged manifest and its idempotency key. A retry of the same selection to the same target
 * reuses both, so a commit whose response was lost applies once. */
type Pending = { manifestId: string; key: string; signature: string };

type FocusTarget = "heading" | "actions" | "toast";

/** Move, Inventory Removal and Undo for the workspace (ticket 107), on the multi-source manifest API. */
export function useInventoryActions({
  selection,
  holdings,
  index,
  reloadGallery,
  reloadTree,
}: Options) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [barError, setBarError] = useState("");
  const barErrorRef = useRef("");
  barErrorRef.current = barError;
  const [dialog, setDialog] = useState<"move" | "remove" | null>(null);
  const [dialogError, setDialogError] = useState("");
  const dialogErrorRef = useRef("");
  dialogErrorRef.current = dialogError;
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
  const actionsButton = useRef<HTMLButtonElement>(null);
  const toastRef = useRef<HTMLDivElement>(null);
  // Names and paths outlive a gallery reload, which empties the listing while it refetches.
  const labels = useRef(new Map<string, CardLabel>()).current;
  const paths = useRef(new Map<string, string>()).current;
  const live = useRef({ selection, index, reloadGallery, reloadTree });
  live.current = { selection, index, reloadGallery, reloadTree };

  useEffect(() => {
    for (const entry of holdings) {
      labels.set(entry.key, cardLabel(entry.holding));
      paths.set(entry.holding.location_id, entry.holding.location_path);
    }
  }, [holdings, labels, paths]);

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
   * to a stable control first. */
  const keepFocus = (to: "heading" | "actions") => {
    if (!document.activeElement?.closest(".ws-tile")) return;
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
        // Offer Undo only for the record this action made, never an older one.
        const newest = entries[0];
        const mine =
          newest &&
          newest.action === target.kind &&
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
        if (failure.reloadGallery) {
          if (surface === "bar") keepFocus("actions");
          live.current.reloadGallery();
        }
        if (failure.reloadTree) void live.current.reloadTree();
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
    setBarError("");
    setDialogError("");
    setDialog("move");
  }, []);
  const openRemoval = useCallback(() => {
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
      focusAfter.current = "toast";
      showToast({
        message: `Undo restored ${countText(result.copy_count, "copy", "copies")} to ${plural(result.source_count, "location", "locations")}.`,
        entry: null,
        unavailable: false,
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
        focusAfter.current = "toast";
        showToast({
          message: `Undo unavailable: ${reason}, so nothing was restored. Dismiss it to reach an earlier action.`,
          entry,
          unavailable: true,
        });
      } else if (
        code === "UNDO_EXPIRED" ||
        code === "UNDO_NOT_FOUND" ||
        code === "UNDO_NOT_NEWEST"
      ) {
        undoKeys.current.delete(entry.id);
        const entries = await listUndo().catch(() => [] as UndoEntry[]);
        focusAfter.current = "toast";
        showToast({
          message: entries[0]
            ? "That Undo is no longer available. The newest action can still be undone."
            : "That Undo is no longer available.",
          entry: entries[0] ?? null,
          unavailable: false,
        });
      } else if (!(cause instanceof MoveError) || cause.status >= 500) {
        // Unknown outcome (no response or a server error): the same key makes a retry apply once.
        showToast({
          ...current,
          message: "Undo may not have finished. Try again to check safely.",
        });
      } else if (code === "REPLAY_OUTCOME_UNAVAILABLE") {
        undoKeys.current.delete(entry.id);
        focusAfter.current = "toast";
        showToast({
          message:
            "Undo may have already finished, and your collection was refreshed. Review it before trying again.",
          entry: null,
          unavailable: false,
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
      focusAfter.current = "toast";
      showToast({
        message: next
          ? `Dismissed. The earlier ${next.action === "move" ? "Move" : "Inventory Removal"} can be undone.`
          : "Dismissed. There is no earlier action to undo.",
        entry: next,
        unavailable: false,
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [showToast]);

  const closeToast = useCallback(() => {
    focusAfter.current = "heading";
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

  // An empty selection has no bar and nothing to act on: its error goes, and an idle dialog closes
  // (another tab can empty the selection by removing every selected copy).
  const empty = selection.summary.copies === 0;
  useEffect(() => {
    if (!empty) return;
    // A failure the collector hasn't dismissed outlives the selection it was about (a reload can
    // trim the kept selection to nothing), so it moves to the toast.
    const failure =
      barErrorRef.current || (dialogRef.current ? dialogErrorRef.current : "");
    if (failure)
      showToast({
        message: failure,
        entry: toastLive.current?.entry ?? null,
        unavailable: toastLive.current?.unavailable ?? false,
      });
    setBarError("");
    if (dialogRef.current && !busyRef.current) {
      focusAfter.current = "heading";
      setDialog(null);
      setDialogError("");
    }
  }, [empty, showToast]);

  // Runs after the commit that closed a dialog or changed the toast, once the dialog has left the
  // top layer, so the page is no longer inert and focus can move.
  useEffect(() => {
    const target = focusAfter.current;
    if (!target) return;
    focusAfter.current = null;
    if (target === "actions" && actionsButton.current?.isConnected) {
      actionsButton.current.focus();
      return;
    }
    if (target === "toast") {
      const button = toastRef.current?.querySelector<HTMLButtonElement>(
        "button:not(:disabled)"
      );
      if (button) {
        button.focus();
        return;
      }
    }
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected)
      focusWorkspaceHeading();
  });

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
    toastRef,
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
