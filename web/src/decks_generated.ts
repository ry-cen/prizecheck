// Generated from FastAPI OpenAPI by scripts/generate_decks_client.py. Do not edit.
import type { DeckFormatChecks } from './format_checks_generated';
export type TreeNode = { id: string; name: string; kind: string; parent_id: string | null; version: number; depth: number };
export type LocationCommandResult = { location: TreeNode; owner_revision: number };
export type CreateDeck = { name: string; idempotency_key: string };
export type EditDeck = { name?: string | null; parent_id?: string | null; parent_version?: number | null; conversion?: string | null; version: number; idempotency_key: string };
export type DeckIndexEntry = { id: string; name: string; kind: string; parent_id: string | null; version: number; depth: number; deck_list_total: string; in_deck: string; target_format: 'standard' | 'expanded' | 'glc' };
export type DeckIndex = { decks: DeckIndexEntry[]; owner_revision: number; next_cursor: string | null };
export type IdentityCheck = { identity_id: string; name: string; quantity: string; status: string };
export type DeckChecks = { total: string; shortage: string; excess: string; size_status: string; identities: IdentityCheck[]; disclaimer?: string };
export type LoanLabel = { name: string; copies: string };
export type DeckLoanLine = { edition_id: string; reserved: LoanLabel[] };
export type DeckDetail = { deck: TreeNode; checks: DeckChecks; deck_list_checks: DeckChecks; deck_list: DeckList; ownership: LineOwnership[]; surplus: SurplusHolding[]; competition: CompetitionWarning[]; owner_revision: number; catalog_revision: number; target_format: 'standard' | 'expanded' | 'glc'; format_checks: DeckFormatChecks; to_get: string; want_list_counting: 'all_at_once' | 'one_at_a_time'; settings_revision: number; loans: DeckLoanLine[] };
export type DeckEditionQuantity = { edition_id: string; quantity: string };
export type DeckContents = { editions: DeckEditionQuantity[]; owner_revision: number; catalog_revision: number };
export type DeckListLine = { edition_id: string; quantity: string; in_deck: string; name: string; set_id: string; set_name: string; collector_number: string; descriptor: Record<string, unknown>; image_url: string | null; card_kind: 'pokemon' | 'trainer' | 'energy' | null; trainer_type: 'supporter' | 'item' | 'tool' | 'stadium' | null; evolves_from: string | null; identity_id: string; identity_name: string; evolution_root: string | null; evolution_stage: number | null };
export type DeckList = { revision: number; lines: DeckListLine[] };
export type AddDeckListLine = { edition_id: string; quantity: string; revision: number; idempotency_key: string };
export type ChangeDeckListLine = { quantity: string; revision: number; idempotency_key: string };
export type RemoveDeckListLine = { revision: number; idempotency_key: string };
export type SetTargetFormat = { target_format: string; revision: number; idempotency_key: string };
export type DeckListCommandResult = { deck_id: string; deck_list: DeckList; target_format: 'standard' | 'expanded' | 'glc'; format_checks?: DeckFormatChecks | null };
export type ElsewhereLocation = { location_id: string; name: string; kind: string; quantity: string };
export type LineOwnership = { edition_id: string; quantity: string; in_deck: string; elsewhere: string; not_owned: string; locations: ElsewhereLocation[] };
export type SurplusHolding = { edition_id: string; quantity: string; version: number; name: string; set_id: string; set_name: string; collector_number: string; descriptor: Record<string, unknown>; image_url: string | null; card_kind: 'pokemon' | 'trainer' | 'energy' | null; trainer_type: 'supporter' | 'item' | 'tool' | 'stadium' | null; evolves_from: string | null; identity_id: string; identity_name: string; evolution_root: string | null; evolution_stage: number | null };
export type CompetingDeck = { deck_id: string; name: string; in_deck: string; elsewhere: string };
export type CompetitionWarning = { edition_id: string; spare: string; counted_elsewhere: string; decks: CompetingDeck[] };
export type AddDeckListPrinting = { printing_id: string; quantity: string; revision: number; idempotency_key: string };
export type DeckListPrintingResult = { deck_id: string; deck_list: DeckList; target_format: 'standard' | 'expanded' | 'glc'; format_checks?: DeckFormatChecks | null; edition_id: string; chosen_by: 'cheapest_price' | 'catalog_order' };
export type PickWarning = { deck_id: string; name: string; short_by: string };
export type PickSource = { location_id: string; name: string; kind: string; available: string; committed: string; version: number; suggested: string; warning: PickWarning | null };
export type PickRow = { edition_id: string; quantity: string; in_deck: string; elsewhere: string; not_owned: string; sources: PickSource[] };
export type PutAwayHolding = { edition_id: string; quantity: string; version: number };
export type PickList = { deck_id: string; deck_list_revision: number; owner_revision: number; rows: PickRow[]; put_away: PutAwayHolding[]; competition: CompetitionWarning[] };
export type PickItem = { source_id: string; edition_id: string; quantity: string; expected_version: number };
export type ConfirmPicks = { items: PickItem[]; deck_list_revision: number; idempotency_key: string };
export type PickConfirmResult = { edition_count: number; copy_count: string; owner_revision: number; source_count: number; undo_id: string };
export type DeleteDeck = { name: string; version: number; idempotency_key: string };
export type DeleteDeckResult = { deleted_id: string; unsorted_id: string | null; edition_count: number; copy_count: string; owner_revision: number };
export type DeckListChange = { edition_id: string; quantity: string };
export type ChangeDeckList = { revision: number; idempotency_key: string; changes: DeckListChange[] };
export type ImportSource = { text?: string | null; publication?: string | null; version?: number | null };
export type ImportFix = { line: number; drop?: boolean; printing_id?: string | null; edition_id?: string | null };
export type ReviewImport = { source: ImportSource; owned?: 'exact' | 'owned'; fixes?: ImportFix[]; deck_id?: string | null };
export type ImportPrinting = { printing_id: string; name: string; set_id: string; set_code: string; set_name: string; collector_number: string; image_url: string | null; card_kind: 'pokemon' | 'trainer' | 'energy' | null };
export type ImportEdition = { edition_id: string; descriptor: Record<string, unknown>; display_price: string | null };
export type ImportPlace = { location_id: string; name: string; deck: boolean; quantity: string };
export type ImportPart = { edition_id: string; quantity: string; source: 'in_deck' | 'elsewhere' | 'new'; chosen_by: 'cheapest_price' | 'catalog_order' | 'collector' | 'published' | null; printing_id: string; name: string; set_code: string; collector_number: string; descriptor: Record<string, unknown>; places: ImportPlace[] };
export type ImportKept = { deck_id: string; name: string; quantity: string; reason: 'own_line' | 'counted' };
export type MissingCardPrefill = { kind: 'printing'; english_name: string; collector_number: string | null; set_id: string | null; set_name: string | null; note: string };
export type ReviewLine = { line: number; text: string; section: 'pokemon' | 'trainer' | 'energy' | null; quantity: string; name: string; set_code: string | null; number: string | null; ph: boolean; status: 'matched' | 'by_name' | 'energy' | 'picked' | 'ambiguous' | 'not_found' | 'unreadable' | 'dropped'; printing: ImportPrinting | null; candidates: ImportPrinting[]; editions: ImportEdition[]; parts: ImportPart[]; kept: ImportKept[]; report: MissingCardPrefill | null };
export type IgnoredImportLine = { line: number; text: string };
export type ImportDeckListEntry = { edition_id: string; quantity: string };
export type ImportTotals = { card_lines: number; cards: string; ignored: number; to_resolve: number; owned: string; to_get: string; to_get_priced: string | null; to_get_amount: string | null; to_get_display: string | null };
export type ImportPublication = { token: string; version: number; title: string; target_format: 'standard' | 'expanded' | 'glc' };
export type ImportReview = { lines: ReviewLine[]; ignored: IgnoredImportLine[]; deck_list: ImportDeckListEntry[]; totals: ImportTotals; owned: 'exact' | 'owned'; want_list_counting: 'all_at_once' | 'one_at_a_time'; settings_revision: number; owner_revision: number; catalog_revision: number; replace?: ImportReplace | null; publication?: ImportPublication | null };
export type ImportDeckLine = { edition_id: string; quantity: string };
export type ImportDeck = { name: string; target_format: string; lines: ImportDeckLine[]; idempotency_key: string };
export type ImportDeckResult = { deck_id: string; deck_list: DeckList; target_format: 'standard' | 'expanded' | 'glc'; format_checks?: DeckFormatChecks | null; location: TreeNode; owner_revision: number };
export type ReplaceLine = { edition_id: string; quantity: string };
export type ImportReplace = { deck_id: string; name: string; deck_list_revision: number; current: ReplaceLine[]; changes: ReplaceLine[]; surplus: SurplusHolding[] };

