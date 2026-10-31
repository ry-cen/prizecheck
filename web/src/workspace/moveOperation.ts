import { removeInventory } from "../inventoryUndo";
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
  commitMoveWithoutUndo,
  type MoveResult,
} from "../moves_generated";
import { STAGE_BATCH, type ActionTarget } from "./inventoryActionsModel";
import type { SelectedGroup } from "./selectionModel";

type Stage = "todo" | "done" | "unknown" | "refused";
export const PENDING_MOVE_MAX_AGE_MS = 23 * 60 * 60 * 1000;
export class RecoveryBlocked extends Error {}
export type MoveOperation = Readonly<{
  id: string;
  createdAt: number;
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
  manifestAttempted?: boolean;
  staged: boolean;
  borrowed: Stage;
  owned: Stage;
  borrowedAttempted: boolean;
  ownedAttempted: boolean;
  blocked?: boolean;
  refusal?: { stage: "owned" | "borrowed"; status: number; code: string };
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
export const moveApi = {
  moveBorrowedCopies,
  startMove,
  stageMove,
  commitMove,
  commitMoveWithoutUndo,
  removeInventory,
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
      id: crypto.randomUUID(),
      createdAt: Date.now(),
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
      manifestAttempted: false,
      staged: false,
      borrowed: moving.length ? "todo" : "done",
      owned: owned.some((item) => item.source_id !== destinationId)
        ? "todo"
        : "done",
      borrowedAttempted: false,
      ownedAttempted: false,
    },
  };
}
export async function advance(
  op: MoveOperation,
  state: OperationState,
  api = moveApi,
  checkpoint: (beforeWrite: boolean) => void | Promise<void> = () => {}
): Promise<Outcome> {
  const refused = state.refusal;
  if (refused)
    return {
      kind: "refused",
      stage: refused.stage,
      error:
        refused.stage === "owned"
          ? new MoveError(refused.status, refused.code)
          : new BorrowedMoveError(refused.status, refused.code),
    };
  if (
    op.noUndo &&
    (state.blocked ||
      (!state.refusal &&
        (state.borrowed !== "done" || state.owned !== "done") &&
        (Date.now() < op.createdAt ||
          Date.now() - op.createdAt >= PENDING_MOVE_MAX_AGE_MS)))
  ) {
    state.blocked = true;
    return {
      kind: "unknown",
      stage: state.borrowed === "done" ? "owned" : "borrowed",
      error: new RecoveryBlocked(),
    };
  }
  const settleFailure = async (
    stage: "owned" | "borrowed",
    error: unknown,
    attempted: boolean
  ): Promise<Outcome> => {
    const preparation = stage === "owned" && !state.ownedAttempted;
    if (
      error instanceof RecoveryBlocked ||
      (op.noUndo &&
        preparation &&
        state.manifestAttempted &&
        !state.manifestId) ||
      ((error instanceof MoveError || error instanceof BorrowedMoveError) &&
        (["REPLAY_OUTCOME_UNAVAILABLE", "IDEMPOTENCY_KEY_REUSED"].includes(
          error.code
        ) ||
          (attempted &&
            ["MOVE_MANIFEST_NOT_FOUND", "MOVE_MANIFEST_EXPIRED"].includes(
              error.code
            ))))
    )
      state.blocked = true;
    if (
      !state.blocked &&
      !attempted &&
      (error instanceof MoveError || error instanceof BorrowedMoveError) &&
      (op.noUndo
        ? deterministicRefusal(error)
        : error.status < 500 && error.code !== "REPLAY_OUTCOME_UNAVAILABLE")
    ) {
      state[stage] = "refused";
      state.refusal = {
        stage,
        status: error.status,
        code: error.code,
      };
      try {
        await checkpoint(false);
      } catch {
        state.blocked = true;
      }
      if (!state.blocked) return { kind: "refused", stage, error };
    }
    if (!(stage === "borrowed" ? state.borrowedResult : state.ownedResult))
      state[stage] = "unknown";
    try {
      await checkpoint(false);
    } catch {
      state.blocked = true;
    }
    return { kind: "unknown", stage, error };
  };
  if (
    op.target.kind === "move" &&
    op.borrowed.length &&
    state.borrowed !== "done"
  ) {
    const attempted = state.borrowedAttempted;
    try {
      state.borrowedAttempted = true;
      state.borrowed = "unknown";
      await checkpoint(true);
      state.borrowedResult = await api.moveBorrowedCopies({
        to_location_id: op.target.destinationId,
        items: [...op.borrowed],
        idempotency_key: op.borrowedKey,
      });
      state.borrowed = "done";
      await checkpoint(false);
    } catch (error) {
      return settleFailure("borrowed", error, attempted);
    }
  } else if (!op.borrowed.length) state.borrowed = "done";
  if (op.owned.length && state.owned !== "done") {
    const attempted = state.ownedAttempted;
    try {
      if (!state.manifestId) {
        if (state.ownedAttempted || (op.noUndo && state.manifestAttempted))
          throw new RecoveryBlocked();
        state.manifestAttempted = true;
        await checkpoint(true);
        state.manifestId = (await api.startMove()).id;
        await checkpoint(false);
      }
      if (!state.staged) {
        for (let start = 0; start < op.owned.length; start += STAGE_BATCH) {
          await checkpoint(true);
          await api.stageMove(
            state.manifestId,
            op.owned.slice(start, start + STAGE_BATCH)
          );
          await checkpoint(false);
        }
        state.staged = true;
        await checkpoint(false);
      }
      state.ownedAttempted = true;
      state.owned = "unknown";
      await checkpoint(true);
      state.ownedResult =
        op.target.kind === "move"
          ? op.noUndo
            ? await api.commitMoveWithoutUndo(
                state.manifestId,
                op.target.destinationId,
                op.ownedKey
              )
            : await api.commitMove(
                state.manifestId,
                op.target.destinationId,
                op.ownedKey
              )
          : await api.removeInventory(state.manifestId, op.ownedKey);
      state.owned = "done";
      await checkpoint(false);
    } catch (error) {
      return settleFailure("owned", error, attempted);
    }
  } else if (!op.owned.length) state.owned = "done";
  // Defence in depth for a broken route postcondition, never a cleanup guarantee.
  // Retain the receipt and refuse further writes; never offer this record as Undo.
  if (op.noUndo && state.ownedResult && state.ownedResult.undo_id !== null) {
    state.blocked = true;
    try {
      await checkpoint(false);
    } catch {
      /* The pre-write record remains unresolved. */
    }
    return {
      kind: "unknown",
      stage: "owned",
      error: new Error("Server did not confirm no-Undo support"),
    };
  }
  return { kind: "done" };
}

