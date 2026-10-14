import {
  addDeckListLine,
  changeDeckListLine,
  DeckError,
  getDeck,
} from "../decks_generated";
import { addHolding, HoldingError } from "../holdings_generated";

/**
 * The CardPopup's two actions (#174), one function each, so later tickets swap what they send without touching the
 * popup: #175 moves Add N onto batch add (POST /api/holdings/batch, with an Undo), and #177 moves Plan 1 onto the
 * batch Deck List change command.
 *
 * Each keeps the command it sent after a failure whose outcome is unknown (a dropped connection, a 5xx), and sends
 * exactly that command again on the next press, with the same idempotency key, so the server replays it instead of
 * adding twice.
 */

export type AddCommand = {
  locationId: string;
  editionId: string;
  quantity: number;
  key: string;
};

export type AddOutcome =
  | { ok: true; quantity: string; ownerRevision: number }
  | { ok: false; code: string; retry: boolean };

/** Adds `quantity` copies of one Card Edition to a Storage Leaf through the single add route (POST /api/holdings).
 * A copy is a physical card: the owner revision moves, so an open browse cursor answers 409 afterwards. */
export async function addToCollection(
  locationId: string,
  editionId: string,
  quantity: number,
  pending: { current: AddCommand | null }
): Promise<AddOutcome> {
  const previous = pending.current;
  const command =
    previous &&
    previous.locationId === locationId &&
    previous.editionId === editionId &&
    previous.quantity === quantity
      ? previous
      : { locationId, editionId, quantity, key: crypto.randomUUID() };
  pending.current = command;
  try {
    const result = await addHolding({
      location_id: locationId,
      edition_id: editionId,
      quantity: String(quantity),
      idempotency_key: command.key,
    });
    pending.current = null;
    return {
      ok: true,
      quantity: result.quantity,
      ownerRevision: result.owner_revision,
    };
  } catch (cause) {
    const code = cause instanceof HoldingError ? cause.code : "";
    const definite = cause instanceof HoldingError && cause.status < 500;
    if (definite) pending.current = null;
    return { ok: false, code, retry: !definite };
  }
}

export type PlanCommand = {
  deckId: string;
  editionId: string;
  key: string;
  /** "add" a new line of 1, or "change" an existing line to `quantity`. */
  kind: "add" | "change";
  quantity: string;
  revision: number;
};

export type PlanOutcome =
  { ok: true; quantity: string } | { ok: false; code: string; retry: boolean };

// The Deck List moved between the read and the command: read it again once.
const MOVED = new Set([
  "STALE_DECK_LIST",
  "DECK_LIST_LINE_EXISTS",
  "DECK_LIST_LINE_NOT_FOUND",
]);

/** Plan 1: one more copy of a Card Edition on a Deck's Deck List, a new line of 1 or the existing line plus 1,
 * through the per-line routes (POST or PATCH /api/decks/{id}/deck-list/lines). It never moves a physical card, and
 * the owner revision doesn't move. A Deck List that changed under it is read again once. */
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
          kind: line ? "change" : "add",
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
      const body = {
        quantity: command.quantity,
        revision: command.revision,
        idempotency_key: command.key,
      };
      const result =
        command.kind === "add"
          ? await addDeckListLine(deckId, { ...body, edition_id: editionId })
          : await changeDeckListLine(deckId, editionId, body);
      pending.current = null;
      const line = result.deck_list.lines.find(
        (item) => item.edition_id === editionId
      );
      return { ok: true, quantity: line?.quantity ?? command.quantity };
    } catch (cause) {
      const code = cause instanceof DeckError ? cause.code : "";
      const definite = cause instanceof DeckError && cause.status < 500;
      if (definite) pending.current = null;
      if (definite && MOVED.has(code) && attempt === 0) {
        command = null;
        continue;
      }
      return { ok: false, code, retry: !definite };
    }
  }
  return { ok: false, code: "STALE_DECK_LIST", retry: false };
}
