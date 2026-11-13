import { undoDismissals, noticeTurn } from "../inventoryUndoNotice";
import { useCallback, useEffect, useRef } from "react";
import { applyUndo, listUndo, type UndoEntry } from "../inventoryUndo";
import { MoveError } from "../moves_generated";
import { type ToastInput, useToast } from "../ui/Toast";
import type { AddItem } from "./cardActions";
import { addUndoFailed, addUndoneText, batchAddedText } from "./catalogText";

/** A batch add that succeeded (#175): where the copies went, what they were, and the add's one Undo record. */
export type AddedCards = {
  locationId: string;
  /** The Location's path, for messages ("Shelf / Binder 2"). */
  path: string;
  items: readonly AddItem[];
  copies: number;
  ownerRevision: number;
  undoId: string;
  /** Add N cards in Add mode's bar, or the card popup's Add N. */
  from: "bar" | "popup";
};

/** The toast's Undo, pressed from inside the popup: it resolves to the toast's new message ("" when nothing was
 * done), and the Undo to offer next (a failure that can be retried) or null. */
export type InlineUndoResult = {
  message: string;
  next: InlineUndo | null;
  /** True only when the copies were removed, even if another toast replaced this one. */
  undone: boolean;
  ownerRevision?: number;
};
export type InlineUndo = {
  (): Promise<InlineUndoResult>;
  isAvailable: () => boolean;
  /** Catalog AddRows alone claims the action until its inline control leaves. */
  claimInline?: () => () => void;
};

type Options = {
  /** False while another page is shown: the toast leaves with Catalog. */
  shown: boolean;
  /** The Undo took the copies out again: the gallery's tiles drop by them. */
  onUndone: (added: AddedCards, ownerRevision: number) => void;
};

/**
 * Catalog's toast after a batch add (#175, spec "Catalog": Add N cards calls the batch add once, with one Undo toast),
 * on the app's one toast host. It names what was added and where, and offers Undo for the add's one Inventory Undo
 * record while that record is the owner's newest (Undo applies only the newest, as in Collection). Undo goes through
 * POST /api/moves/undo/{id}; a request with no answer keeps its idempotency key, so pressing Undo again applies it
 * once. After Add N cards the toast takes focus, since the bar's button it came from is disabled (hidden on a phone)
 * once the queue empties; after the popup's Add N it waits behind the popup, which is modal, so the popup offers the
 * same Undo beside its own line (an InlineUndo) and the toast is there when the popup closes. Collection's Add cards
 * popup also uses this through its Workspace add notification owner.
 *
 * Returns `added(result)`, which the gallery calls once a batch add succeeds. It resolves to the toast's Undo for the
 * popup to offer (null when the toast offers none).
 */
