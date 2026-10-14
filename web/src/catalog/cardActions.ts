import { changeDeckList, DeckError, getDeck } from "../decks_generated";
import { batchAddHoldings, HoldingError } from "../holdings_generated";

/**
 * The CardPopup's two actions (#174), one function each, so later tickets swap what they send without touching the
 * popup: #175 moved adding onto batch add (POST /api/holdings/batch, one Undo record per add), which Add mode's
 * Add N cards shares, and Plan 1 uses the batch Deck List change command (#177).
 *
 * Each keeps the command it sent after a failure whose outcome is unknown (a dropped connection, a 5xx), and sends
 * exactly that command again on the next press, with the same idempotency key, so the server replays it instead of
 * adding twice.
 */

/** Copies of one Card Edition to add. */
export type AddItem = { editionId: string; quantity: number };

/** A batch add as sent: one Location, its items in order, and the key that makes a resend replay it. */
export type AddCommand = {
  locationId: string;
  items: readonly AddItem[];
  key: string;
};

export type AddOutcome =
  | {
      ok: true;
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

/** Adds copies of up to 200 Card Editions to one Storage Leaf or Deck in one batch add (POST /api/holdings/batch):
 * all or nothing, one owner revision, and one Undo record. A copy is a physical card: the owner revision moves, so an
 * open browse cursor answers 409 afterwards. */
export async function addCards(
  locationId: string,
  items: readonly AddItem[],
  pending: { current: AddCommand | null }
): Promise<AddOutcome> {
  const previous = pending.current;
  const command =
    previous &&
    previous.locationId === locationId &&
    sameItems(previous.items, items)
      ? previous
      : { locationId, items: [...items], key: crypto.randomUUID() };
  pending.current = command;
  try {
    const result = await batchAddHoldings({
      location_id: locationId,
      idempotency_key: command.key,
      items: command.items.map((item) => ({
        edition_id: item.editionId,
        quantity: String(item.quantity),
      })),
    });
    pending.current = null;
    return {
      ok: true,
      copies: Number(result.copy_count),
      editions: result.edition_count,
      ownerRevision: result.owner_revision,
      undoId: result.undo_id,
    };
  } catch (cause) {
    const failure = cause instanceof HoldingError ? cause : null;
    const definite = failure !== null && failure.status < 500;
    if (definite) pending.current = null;
    return {
      ok: false,
      code: failure?.code ?? "",
      editionId: failure?.editionId ?? null,
      retry: !definite,
    };
  }
}

/** The popup's Add N: `quantity` copies of one Card Edition, as a batch add of one item. */
export function addToCollection(
  locationId: string,
  editionId: string,
  quantity: number,
  pending: { current: AddCommand | null }
): Promise<AddOutcome> {
  return addCards(locationId, [{ editionId, quantity }], pending);
}

export type PlanCommand = {
  deckId: string;
  editionId: string;
  key: string;
  /** The line's new total: 1 for a new line, or the existing line plus 1. */
  quantity: string;
  revision: number;
};

export type PlanOutcome =
  { ok: true; quantity: string } | { ok: false; code: string; retry: boolean };

/** Plan 1: one more copy of a Card Edition on a Deck's Deck List, a new line of 1 or the existing line plus 1, through
 * the batch Deck List change command (POST /api/decks/{id}/deck-list/changes, #177). It never moves a physical card,
 * and the owner revision doesn't move. A Deck List that changed under it (STALE_DECK_LIST) is read again once. */
export async function planOne(
  deckId: string,
  editionId: string,
  pending: { current: PlanCommand | null }
): Promise<PlanOutcome> {
  const previous = pending.current;
  let command =
    previous && previous.deckId === deckId && previous.editionId === editionId
      ? previous
      : null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!command) {
      try {
        const detail = await getDeck(deckId);
        const line = detail.deck_list.lines.find(
          (item) => item.edition_id === editionId
        );
        command = {
          deckId,
          editionId,
          key: crypto.randomUUID(),
          quantity: line ? String(BigInt(line.quantity) + 1n) : "1",
          revision: detail.deck_list.revision,
        };
      } catch (cause) {
        return {
          ok: false,
          code: cause instanceof DeckError ? cause.code : "",
          retry: false,
        };
      }
    }
    pending.current = command;
    try {
      const result = await changeDeckList(deckId, {
        revision: command.revision,
        idempotency_key: command.key,
        changes: [{ edition_id: editionId, quantity: command.quantity }],
      });
      pending.current = null;
      const line = result.deck_list.lines.find(
        (item) => item.edition_id === editionId
      );
      return { ok: true, quantity: line?.quantity ?? command.quantity };
    } catch (cause) {
      const code = cause instanceof DeckError ? cause.code : "";
      const definite = cause instanceof DeckError && cause.status < 500;
      if (definite) pending.current = null;
      if (definite && code === "STALE_DECK_LIST" && attempt === 0) {
        command = null;
        continue;
      }
      return { ok: false, code, retry: !definite };
    }
  }
  return { ok: false, code: "STALE_DECK_LIST", retry: false };
}
