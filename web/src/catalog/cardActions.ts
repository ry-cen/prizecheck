import { batchAddHoldings, HoldingError } from "../holdings_generated";

/**
 * The CardPopup's add (#174), kept apart so a later ticket swaps what it sends without touching the popup: #175 moved
 * it onto batch add (POST /api/holdings/batch, one Undo record per add), which Add mode's Add N cards shares.
 *
 * It keeps the command it sent after a failure whose outcome is unknown (a dropped connection, a 5xx), and sends
 * exactly that command again on the next press, with the same idempotency key, so the server replays it instead of
 * adding twice.
 */

/** Copies of one Card Edition to add. */
export type AddItem = { editionId: string; quantity: number };

/** A batch add as sent: one Location, its items in order, and the key that makes a resend replay it. */
export type AddCommand = {
  locationId: string;
  /** The Location's path, for messages. */
  path: string;
  items: readonly AddItem[];
  key: string;
};

export type AddOutcome =
  | {
      ok: true;
      /** What was added: this call's items, or the earlier uncertain batch's when `settledEarlier`. */
      locationId: string;
      path: string;
      items: readonly AddItem[];
      /** An earlier batch that may have completed was replayed first; the items of this call were not sent. */
      settledEarlier: boolean;
      copies: number;
      editions: number;
      ownerRevision: number;
      /** The add's one Inventory Undo record (an "add"). */
      undoId: string;
    }
  | {
      ok: false;
      code: string;
      /** The Card Edition the API refused (unavailable, or its stack would overflow), when it named one. */
      editionId: string | null;
      retry: boolean;
    };

function sameItems(a: readonly AddItem[], b: readonly AddItem[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (item, index) =>
        item.editionId === b[index].editionId &&
        item.quantity === b[index].quantity
    )
  );
}

function succeeded(
  command: AddCommand,
  result: Awaited<ReturnType<typeof batchAddHoldings>>,
  settledEarlier: boolean
): AddOutcome {
  return {
    ok: true,
    locationId: command.locationId,
    path: command.path,
    items: command.items,
    settledEarlier,
    copies: Number(result.copy_count),
    editions: result.edition_count,
    ownerRevision: result.owner_revision,
    undoId: result.undo_id,
  };
}

function send(command: AddCommand) {
  return batchAddHoldings({
    location_id: command.locationId,
    idempotency_key: command.key,
    items: command.items.map((item) => ({
      edition_id: item.editionId,
      quantity: String(item.quantity),
    })),
  });
}

/** The codes the batch handler itself answers before it commits anything (api/app/holdings.py), under the owner lock:
 * a refusal with one of them proves the batch never committed. A status alone proves nothing: a gateway's 401, 403 or
 * 429, or a 422 without a code (the request's shape), can come while the earlier send is still being worked on. */
const REFUSED_FOR_GOOD: ReadonlySet<string> = new Set([
  "LOCATION_NOT_FOUND",
  "EDITION_UNAVAILABLE",
  "QUANTITY_OVERFLOW",
  "DUPLICATE_ADD_ITEM",
  "INVALID_QUANTITY",
]);

/** The answer for a key whose replay row no longer says what it did: resending can never settle it. */
export const OUTCOME_UNAVAILABLE = "REPLAY_OUTCOME_UNAVAILABLE";

function failed(cause: unknown): Extract<AddOutcome, { ok: false }> {
  const failure = cause instanceof HoldingError ? cause : null;
  const code = failure?.code ?? "";
  return {
    ok: false,
    code,
    editionId: failure?.editionId ?? null,
    // Only the handler's own refusals end the command; the unavailable outcome can't be resent, so it ends too (its copy
    // says the add may have completed).
    retry: !REFUSED_FOR_GOOD.has(code) && code !== OUTCOME_UNAVAILABLE,
  };
}

/** Adds copies of up to 200 Card Editions to one Storage Leaf or Deck in one batch add (POST /api/holdings/batch):
 * all or nothing, one owner revision, and one Undo record. A copy is a physical card: the owner revision moves, so an
 * open browse cursor answers 409 afterwards.
 *
 * A batch that may have completed (its outcome unknown) is never left behind by a different one (#196): the server
 * replays it only under its own key, so a changed batch under a new key would add the first one's copies again. When
 * the items differ, the earlier command is sent again first. If that completes, its result is returned with
 * `settledEarlier` and the changed items wait for the next call; if its outcome is still unknown, so is the answer
 * (`retry`), and nothing new is sent. */
export async function addCards(
  locationId: string,
  path: string,
  items: readonly AddItem[],
  pending: { current: AddCommand | null }
): Promise<AddOutcome> {
  const previous = pending.current;
  if (
    previous &&
    !(previous.locationId === locationId && sameItems(previous.items, items))
  ) {
    try {
      const result = await send(previous);
      pending.current = null;
      return succeeded(previous, result, true);
    } catch (cause) {
      const outcome = failed(cause);
      if (outcome.retry) return outcome;
      // The handler refused it for good (so it never committed): the new batch goes on its own. When it can no longer
      // say what happened, the add may have completed, so nothing new is sent.
      pending.current = null;
      if (outcome.code === OUTCOME_UNAVAILABLE) return outcome;
    }
  }
  const command = pending.current ?? {
    locationId,
    path,
    items: [...items],
    key: crypto.randomUUID(),
  };
  pending.current = command;
  try {
    const result = await send(command);
    pending.current = null;
    return succeeded(command, result, false);
  } catch (cause) {
    const outcome = failed(cause);
    if (!outcome.retry) pending.current = null;
    return outcome;
  }
}

/** The popup's Add N: `quantity` copies of one Card Edition, as a batch add of one item. */
export function addToCollection(
  locationId: string,
  path: string,
  editionId: string,
  quantity: number,
  pending: { current: AddCommand | null }
): Promise<AddOutcome> {
  return addCards(locationId, path, [{ editionId, quantity }], pending);
}
