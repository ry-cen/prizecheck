import { useCallback, useEffect, useRef } from "react";
import type { PickConfirmResult } from "../decks_generated";
import { applyUndo, listUndo, type UndoEntry } from "../inventoryUndo";
import { MoveError } from "../moves_generated";
import { useToast } from "../ui/Toast";
import { copiesText, locationsText } from "./gatherModel";

/**
 * The toast after a Gather (#179) on the app's one toast host. It names what moved and offers Undo for the
 * confirmation's one Inventory Undo record while that record is still the owner's newest (Undo applies only
 * the newest record, as in Collection). Undo goes through POST /api/moves/undo/{id}; a request with no answer
 * keeps its idempotency key, so pressing Undo again applies it once. Inventory Undo never touches the Deck
 * List's own Undo (#177). The toast leaves with the page.
 *
 * Returns `gathered(result)`, which the page calls once a confirmation succeeds and the dialog has closed.
 */
export function useGatherToast(deckName: string, onChanged: () => void) {
  const kit = useToast();
  const live = useRef({ deckName, onChanged });
  live.current = { deckName, onChanged };
  const shown = useRef<number | null>(null);
  const keys = useRef(new Map<string, string>());
  const busy = useRef(false);

  // Leaving the Deck (or signing out) takes the toast down with the page.
  useEffect(
    () => () => {
      if (shown.current !== null) kit.dismiss(shown.current);
      shown.current = null;
    },
    [kit]
  );

  const show = useCallback(
    (message: string, undoId: string | null) => {
      const id = kit.show({
        message,
        action: undoId
          ? {
              label: "Undo",
              keepOpen: true,
              onAction: () => void undo(undoId, id, message),
            }
          : undefined,
        focus: true,
      });
      shown.current = id;
    },
    [kit]
  );

  async function undo(undoId: string, toastId: number, message: string) {
    if (busy.current) return;
    busy.current = true;
    kit.update(toastId, {
      message,
      action: { label: "Undo", onAction: () => {}, busy: true, keepOpen: true },
    });
    const key = keys.current.get(undoId) ?? crypto.randomUUID();
    keys.current.set(undoId, key);
    try {
      const result = await applyUndo(undoId, key);
      keys.current.delete(undoId);
      show(
        `Undo put ${copiesText(result.copy_count)} back in ${locationsText(result.source_count)}.`,
        null
      );
      live.current.onChanged();
    } catch (cause) {
      if (!(cause instanceof MoveError) || cause.status >= 500) {
        // No answer: the same key makes pressing Undo again apply it once.
        show("Undo may not have finished. Try again to check safely.", undoId);
        return;
      }
      keys.current.delete(undoId);
      show(
        cause.code === "UNDO_INCOMPATIBLE"
          ? "Undo unavailable: these cards have moved since, so nothing was put back."
          : cause.code === "UNDO_NOT_NEWEST"
            ? "Undo unavailable: you've changed your collection since, so nothing was put back."
            : cause.code === "REPLAY_OUTCOME_UNAVAILABLE"
              ? "Undo may already have finished. This Deck was refreshed: check it before trying again."
              : "That Undo is no longer available.",
        null
      );
      live.current.onChanged();
    } finally {
      busy.current = false;
    }
  }

  return useCallback(
    async (result: PickConfirmResult) => {
      const message = `Moved ${copiesText(result.copy_count)} from ${locationsText(result.source_count)} into ${live.current.deckName}.`;
      const entries = await listUndo().catch(() => [] as UndoEntry[]);
      show(message, entries[0]?.id === result.undo_id ? result.undo_id : null);
    },
    [show]
  );
}
