// Generated from FastAPI OpenAPI by scripts/generate_want_list_client.py. Do not edit.
export type WantListDeck = { id: string; name: string };
export type CountedFromDeck = { deck_id: string; quantity: string };
export type WantListLine = { edition_id: string; name: string; set_id: string; set_name: string; collector_number: string; descriptor: Record<string, unknown>; image_url: string | null; quantity: string; held: string; spare: string; other_decks: string; counted_from: CountedFromDeck[]; owned: string; need: string };
export type WantListSection = { deck_id: string; name: string; deck_list_revision: number; to_get: string; lines: WantListLine[] };
export type CombinedDeckNeed = { deck_id: string; need: string };
export type CombinedRow = { edition_id: string; name: string; set_id: string; set_name: string; collector_number: string; descriptor: Record<string, unknown>; image_url: string | null; need: string; decks: CombinedDeckNeed[] };
export type WantList = { want_list_counting: 'all_at_once' | 'one_at_a_time'; settings_revision: number; owner_revision: number; deck_lists_digest: string; deck_id: string | null; decks: WantListDeck[]; sections: WantListSection[]; combined: CombinedRow[]; to_get: string };

export class WantListError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
// What every Deck still needs under the account's counting setting (decklist import #209): every Deck's section and
// the combined total, or, with a Deck id, that Deck's section and needs (404 DECK_NOT_FOUND for any other id).
export async function getWantList(deckId?: string | null, signal?: AbortSignal): Promise<WantList> {
  const response = await fetch('/api/want-list' + (deckId ? '?deck=' + encodeURIComponent(deckId) : ''),
    { credentials: 'same-origin', signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new WantListError(response.status, payload?.detail?.code ?? 'WANT_LIST_REQUEST_FAILED');
  }
  return response.json() as Promise<WantList>;
}