export class DeckError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
async function request<T>(path: string, method: string, body?: object): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new DeckError(response.status, payload?.detail?.code ?? 'DECK_REQUEST_FAILED');
  }
  return response.json() as Promise<T>;
}
export const getDecks = (cursor?: string) => request<DeckIndex>('/api/decks' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), 'GET');
export const createDeck = (body: CreateDeck) => request<LocationCommandResult>('/api/decks', 'POST', body);
export const editDeck = (id: string, body: EditDeck) => request<LocationCommandResult>(`/api/decks/${encodeURIComponent(id)}`, 'PATCH', body);
export async function getDeckContents(id: string, currentRevision?: () => number): Promise<DeckContents> {
  const contents = await request<DeckContents>(`/api/decks/${encodeURIComponent(id)}/contents`, 'GET');
  if (currentRevision && contents.owner_revision !== currentRevision()) {
    throw new DeckError(409, 'INVENTORY_CHANGED');
  }
  return contents;
}
export const getDeck = (id: string) => request<DeckDetail>(`/api/decks/${encodeURIComponent(id)}`, 'GET');
const deckListLines = (deckId: string) => `/api/decks/${encodeURIComponent(deckId)}/deck-list/lines`;
export const addDeckListLine = (deckId: string, body: AddDeckListLine) =>
  request<DeckListCommandResult>(deckListLines(deckId), 'POST', body);
