// Generated from FastAPI OpenAPI by scripts/generate_want_list_cost_client.py. Do not edit.
import type { DeckCostFigures } from './prices_generated';
import type { MassEntryLineView } from './mass_entry_generated';
export type WantListLineCost = { edition_id: string; need: string; price_each: string | null; cost: DeckCostFigures };
export type WantListSectionCost = { deck_id: string; deck_list_revision: number; cost: DeckCostFigures; lines: WantListLineCost[] };
export type WantListRowCost = { edition_id: string; need: string; cost: DeckCostFigures };
export type WantListCost = { deck_id: string | null; want_list_counting: 'all_at_once' | 'one_at_a_time' | null; settings_revision: number | null; owner_revision: number | null; deck_lists_digest: string | null; total: DeckCostFigures; sections: WantListSectionCost[]; combined: WantListRowCost[] };
export type WantListMassEntryView = { status: 'link' | 'text' | 'empty'; url: string | null; fallback_reason: 'missing_mapping' | 'encoded_length' | 'quantity_unsupported' | null; text: string | null; inline: boolean; byte_length: number; lines: MassEntryLineView[]; line_count: number; less_specific_count: number; total_copies: string; deck_id: string | null; want_list_counting: 'all_at_once' | 'one_at_a_time'; settings_revision: number; owner_revision: number; deck_lists_digest: string };

export class WantListCostError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const scoped = (path: string, deckId?: string | null) => path + (deckId ? '?deck=' + encodeURIComponent(deckId) : '');
async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new WantListCostError(response.status, payload?.detail?.code ?? 'WANT_LIST_REQUEST_FAILED');
  }
  return response.json() as Promise<T>;
}
// The Want List's cost for the same scope as GET /api/want-list (decklist import #210): a price access under ADR 0006,
// read separately so the page draws first. Show it only for the answer whose setting, revisions and digest it names.
export const getWantListCost = (deckId?: string | null, signal?: AbortSignal) =>
  read<WantListCost>(scoped('/api/want-list/cost', deckId), signal);
// Buy on TCGplayer: the Mass Entry export of the combined total, or of one Deck's needs.
export const getWantListMassEntry = (deckId?: string | null, signal?: AbortSignal) =>
  read<WantListMassEntryView>(scoped('/api/want-list/exports/tcgplayer', deckId), signal);
// The text download, pinned to the view it was prepared from (409 once the inventory, a Deck List or the setting moved).
export const wantListMassEntryDownloadHref = (view: WantListMassEntryView) =>
  `/api/want-list/exports/tcgplayer.txt?${view.deck_id ? `deck=${encodeURIComponent(view.deck_id)}&` : ''}owner_revision=${view.owner_revision}&settings_revision=${view.settings_revision}&deck_lists=${view.deck_lists_digest}`;
