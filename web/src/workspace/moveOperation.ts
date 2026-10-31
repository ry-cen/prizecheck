import { dismissUndo, removeInventory, type UndoEntry } from "../inventoryUndo";
import {
  BorrowedMoveError,
  type BorrowedMoveItem,
  type BorrowedMoveResult,
  moveBorrowedCopies,
} from "../collection_generated";
import {
  MoveError,
  startMove,
  stageMove,
  commitMove,
  type MoveResult,
} from "../moves_generated";
import { STAGE_BATCH, type ActionTarget } from "./inventoryActionsModel";
import type { SelectedGroup } from "./selectionModel";

type Stage = "todo" | "done" | "unknown";
export type MoveOperation = Readonly<{
  target: Readonly<ActionTarget>;
  owned: readonly SelectedGroup[];
  borrowed: readonly BorrowedMoveItem[];
  stayed: number;
  noUndo: boolean;
  borrowedKey: string;
  ownedKey: string;
}>;
export type OperationState = {
  manifestId: string | null;
  staged: boolean;
  borrowed: Stage;
  owned: Stage;
  discard: Stage;
  borrowedAttempted: boolean;
  ownedAttempted: boolean;
  borrowedResult?: BorrowedMoveResult;
  ownedResult?: MoveResult;
};
export type Outcome =
  | { kind: "done" }
  | {
      kind: "refused" | "unknown";
      stage: "borrowed" | "owned" | "discard";
      error: unknown;
    };
export const moveApi = {
  moveBorrowedCopies,
  startMove,
  stageMove,
  commitMove,
  removeInventory,
  dismissUndo,
};
export type HeldOperation = { op: MoveOperation; state: OperationState };
export function createOperation(
  destinationId: string,
  owned: SelectedGroup[],
  borrowed: BorrowedMoveItem[]
): HeldOperation {
  const moving = borrowed.filter(
    (item) => item.from_location_id !== destinationId
  );
  return {
    op: Object.freeze({
      target: Object.freeze({ kind: "move" as const, destinationId }),
      owned: Object.freeze(
        owned
          .filter((item) => item.source_id !== destinationId)
          .map((item) => Object.freeze({ ...item }))
      ),
      noUndo: borrowed.length > 0,
      borrowed: Object.freeze(moving.map((item) => Object.freeze({ ...item }))),
      stayed:
        owned
          .filter((item) => item.source_id === destinationId)
          .reduce((sum, item) => sum + Number(item.quantity), 0) +
        borrowed
          .filter((item) => item.from_location_id === destinationId)
          .reduce((sum, item) => sum + Number(item.quantity), 0),
      borrowedKey: crypto.randomUUID(),
      ownedKey: crypto.randomUUID(),
    }),
    state: {
      manifestId: null,
      staged: false,
      borrowed: "todo",
      owned: "todo",
      discard: "todo",
      borrowedAttempted: false,
      ownedAttempted: false,
    },
  };
}
export async function advance(
  op: MoveOperation,
  state: OperationState,
  api = moveApi
): Promise<Outcome> {
  if (
    op.target.kind === "move" &&
    op.borrowed.length &&
    state.borrowed !== "done"
  ) {
    const attempted = state.borrowedAttempted;
    try {
      state.borrowedAttempted = true;
      state.borrowedResult = await api.moveBorrowedCopies({
        to_location_id: op.target.destinationId,
        items: [...op.borrowed],
        idempotency_key: op.borrowedKey,
      });
      state.borrowed = "done";
    } catch (error) {
      if (
        error instanceof BorrowedMoveError &&
        error.status < 500 &&
        !unavailableReplay(error, attempted)
      )
        return { kind: "refused", stage: "borrowed", error };
      state.borrowed = "unknown";
      return { kind: "unknown", stage: "borrowed", error };
    }
  } else if (!op.borrowed.length) state.borrowed = "done";
  if (op.owned.length && state.owned !== "done") {
    const attempted = state.ownedAttempted;
    try {
      state.manifestId ??= (await api.startMove()).id;
      if (!state.staged) {
        for (let start = 0; start < op.owned.length; start += STAGE_BATCH)
          await api.stageMove(
            state.manifestId,
            op.owned.slice(start, start + STAGE_BATCH)
          );
        state.staged = true;
      }
      state.ownedAttempted = true;
      state.ownedResult =
        op.target.kind === "move"
          ? await api.commitMove(
              state.manifestId,
              op.target.destinationId,
              op.ownedKey
            )
          : await api.removeInventory(state.manifestId, op.ownedKey);
      state.owned = "done";
    } catch (error) {
      if (
        error instanceof MoveError &&
        error.status < 500 &&
        !unavailableReplay(error, attempted)
      )
        return { kind: "refused", stage: "owned", error };
      state.owned = "unknown";
      return { kind: "unknown", stage: "owned", error };
    }
  } else if (!op.owned.length) state.owned = "done";
  if (op.noUndo && op.owned.length && state.discard !== "done") {
    try {
      const undoId = state.ownedResult?.undo_id;
      if (!undoId)
        throw new Error("The committed Move did not identify its Undo record");
      try {
        await api.dismissUndo(undoId);
      } catch (error) {
        // DELETE is safe to repeat after losing its response; an absent record is already discarded.
        if (!(error instanceof MoveError && error.status === 404)) throw error;
      }
      state.discard = "done";
    } catch (error) {
      state.discard = "unknown";
      return { kind: "unknown", stage: "discard", error };
    }
  } else if (!op.noUndo || !op.owned.length) state.discard = "done";
  return { kind: "done" };
}

/** Losing a receipt does not prove that a previously attempted commit failed. */
function unavailableReplay(
  error: MoveError | BorrowedMoveError,
  attempted: boolean
): boolean {
  return (
    error.code === "REPLAY_OUTCOME_UNAVAILABLE" ||
    (attempted &&
      (error.code === "MOVE_MANIFEST_NOT_FOUND" ||
        error.code === "MOVE_MANIFEST_EXPIRED"))
  );
}

/** Until discard is confirmed, no lookup or later stack traversal may expose the mixed Move's owned half. */
export function offerableUndo(
  entries: UndoEntry[],
  held: HeldOperation | null,
  suppressed: ReadonlySet<string> = new Set()
): UndoEntry[] {
  if (
    held?.op.noUndo &&
    held.state.discard !== "done" &&
    held.state.ownedAttempted
  ) {
    const id = held.state.ownedResult?.undo_id;
    if (!id) return [];
    // Do not promote an older record while the forbidden record still blocks it on the server.
    const index = entries.findIndex((entry) => entry.id === id);
    if (index >= 0) entries = entries.slice(0, index);
  }
  return entries.filter((entry) => !suppressed.has(entry.id));
}

/** An unresolved outcome always wins over a newly requested Move. */
export function operationFor(
  held: HeldOperation | null,
  destination: string,
  owned: SelectedGroup[],
  borrowed: BorrowedMoveItem[]
) {
  return held ?? createOperation(destination, owned, borrowed);
}

/** Removal uses the same immutable owned stage, with no Borrowed stage or destination. */
export function createRemoval(owned: SelectedGroup[]): HeldOperation {
  const held = createOperation("", owned, []);
  return {
    ...held,
    op: Object.freeze({
      ...held.op,
      target: Object.freeze({ kind: "remove" as const }),
    }),
  };
}
