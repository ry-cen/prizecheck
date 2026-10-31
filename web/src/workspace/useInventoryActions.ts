import {
  MoveServerClock,
  MoveInAnotherTab,
  MoveLocksUnavailable,
  withMoveWriter,
  moveWriterBusy,
  moveActivityKey,
} from "./moveRecovery";
import { pendingMoves, recoveryText } from "./pendingMove";
import type { BorrowedMoveItem } from "../collection_generated";
import {
  advance,
  RecoveryBlocked,
  moveApi,
  createRemoval,
  operationFor,
  undoProtectionUnconfirmed,
  type HeldOperation,
} from "./moveOperation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addUndoneText, batchAddedText } from "../catalog/catalogText";
import type { AddedCards } from "../catalog/useAddToast";
import {
  applyUndo,
  dismissUndo,
  listUndo,
  type UndoEntry,
} from "../inventoryUndo";
import { MoveError, stageMove, startMove } from "../moves_generated";
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
  describeBorrowedFailure,
  borrowedUnknownFailure,
  partialMoveFailure,
  unsupportedUndoFailure,
  trimOldest,
  type ActionTarget,
  type CardLabel,
  type LendRow,
  type RemovalRow,
} from "./inventoryActionsModel";
import type { LocationIndex } from "./locationTree";
import { focusWorkspaceHeading } from "./SelectionBar";
import {
  reconcileSelection,
  selectedGroups,
  selectedBorrowed,
  type SelectedGroup,
  type Selection,
} from "./selectionModel";
import type { SelectionState } from "./useSelection";

/** The fewest names and paths kept after trimming; see the labels effect. */
const LABEL_CACHE_FLOOR = 1_000;

/** An Undo record's action as the toast names it. */
const ACTION_NAMES: Record<UndoEntry["action"], string> = {
  move: "Move",
  remove: "Inventory Removal",
  add: "Add",
};

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
  userId: string;
  selection: SelectionState;
  holdings: GalleryHolding[];
  /** The gallery's Holdings by key (GalleryData.byKey). */
  byKey: ReadonlyMap<string, GalleryHolding>;
  status: GalleryStatus;
  index: LocationIndex;
  reloadGallery: () => void;
  reloadTree: () => void | Promise<void>;
};

type FocusTarget = "heading" | "actions";

/** A failure whose refresh may empty the selection: its toast text and the selection it was about. */
type Carried = { toastText: string; selection: Selection; mixed: boolean };

/** Move, Inventory Removal and Undo for the workspace (ticket 107), on the multi-source manifest API, and the toast
 * for Add cards' batch adds (#175). */
