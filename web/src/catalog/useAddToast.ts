import { useCallback, useEffect, useRef } from "react";
import { applyUndo, listUndo, type UndoEntry } from "../inventoryUndo";
import { MoveError } from "../moves_generated";
import { useToast } from "../ui/Toast";
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
export type InlineUndo = () => Promise<{
  message: string;
  next: InlineUndo | null;
}>;

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
 * gallery doesn't use this: Collection shows its own toast.
 *
 * Returns `added(result)`, which the gallery calls once a batch add succeeds. It resolves to the toast's Undo for the
 * popup to offer (null when the toast offers none).
 */
export function useAddToast({ shown, onUndone }: Options) {
  const kit = useToast();
  const live = useRef(onUndone);
  live.current = onUndone;
  const current = useRef<number | null>(null);
  const keys = useRef(new Map<string, string>());
  const busy = useRef(false);

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

  // The newest toast's message and Undo, for the popup's InlineUndo.
  const offered = useRef<{ message: string; added: AddedCards | null }>({
    message: "",
    added: null,
  });

  const show = useCallback(
    (message: string, added: AddedCards | null, focus: boolean) => {
      offered.current = { message, added };
      const id = kit.show({
        message,
        action: added
          ? {
              label: "Undo",
              keepOpen: true,
              onAction: () => void undo(added, id, message),
            }
          : undefined,
        focus,
      });
      current.current = id;
    },
    // undo reads only refs and calls show; both live as long as the toast host.
    [kit]
  );

  async function undo(added: AddedCards, toastId: number, message: string) {
    if (busy.current) return;
    busy.current = true;
    kit.update(toastId, {
      message,
      action: { label: "Undo", onAction: () => {}, busy: true, keepOpen: true },
    });
    const key = keys.current.get(added.undoId) ?? crypto.randomUUID();
    keys.current.set(added.undoId, key);
    try {
      const result = await applyUndo(added.undoId, key);
      keys.current.delete(added.undoId);
      // The copies are out either way; the message only replaces this toast, never a newer one (#196).
      if (kit.isShown(toastId))
        show(addUndoneText(result.copy_count, added.path), null, true);
      live.current(added, result.owner_revision);
    } catch (cause) {
      const retry = !(cause instanceof MoveError) || cause.status >= 500;
      if (!retry) keys.current.delete(added.undoId);
      if (kit.isShown(toastId))
        show(
          addUndoFailed(cause instanceof MoveError ? cause.code : "", retry),
          retry ? added : null,
          true
        );
    } finally {
      busy.current = false;
    }
  }

  /** The popup's Undo for the toast with this id: it acts only while that toast is up and still offers Undo, and
   * follows the toast the Undo leaves (a retry stays offered). */
  function inline(toastId: number): InlineUndo {
    return async () => {
      const { added, message } = offered.current;
      if (!kit.isShown(toastId) || !added) return { message: "", next: null };
      await undo(added, toastId, message);
      // Undo replaces the toast with its outcome (current then names the new one, not drawn yet).
      const now = current.current;
      if (now === null) return { message: "", next: null };
      // Still the same toast: it was taken down, or an Undo pressed on the toast itself was already under way.
      if (now === toastId)
        return {
          message: "",
          next: kit.isShown(toastId) ? inline(toastId) : null,
        };
      return {
        message: offered.current.message,
        next: offered.current.added ? inline(now) : null,
      };
    };
  }

  return useCallback(
    async (added: AddedCards): Promise<InlineUndo | null> => {
      const entries = await listUndo().catch(() => [] as UndoEntry[]);
      const undoable = entries[0]?.id === added.undoId;
      show(
        batchAddedText(added.copies, added.path),
        undoable ? added : null,
        added.from === "bar"
      );
      const id = current.current;
      return undoable && id !== null ? inline(id) : null;
    },
    // inline reads only refs and calls undo; both live as long as the toast host.
    [show]
  );
}
