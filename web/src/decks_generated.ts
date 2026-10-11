// Generated from FastAPI OpenAPI by scripts/generate_decks_client.py. Do not edit.
export type TreeNode = { id: string; name: string; kind: string; parent_id: string | null; version: number; depth: number };
export type LocationCommandResult = { location: TreeNode; owner_revision: number };
export type CreateDeck = { name: string; idempotency_key: string };
export type EditDeck = { name?: string | null; parent_id?: string | null; parent_version?: number | null; conversion?: string | null; version: number; idempotency_key: string };
export type DeckIndex = { decks: TreeNode[]; owner_revision: number; next_cursor: string | null };
export type IdentityCheck = { identity_id: string; name: string; quantity: string; status: string };
export type DeckChecks = { total: string; shortage: string; excess: string; size_status: string; identities: IdentityCheck[]; disclaimer?: string };
export type DeckDetail = { deck: TreeNode; checks: DeckChecks; deck_list_checks: DeckChecks; deck_list: DeckList; ownership: LineOwnership[]; surplus: SurplusHolding[]; competition: CompetitionWarning[]; owner_revision: number; catalog_revision: number };
export type DeckEditionQuantity = { edition_id: string; quantity: string };
export type DeckContents = { editions: DeckEditionQuantity[]; owner_revision: number; catalog_revision: number };
export type DeckListLine = { edition_id: string; quantity: string; in_deck: string };
export type DeckList = { revision: number; lines: DeckListLine[] };
export type AddDeckListLine = { edition_id: string; quantity: string; revision: number; idempotency_key: string };
export type ChangeDeckListLine = { quantity: string; revision: number; idempotency_key: string };
export type RemoveDeckListLine = { revision: number; idempotency_key: string };
export type DeckListCommandResult = { deck_id: string; deck_list: DeckList };
export type ElsewhereLocation = { location_id: string; name: string; kind: string; quantity: string };
export type LineOwnership = { edition_id: string; quantity: string; in_deck: string; elsewhere: string; not_owned: string; locations: ElsewhereLocation[] };
export type SurplusHolding = { edition_id: string; quantity: string };
export type CompetingDeck = { deck_id: string; name: string; in_deck: string; elsewhere: string };
export type CompetitionWarning = { edition_id: string; spare: string; counted_elsewhere: string; decks: CompetingDeck[] };
export type AddDeckListPrinting = { printing_id: string; quantity: string; revision: number; idempotency_key: string };
export type DeckListPrintingResult = { deck_id: string; deck_list: DeckList; edition_id: string; chosen_by: string };
export type PickWarning = { deck_id: string; name: string; short_by: string };
export type PickSource = { location_id: string; name: string; kind: string; available: string; committed: string; version: number; suggested: string; warning: PickWarning | null };
export type PickRow = { edition_id: string; quantity: string; in_deck: string; elsewhere: string; not_owned: string; sources: PickSource[] };
export type PutAwayHolding = { edition_id: string; quantity: string; version: number };
export type PickList = { deck_id: string; deck_list_revision: number; owner_revision: number; rows: PickRow[]; put_away: PutAwayHolding[]; competition: CompetitionWarning[] };
export type PickItem = { source_id: string; edition_id: string; quantity: string; expected_version: number };
export type ConfirmPicks = { items: PickItem[]; deck_list_revision: number; idempotency_key: string };
export type PickConfirmResult = { edition_count: number; copy_count: string; owner_revision: number };

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
export const addDeckListPrinting = (deckId: string, body: AddDeckListPrinting) =>
  request<DeckListPrintingResult>(`/api/decks/${encodeURIComponent(deckId)}/deck-list/printings`, 'POST', body);
export const getPickList = (deckId: string) =>
  request<PickList>(`/api/decks/${encodeURIComponent(deckId)}/pick-list`, 'GET');
export const confirmPicks = (deckId: string, body: ConfirmPicks) =>
  request<PickConfirmResult>(`/api/decks/${encodeURIComponent(deckId)}/pick-list/confirm`, 'POST', body);