export function useAddToast({ shown, onUndone }: Options) {
  const kit = useToast();
  const live = useRef(onUndone);
  live.current = onUndone;
  const current = useRef<number | null>(null);
  const inputs = useRef(new Map<number, ToastInput>());
  const owned = useRef(new Set<number>());
  const keys = useRef(new Map<string, string>());
  const running = useRef(new Map<number, Promise<InlineUndoResult>>());

  // Leaving Catalog (another page, or signing out) takes the toast down.
  useEffect(() => {
    if (shown || current.current === null) return;
    kit.dismiss(current.current);
    current.current = null;
  }, [shown, kit]);
  useEffect(
    () => () => {
      if (current.current !== null) kit.dismiss(current.current);
      current.current = null;
    },
    [kit]
  );

  const show = useCallback(
    (
      message: string,
      added: AddedCards | null,
      focus: boolean,
      undoable = !!added
    ) => {
      const input: ToastInput = {
        message,
        action:
          added && undoable
            ? {
                label: "Undo",
                keepOpen: true,
                onAction: () => {
                  if (kit.isShown(id)) void undo(added, id, message);
                },
              }
            : undefined,
        focus,
        onDismiss: added ? () => dismiss(added, id, undoable) : undefined,
      };
      const id = kit.show(input);
      inputs.current.clear();
      inputs.current.set(id, input);
      current.current = id;
      return id;
    },
    // undo reads only refs and calls show; both live as long as the toast host.
    [kit]
  );

  function dismiss(added: AddedCards, id: number, undoable: boolean) {
    // One DELETE per record is shared page-wide; retries show only while no other owner has shown since.
    const turn = noticeTurn(kit, () => current.current);
    void undoDismissals.dismiss(added.undoId).then((outcome) => {
      if (current.current !== id) return;
      if (outcome === "dismissed") {
        current.current = null;
        return;
      }
      if (turn())
        show("Couldn't dismiss this Undo. Try again.", added, false, undoable);
    });
  }

  function undo(
    added: AddedCards,
    toastId: number,
    message: string
  ): Promise<InlineUndoResult> {
    const pending = running.current.get(toastId);
    if (pending) return pending;
    const request = performUndo(added, toastId, message).finally(() => {
      running.current.delete(toastId);
    });
    running.current.set(toastId, request);
    return request;
  }

  async function performUndo(
    added: AddedCards,
    toastId: number,
    message: string
  ): Promise<InlineUndoResult> {
    const inlineOwned = owned.current.has(toastId);
    const input: ToastInput = {
      message,
      action: { label: "Undo", onAction: () => {}, busy: true, keepOpen: true },
      onDismiss: () => dismiss(added, toastId, false),
    };
    inputs.current.set(toastId, input);
    kit.update(toastId, {
      ...input,
      action: inlineOwned ? undefined : input.action,
    });
    const key = keys.current.get(added.undoId) ?? crypto.randomUUID();
    keys.current.set(added.undoId, key);
    try {
      const result = await applyUndo(added.undoId, key);
      keys.current.delete(added.undoId);
      const outcome = addUndoneText(result.copy_count, added.path);
      // Always report the actual outcome to the popup, while leaving a replacement toast alone.
      if (kit.isShown(toastId)) show(outcome, null, !inlineOwned);
      live.current(added, result.owner_revision);
      return {
        message: outcome,
        next: null,
        undone: true,
        ownerRevision: result.owner_revision,
      };
    } catch (cause) {
      const retry = !(cause instanceof MoveError) || cause.status >= 500;
      if (!retry) keys.current.delete(added.undoId);
      const outcome = addUndoFailed(
        cause instanceof MoveError ? cause.code : "",
        retry
      );
      let next: InlineUndo | null = null;
      if (kit.isShown(toastId)) {
        const id = show(outcome, added, !inlineOwned, retry);
        if (retry) next = inline(id, added, outcome);
      }
      return { message: outcome, next, undone: false };
    }
  }

  /** Both entry points await the same request, so the popup sees the outcome even when Undo began on the toast. */
  function inline(
    toastId: number,
    added: AddedCards,
    message: string
  ): InlineUndo {
    return Object.assign(
      async () => {
        const pending = running.current.get(toastId);
        if (pending) return pending;
        if (!kit.isShown(toastId))
          return { message: "", next: null, undone: false };
        return undo(added, toastId, message);
      },
      {
        isAvailable: () => kit.isShown(toastId),
        claimInline: () => {
          owned.current.add(toastId);
          const input = inputs.current.get(toastId);
          if (input) kit.update(toastId, { ...input, action: undefined });
          return () => {
            owned.current.delete(toastId);
            const latest = inputs.current.get(toastId);
            if (latest) kit.update(toastId, latest);
          };
        },
      }
    );
  }

  return useCallback(
    async (added: AddedCards): Promise<InlineUndo | null> => {
      const turn = noticeTurn(kit, () => null);
      const entries = await listUndo().catch(() => [] as UndoEntry[]);
      if (!turn()) return null;
      const undoable = entries[0]?.id === added.undoId;
      show(
        batchAddedText(added.copies, added.path),
        added,
        added.from === "bar",
        undoable
      );
      const id = current.current;
      return undoable && id !== null
        ? inline(id, added, batchAddedText(added.copies, added.path))
        : null;
    },
    // inline reads only refs and calls undo; both live as long as the toast host.
    [show, kit]
  );
}
