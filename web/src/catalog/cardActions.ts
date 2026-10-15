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