export function useInventoryActions({
  userId,
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
  const account = useRef({ userId, active: true });
  const clock = useMemo(() => new MoveServerClock(), [userId]);
  const lockRequest = useRef(false);
  const [otherTab, setOtherTab] = useState(false);
  account.current.userId = userId;
  const store = useMemo(() => {
    try {
      return pendingMoves(userId);
    } catch {
      return null;
    }
  }, [userId]);
  const [recovery, setRecovery] = useState<{
    held: HeldOperation | null;
    blocked: boolean;
  }>(() => {
    try {
      const held = store?.load() ?? null;
      if (held) store?.adopt();
      return { held, blocked: !store || !!held?.state.blocked };
    } catch {
      return { held: null, blocked: true };
    }
  });
  const operation = useRef<HeldOperation | null>(recovery.held);
  const recoveryOwner = useRef(userId);
  useEffect(() => {
    if (recoveryOwner.current !== userId) {
      recoveryOwner.current = userId;
      try {
        const held = store?.load() ?? null;
        if (held) store?.adopt();
        operation.current = held;
        setRecovery({ held, blocked: !store || !!held?.state.blocked });
      } catch {
        operation.current = null;
        setRecovery({ held: null, blocked: true });
      }
      setToast(null);
      setBarError("");
      setDialogError("");
      setDialog(null);
      finish();
    }
    account.current.active = true;
    return () => {
      account.current.active = false;
    };
  }, [userId, store]);
  const refreshPending = useCallback(async () => {
    if (
      busyRef.current ||
      lockRequest.current ||
      !account.current.active ||
      account.current.userId !== userId
    )
      return;
    try {
      const held = store?.load() ?? null;
      const elsewhere = await moveWriterBusy(userId);
      if (
        !account.current.active ||
        account.current.userId !== userId ||
        busyRef.current ||
        lockRequest.current
      )
        return;
      // Keep an unrelated owned-only pending request in this tab; shared mixed recovery takes precedence.
      if (!held && operation.current?.op.noUndo) {
        setBarError("");
        setDialogError("");
        toastId.current += 1;
        setToast({
          id: toastId.current,
          message: "Move checking finished in another tab.",
          entry: null,
          unavailable: false,
        });
      }
      if (held || operation.current?.op.noUndo) operation.current = held;
      setRecovery({ held, blocked: !store || !!held?.state.blocked });
      setOtherTab(elsewhere);
    } catch {
      const held = operation.current?.op.noUndo ? operation.current : null;
      if (held) held.state.blocked = true;
      setRecovery({ held, blocked: true });
    }
  }, [store, userId]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (
        event.storageArea === localStorage &&
        (event.key === null ||
          event.key === moveActivityKey(userId) ||
          event.key?.startsWith(
            `prizecheck:mixed-move:v1:${encodeURIComponent(userId)}:`
          ))
      )
        void refreshPending();
    };
    const focused = () => void refreshPending();
    window.addEventListener("storage", changed);
    window.addEventListener("focus", focused);
    void refreshPending();
    return () => {
      window.removeEventListener("storage", changed);
      window.removeEventListener("focus", focused);
    };
  }, [refreshPending, userId]);
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

  const edition = useCallback(
    (editionId: string) => {
      for (const [key, label] of labels)
        if (key.endsWith(`:${editionId}`)) return cardText(label);
      return "a card";
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

  // A server that violated the no-Undo postcondition must not supply any Undo offers in this workspace.
  const readUndo = useCallback(async () => {
    if (undoProtectionUnconfirmed(operation.current)) return [] as UndoEntry[];
    const entries = await listUndo();
    return undoProtectionUnconfirmed(operation.current) ? [] : entries;
  }, []);

  const runLocked = useCallback(
    async (
      target: ActionTarget,
      groups: SelectedGroup[],
      borrowed: BorrowedMoveItem[],
      surface: "dialog" | "bar"
    ) => {
      if (
        recoveryOwner.current !== userId ||
        recovery.blocked ||
        busyRef.current ||
        (!operation.current && !groups.length && !borrowed.length)
      )
        return;
      busyRef.current = true;
      setBusy(true);
      setBarError("");
      setDialogError("");
      carried.current = null;
      // The writer always re-reads under the account lock; a stale tab never resumes its own snapshot.
      try {
        const hadMixed = !!operation.current?.op.noUndo;
        const latest = store?.load() ?? null;
        if (latest || hadMixed) operation.current = latest;
        setRecovery({
          held: latest,
          blocked: !store || !!latest?.state.blocked,
        });
        if (hadMixed && !latest) {
          toastId.current += 1;
          setToast({
            id: toastId.current,
            message: "Move checking finished in another tab.",
            entry: null,
            unavailable: false,
          });
          finish();
          return;
        } // Another writer already settled this operation.
      } catch {
        setRecovery({ held: null, blocked: true });
        finish();
        return;
      }
      let createdServerTime: number | undefined;
      if (!operation.current && borrowed.length) {
        try {
          const requestStarted = performance.now();
          const response = await fetch("/auth/session", {
            credentials: "same-origin",
            cache: "no-store",
          });
          const session = await response.json();
          if (
            !response.ok ||
            session.signedIn !== true ||
            session.userId !== userId ||
            !account.current.active ||
            account.current.userId !== userId
          )
            throw new RecoveryBlocked();
          clock.observe(response, requestStarted);
          createdServerTime = Date.parse(response.headers.get("date")!);
        } catch {
          setRecovery({ held: null, blocked: true });
          finish();
          return;
        }
      }
      // Resume the immutable carried request before considering a new target or selection.
      const held =
        target.kind === "move"
          ? operationFor(
              operation.current,
              target.destinationId,
              groups,
              borrowed,
              createdServerTime
            )
          : (operation.current ?? createRemoval(groups));
      operation.current = held;
      if (held.op.noUndo) {
        setRecovery({ held, blocked: false });
        setToast((current) =>
          current ? { ...current, entry: null, unavailable: false } : null
        );
      }
      const active = () =>
        account.current.active && account.current.userId === userId;
      const checkpoint = async (beforeWrite: boolean) => {
        if (!held.op.noUndo) return;
        try {
          if (!active() || !store) throw new RecoveryBlocked();
          if (beforeWrite) {
            if (held.state.blocked) throw new RecoveryBlocked();
            const requestStarted = performance.now();
            const response = await fetch("/auth/session", {
              credentials: "same-origin",
              cache: "no-store",
            });
            const session = await response.json();
            if (
              !response.ok ||
              session.signedIn !== true ||
              session.userId !== userId ||
              held.state.blocked ||
              !active()
            )
              throw new RecoveryBlocked();
            clock.check(held, response, requestStarted);
            store.prune(clock.serverDate());
          }
          store.save(held);
          setRecovery({ held, blocked: !!held.state.blocked });
        } catch {
          throw new RecoveryBlocked();
        }
      };
      setProgress(held.op.target.kind === "move" ? "Moving…" : "Removing…");
      try {
        // Initial storage is established before even preparing a manifest.
        if (held.op.noUndo) await checkpoint(false);
        const outcome = await advance(
          held.op,
          held.state,
          {
            ...moveApi,
            moveBorrowedCopies: async (body) => {
              const result = await moveApi.moveBorrowedCopies(body);
              if (!active()) throw new RecoveryBlocked();
              // Remove confirmed Borrowed entries before preparing or committing the owned stage.
              live.current.selection.dropBorrowed();
              return result;
            },
          },
          checkpoint
        );
        if (!active()) return;
        const { op, state } = held;
        if (outcome.kind !== "unknown") {
          if (op.noUndo) {
            try {
              const requestStarted = performance.now();
              const response = await fetch("/auth/session", {
                credentials: "same-origin",
                cache: "no-store",
              });
              const session = await response.json();
              if (
                !response.ok ||
                session.signedIn !== true ||
                session.userId !== userId ||
                !active()
              )
                throw new RecoveryBlocked();
              clock.observe(response, requestStarted);
              store?.remove(
                held,
                state.refusal ? "refused" : "done",
                clock.serverDate()
              );
              store?.prune(clock.serverDate());
              const next = store?.load() ?? null;
              if (next) store?.adopt();
              operation.current = next;
              setRecovery({ held: next, blocked: false });
            } catch {
              setRecovery({ held, blocked: true });
              return;
            }
          } else operation.current = null;
        } else if (op.noUndo) setRecovery({ held, blocked: !!state.blocked });
        const destination =
          op.target.kind === "move" ? place(op.target.destinationId) : "";
        if (outcome.kind === "done") {
          const copies =
            Number(state.borrowedResult?.copy_count ?? 0) +
            Number(state.ownedResult?.copy_count ?? 0);
          const stayed =
            op.stayed +
            Number(state.ownedResult?.already_at_destination_count ?? 0);
          const message =
            op.target.kind === "move"
              ? `Moved ${countText(String(copies), "copy", "copies")} to ${destination}.${stayed ? ` ${countText(String(stayed), "copy", "copies")} already there stayed.` : ""}`
              : `Removed ${countText(String(copies), "copy", "copies")} from your Collection.`;
          focusAfter.current = "heading";
          keepFocus("heading");
          live.current.selection.clear();
          setDialog(null);
          showToast({ message, entry: null, unavailable: false });
          live.current.reloadGallery();
          void live.current.reloadTree();
          if (!op.noUndo && state.ownedResult) {
            const result = state.ownedResult;
            const id = toastId.current;
            const entries = await readUndo().catch(() => [] as UndoEntry[]);
            const newest = entries[0];
            const mine =
              newest &&
              (result.undo_id
                ? newest.id === result.undo_id
                : newest.action === op.target.kind &&
                  newest.source_count === result.source_count &&
                  (op.target.kind !== "move" ||
                    newest.destination_id === op.target.destinationId))
                ? newest
                : null;
            setToast((current) =>
              current?.id === id ? { ...current, entry: mine } : current
            );
          }
          return;
        }
        let failure =
          outcome.stage === "borrowed"
            ? outcome.kind === "unknown"
              ? borrowedUnknownFailure()
              : describeBorrowedFailure(outcome.error, destination)
            : describeFailure(
                op.target,
                outcome.error,
                { place, card, edition },
                {
                  omitNothing: !!state.borrowedResult,
                  unknown: outcome.kind === "unknown",
                  unsupported:
                    op.noUndo &&
                    outcome.kind === "refused" &&
                    outcome.error instanceof MoveError &&
                    outcome.error.code === "MOVE_REQUEST_FAILED" &&
                    [404, 405].includes(outcome.error.status),
                }
              );
        if (
          op.noUndo &&
          state.owned === "done" &&
          state.ownedResult &&
          state.ownedResult.undo_id !== null
        )
          failure = unsupportedUndoFailure(
            Number(state.borrowedResult?.copy_count ?? 0) +
              Number(state.ownedResult.copy_count),
            destination
          );
        else if (outcome.stage === "owned" && state.borrowedResult)
          failure = partialMoveFailure(
            Number(state.borrowedResult.copy_count),
            destination,
            failure,
            outcome.kind === "unknown"
          );
        carried.current = failure.reloadGallery
          ? {
              toastText: failure.toastText,
              selection: live.current.selection.selected,
              mixed: op.noUndo,
            }
          : null;
        if (failure.reloadGallery) live.current.reloadGallery();
        if (failure.reloadTree || failure.reloadGallery)
          void live.current.reloadTree();
        if (surface === "dialog" && dialogRef.current)
          setDialogError(failure.text);
        else setBarError(failure.text);
      } catch {
        if (active() && held.op.noUndo) {
          held.state.blocked = true;
          setRecovery({ held, blocked: true });
        }
      } finally {
        if (active()) finish();
      }
    },
    [
      place,
      card,
      edition,
      showToast,
      readUndo,
      userId,
      store,
      clock,
      recovery.blocked,
    ]
  );

  const run = useCallback(
    async (...args: Parameters<typeof runLocked>) => {
      if (
        lockRequest.current ||
        busyRef.current ||
        !account.current.active ||
        account.current.userId !== userId
      )
        return;
      lockRequest.current = true;
      try {
        await withMoveWriter(userId, async () => {
          if (!account.current.active || account.current.userId !== userId)
            return;
          setOtherTab(false);
          await runLocked(...args);
        });
      } catch (error) {
        if (!account.current.active || account.current.userId !== userId)
          return;
        if (error instanceof MoveInAnotherTab) {
          setOtherTab(true);
          try {
            const held = store?.load() ?? null;
            operation.current = held;
            setRecovery({ held, blocked: !store || !!held?.state.blocked });
          } catch {
            setRecovery((current) => ({ ...current, blocked: true }));
          }
        } else if (
          error instanceof MoveLocksUnavailable &&
          !args[2].length &&
          !operation.current?.op.noUndo
        ) {
          // Legacy owned-only Moves need no mixed-recovery writer when there is no shared operation.
          try {
            if (!store?.load()) await runLocked(...args);
            else setRecovery((current) => ({ ...current, blocked: true }));
          } catch {
            setRecovery((current) => ({ ...current, blocked: true }));
          }
        } else setRecovery((current) => ({ ...current, blocked: true }));
      } finally {
        lockRequest.current = false;
      }
    },
    [runLocked, userId, store]
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
        selectedBorrowed(live.current.selection.selected),
        "dialog"
      ),
    [run]
  );
  const confirmRemoval = useCallback(
    () =>
      void run(
        { kind: "remove" },
        selectedGroups(live.current.selection.selected),
        [],
        "dialog"
      ),
    [run]
  );
  /** A drop on a valid sidebar Storage Leaf moves at once; errors show in the selection bar. */
  const dropMove = useCallback(
    (
      destinationId: string,
      carried: { groups: SelectedGroup[]; borrowed: BorrowedMoveItem[] }
    ) =>
      run(
        { kind: "move", destinationId },
        carried.groups,
        carried.borrowed,
        "bar"
      ),
    [run]
  );
  /** A batch add from Add cards (#175) succeeded: the toast names it, the gallery and the tree read again, and Undo
   * is offered for the add's one record while it is the newest (Undo applies the newest record alone). */
  const added = useCallback(
    async (result: AddedCards) => {
      showToast({
        message: batchAddedText(result.copies, result.path),
        entry: null,
        unavailable: false,
      });
      live.current.reloadGallery();
      void live.current.reloadTree();
      const id = toastId.current;
      const entries = await readUndo().catch(() => [] as UndoEntry[]);
      const mine = entries[0]?.id === result.undoId ? entries[0] : null;
      setToast((current) =>
        current && current.id === id ? { ...current, entry: mine } : current
      );
    },
    [showToast, readUndo]
  );
  // A Lend Offer (#258): the selected copies with their cards' names, as the offer dialog lists them.
  const lendRows = useCallback(
    (): LendRow[] =>
      Array.from(live.current.selection.selected.values())
        .filter((entry) => !entry.loanId)
        .map((entry) => {
          const label = labels.get(entry.key);
          return {
            key: entry.key,
            locationId: entry.locationId,
            editionId: entry.editionId,
            count: entry.count,
            card: label ? cardText(label) : "Unknown card",
          };
        }),
    [labels]
  );
  const clearSelection = useCallback(() => {
    carried.current = null;
    setBarError("");
    live.current.selection.clear();
  }, []);

  const undo = useCallback(async () => {
    const current = toastLive.current;
    const entry = current?.entry;
    if (undoProtectionUnconfirmed(operation.current)) {
      showToast({
        message: "Undo unavailable. Refresh before continuing.",
        entry: null,
        unavailable: true,
      });
      return;
    }
    if (!current || !entry || current.unavailable || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const key = undoKeys.current.get(entry.id) ?? crypto.randomUUID();
    undoKeys.current.set(entry.id, key);
    try {
      const result = await applyUndo(entry.id, key);
      undoKeys.current.delete(entry.id);
      showToast({
        message:
          entry.action === "add"
            ? addUndoneText(result.copy_count, place(entry.destination_id!))
            : `Undo restored ${countText(result.copy_count, "copy", "copies")} to ${plural(result.source_count, "location", "locations")}.`,
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
        // An add's Undo names its Location, and the Card Edition that has left it.
        const reason =
          entry.action === "add" && destination_id && edition_id
            ? `copies of ${card(destination_id, edition_id)} have left ${place(destination_id)}`
            : source_id && edition_id
              ? `copies of ${card(source_id, edition_id)} it would return to ${place(source_id)} have changed`
              : source_id || destination_id
                ? `${place((source_id ?? destination_id)!)} can no longer hold cards`
                : "the cards have changed";
        showToast({
          message: `Undo unavailable: ${reason}, so nothing was ${entry.action === "add" ? "removed" : "restored"}. Dismiss it to reach an earlier action.`,
          entry,
          unavailable: true,
          focus: true,
        });
      } else if (code === "PROMISED_TO_LOAN" || code === "PROMISED_TO_TRADE") {
        // #252 and Trading #270: undoing the add would leave fewer copies than open Loans or Trades promised.
        undoKeys.current.delete(entry.id);
        showToast({
          message: `Undo unavailable: you promised some of these copies to a ${code === "PROMISED_TO_TRADE" ? "Trade" : "Loan"}, so nothing was removed. Dismiss it to reach an earlier action.`,
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
        const entries = await readUndo().catch(() => [] as UndoEntry[]);
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
  }, [place, card, showToast, readUndo]);

  const dismiss = useCallback(async () => {
    const current = toastLive.current;
    const entry = current?.entry;
    if (undoProtectionUnconfirmed(operation.current)) {
      showToast({
        message: "Undo unavailable. Refresh before continuing.",
        entry: null,
        unavailable: true,
      });
      return;
    }
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
      const entries = await readUndo().catch(() => [] as UndoEntry[]);
      const next = entries[0] ?? null;
      showToast({
        message: next
          ? `Dismissed. The earlier ${ACTION_NAMES[next.action]} can be undone.`
          : "Dismissed. There is no earlier action to undo.",
        entry: next,
        unavailable: false,
        focus: true,
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [showToast, readUndo]);

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
        entry: failure.mixed ? null : (toastLive.current?.entry ?? null),
        unavailable: failure.mixed
          ? false
          : (toastLive.current?.unavailable ?? false),
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

  const recoveryHeld = recovery.held;
  const recoveryBlocked = recovery.blocked || !!recoveryHeld?.state.blocked;
  const checkPending = useCallback(() => {
    const held = operation.current;
    if (held && !recoveryBlocked) return run(held.op.target, [], [], "bar");
  }, [run, recoveryBlocked]);
  const dismissPending = useCallback(
    async (reviewed: boolean) => {
      if (
        !reviewed ||
        busyRef.current ||
        lockRequest.current ||
        !recoveryBlocked ||
        !account.current.active ||
        account.current.userId !== userId
      )
        return;
      lockRequest.current = true;
      try {
        await withMoveWriter(userId, async () => {
          const requestStarted = performance.now();
          const response = await fetch("/auth/session", {
            credentials: "same-origin",
            cache: "no-store",
          });
          const session = await response.json();
          if (
            !response.ok ||
            session.signedIn !== true ||
            session.userId !== userId ||
            !account.current.active ||
            account.current.userId !== userId
          )
            throw new RecoveryBlocked();
          clock.observe(response, requestStarted);
          const serverNow = clock.serverDate();
          let latest: HeldOperation | null = null;
          try {
            latest = store?.load() ?? null;
          } catch {
            // Explicit review acknowledges unreadable or erased records; it never reconstructs a Move.
            store?.dismissUnreadable(serverNow);
          }
          if (latest && recovery.held && latest.op.id === recovery.held.op.id)
            store?.remove(latest, "reviewed", serverNow);
          store?.prune(serverNow);
          const next = store?.load() ?? null;
          operation.current = next;
          setRecovery({ held: next, blocked: !store || !!next?.state.blocked });
          setOtherTab(false);
          setBarError("");
          setDialogError("");
        });
      } catch (error) {
        if (error instanceof MoveInAnotherTab) {
          setOtherTab(true);
          try {
            const held = store?.load() ?? null;
            operation.current = held;
            setRecovery({ held, blocked: !store || !!held?.state.blocked });
          } catch {
            setRecovery((current) => ({ ...current, blocked: true }));
          }
        } else setRecovery((current) => ({ ...current, blocked: true }));
      } finally {
        lockRequest.current = false;
      }
    },
    [store, recoveryBlocked, userId, clock, recovery.held]
  );

  return {
    pending:
      recoveryOwner.current === userId &&
      (recoveryHeld || recovery.blocked || otherTab)
        ? {
            id: recoveryHeld?.op.id ?? "unreadable",
            text: recoveryText(
              recoveryHeld,
              recoveryHeld?.op.target.kind === "move"
                ? place(recoveryHeld.op.target.destinationId)
                : "the destination",
              recoveryBlocked,
              otherTab
            ),
            blocked: recoveryBlocked,
            otherTab,
          }
        : null,
    refreshPending,
    checkPending,
    dismissPending,
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
    lendRows,
    closeDialog,
    confirmMove,
    confirmRemoval,
    dropMove,
    clearSelection,
    added,
    undo,
    dismiss,
    closeToast,
  };
}
