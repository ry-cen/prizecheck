import type { TreeNode } from "../../location_generated";
import type { Edition } from "./catalog";
import type { WriteOptions } from "./collection";
export type DeckSummary = {
  id: string;
  name: string;
  version: number;
  cardCount: number;
  listRevision: number;
};
export type DeckLine = {
  edition: Edition;
  quantity: number;
  inDeck: number;
  elsewhere: number;
  notOwned: number;
};
export type DeckDetail = {
  location: TreeNode;
  listRevision: number;
  lines: DeckLine[];
};
export interface DeckReader {
  readonly owner: string;
  decks(signal: AbortSignal): Promise<DeckSummary[]>;
  deck(id: string, signal: AbortSignal): Promise<DeckDetail | null>;
}
export type DeckChange = {
  deckId: string;
  listRevision: number;
  changes: { editionId: string; quantity: number }[];
};
export interface DeckWriter {
  readonly owner: string;
  createDeck(
    input: { name: string },
    options: WriteOptions
  ): Promise<{ location: TreeNode; ownerRevision: number }>;
  renameDeck(
    input: { id: string; name: string; version: number },
    options: WriteOptions
  ): Promise<{ location: TreeNode; ownerRevision: number }>;
  deleteDeck(
    input: { id: string; confirmName: string; version: number },
    options: WriteOptions
  ): Promise<{ ownerRevision: number }>;
  changeDeckList(input: DeckChange, options: WriteOptions): Promise<DeckDetail>;
}
export type DeckErrorCode =
  | "STALE_DECK_LIST"
  | "STALE_LOCATION"
  | "EDITION_UNAVAILABLE"
  | "INVALID_LOCATION_NAME"
  | "LOCATION_NAME_CONFLICT"
  | "IDEMPOTENCY_KEY_REUSED"
  | "DECK_NOT_FOUND"
  | "LOCATION_NAME_CONFIRMATION_MISMATCH"
  | "UNSORTED_UNAVAILABLE"
  | "QUANTITY_OVERFLOW"
  | "NO_CHANGES"
  | "DUPLICATE_EDITION"
  | "INVALID_QUANTITY";
export class DeckError extends Error {
  constructor(readonly code: DeckErrorCode) {
    super(code);
  }
}
export const deckKey = (owner: string, id = "") =>
  JSON.stringify(["riftbound", "decks", owner, id]);
/** No Loans in these fixtures. Lent is zero, never folded into notOwned. */
export function ownership(quantity: number, held: number, outside: number) {
  const inDeck = Math.min(quantity, held);
  const elsewhere = Math.min(quantity - inDeck, outside);
  return { inDeck, elsewhere, notOwned: quantity - inDeck - elsewhere };
}
