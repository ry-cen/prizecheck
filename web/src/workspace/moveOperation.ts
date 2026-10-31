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
import { STAGE_BATCH } from "./inventoryActionsModel";
import type { SelectedGroup } from "./selectionModel";

type Stage = "todo" | "done" | "unknown";
export type MoveOperation = Readonly<{
  target: { kind: "move"; destinationId: string };
  owned: readonly SelectedGroup[];
  borrowed: readonly BorrowedMoveItem[];
  stayed: number;
  borrowedKey: string;
  ownedKey: string;
}>;
export type OperationState = {
  manifestId: string | null;
  staged: boolean;
  borrowed: Stage;
  owned: Stage;
  borrowedResult?: BorrowedMoveResult;
  ownedResult?: MoveResult;
};
export type Outcome =
  | { kind: "done" }
  | {
      kind: "refused" | "unknown";
      stage: "borrowed" | "owned";
      error: unknown;
    };
export const moveApi = { moveBorrowedCopies, startMove, stageMove, commitMove };
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
      owned: Object.freeze(owned.map((item) => Object.freeze({ ...item }))),
      borrowed: Object.freeze(moving.map((item) => Object.freeze({ ...item }))),
      stayed: borrowed
        .filter((item) => item.from_location_id === destinationId)
        .reduce((sum, item) => sum + Number(item.quantity), 0),
      borrowedKey: crypto.randomUUID(),
      ownedKey: crypto.randomUUID(),
    }),
    state: { manifestId: null, staged: false, borrowed: "todo", owned: "todo" },
  };
}
export async function advance(
  op: MoveOperation,
  state: OperationState,
  api = moveApi
): Promise<Outcome> {
  if (op.borrowed.length && state.borrowed !== "done") {
    try {
      state.borrowedResult = await api.moveBorrowedCopies({
        to_location_id: op.target.destinationId,
        items: [...op.borrowed],
        idempotency_key: op.borrowedKey,
      });
      state.borrowed = "done";
    } catch (error) {
      if (error instanceof BorrowedMoveError && error.status < 500)
        return { kind: "refused", stage: "borrowed", error };
      state.borrowed = "unknown";
      return { kind: "unknown", stage: "borrowed", error };
    }
  } else if (!op.borrowed.length) state.borrowed = "done";
  if (op.owned.length && state.owned !== "done") {
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
      state.ownedResult = await api.commitMove(
        state.manifestId,
        op.target.destinationId,
        op.ownedKey
      );
      state.owned = "done";
    } catch (error) {
      if (error instanceof MoveError && error.status < 500)
        return { kind: "refused", stage: "owned", error };
      state.owned = "unknown";
      return { kind: "unknown", stage: "owned", error };
    }
  } else if (!op.owned.length) state.owned = "done";
  return { kind: "done" };
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