/** Named refusals are raised before Holding writes (moves.py and borrowed_gallery.py).
 * After any uncertain commit, even one of these refusals cannot resolve the earlier attempt. */
function deterministicRefusal(
  error: unknown
): error is MoveError | BorrowedMoveError {
  if (
    !(error instanceof MoveError || error instanceof BorrowedMoveError) ||
    error.status >= 500
  )
    return false;
  if (
    error instanceof MoveError &&
    error.code === "MOVE_REQUEST_FAILED" &&
    [404, 405, 422].includes(error.status)
  )
    return true;
  if (
    error instanceof BorrowedMoveError &&
    error.code === "MOVE_UNAVAILABLE" &&
    [404, 405, 422].includes(error.status)
  )
    return true;
  const codes =
    error instanceof BorrowedMoveError
      ? [
          "INVALID_QUANTITY",
          "DUPLICATE_MOVE_ITEM",
          "SAME_LOCATION",
          "LOCATION_NOT_FOUND",
          "NOT_ENOUGH_BORROWED",
        ]
      : [
          "INVALID_QUANTITY",
          "DESTINATION_REQUIRED",
          "EMPTY_MOVE_SELECTION",
          "SAME_LOCATION",
          "LOCATION_NOT_FOUND",
          "STALE_HOLDING",
          "INSUFFICIENT_QUANTITY",
          "QUANTITY_OVERFLOW",
          "DUPLICATE_MOVE_ITEM",
          "SOURCE_REQUIRED",
          "MOVE_MANIFEST_NOT_FOUND",
          "MOVE_MANIFEST_EXPIRED",
        ];
  return codes.includes(error.code);
}

/** Diagnostic fail-closed UI state after a broken server postcondition; not an atomic safety guarantee. */
export function undoProtectionUnconfirmed(held: HeldOperation | null): boolean {
  return !!(
    held?.op.noUndo &&
    held.state.ownedResult &&
    held.state.ownedResult.undo_id !== null
  );
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