export const changeDeckListLine = (deckId: string, editionId: string, body: ChangeDeckListLine) =>
  request<DeckListCommandResult>(`${deckListLines(deckId)}/${encodeURIComponent(editionId)}`, 'PATCH', body);
export const removeDeckListLine = (deckId: string, editionId: string, body: RemoveDeckListLine) =>
  request<DeckListCommandResult>(`${deckListLines(deckId)}/${encodeURIComponent(editionId)}`, 'DELETE', body);
// Changes the Deck List's Target Format (app redesign #178); answers the new Format's result.
export const setTargetFormat = (deckId: string, body: SetTargetFormat) =>
  request<DeckListCommandResult>(`/api/decks/${encodeURIComponent(deckId)}/deck-list/target-format`, 'PUT', body);
// Sets several Deck List lines in one batch (app redesign #177): each change is a line's new total, 0 removing it.
export const changeDeckList = (deckId: string, body: ChangeDeckList) =>
  request<DeckListCommandResult>(`/api/decks/${encodeURIComponent(deckId)}/deck-list/changes`, 'POST', body);
export const addDeckListPrinting = (deckId: string, body: AddDeckListPrinting) =>
  request<DeckListPrintingResult>(`/api/decks/${encodeURIComponent(deckId)}/deck-list/printings`, 'POST', body);
export const getPickList = (deckId: string) =>
  request<PickList>(`/api/decks/${encodeURIComponent(deckId)}/pick-list`, 'GET');
export const confirmPicks = (deckId: string, body: ConfirmPicks) =>
  request<PickConfirmResult>(`/api/decks/${encodeURIComponent(deckId)}/pick-list/confirm`, 'POST', body);
export const deleteDeck = (id: string, body: DeleteDeck) =>
  request<DeleteDeckResult>(`/api/decks/${encodeURIComponent(id)}`, 'DELETE', body);
// Decklist Import (#212): read a pasted list against the catalog (read-only; post again after every fix), then create
// a Deck with the Editions the review resolved.
export const reviewImport = (body: ReviewImport) => request<ImportReview>('/api/decks/import/review', 'POST', body);
export const importDeck = (body: ImportDeck) => request<ImportDeckResult>('/api/decks/import', 'POST', body);
