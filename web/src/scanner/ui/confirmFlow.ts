// What a ConfirmResult means for the screen. Pure; the tray store has already changed the tray (frozen, unfrozen, marked
// rows, cleared destination) and this says what to show and where to go.
import type { ConfirmResult } from "../tray/store";
import { addedToast, SAVE_FAILED } from "./copy";

export type ConfirmEffect =
  /** Leave for the destination's Collection; the toast waits for the page there. */
  | { kind: "land"; locationId: string; toast: string }
  | { kind: "reopen-picker" }
  /** Exactly these rows need a finish; `searchRowIds` need a new card, not a finish. */
  | { kind: "mark-rows"; searchRowIds: string[] }
  /** The save did not finish: the tray stays frozen and Retry is offered. */
  | { kind: "frozen" }
  /** The tray may already be saved (the note shows from the store). */
  | { kind: "stale-save" }
  | { kind: "message"; text: string }
  | { kind: "none" };

export function confirmEffect(
  result: ConfirmResult,
  where: string
): ConfirmEffect {
  switch (result.kind) {
    case "saved":
      return {
        kind: "land",
        locationId: result.result.location_id,
        toast: addedToast(result.result.copy_count, where),
      };
    case "destination_changed":
      return { kind: "reopen-picker" };
    case "editions_changed":
      return { kind: "mark-rows", searchRowIds: result.searchRowIds };
    case "pending":
      return { kind: "frozen" };
    case "stale_save":
      return { kind: "stale-save" };
    case "key_reused":
    case "failed":
      return { kind: "message", text: SAVE_FAILED };
    case "blocked":
      return { kind: "none" };
  }
}
