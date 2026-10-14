// Generated from FastAPI OpenAPI by scripts/generate_catalog_browse_client.py. Do not edit.
export type FormatStandingView = { status: 'legal' | 'not_legal' | 'unknown'; reasons: string[] };
export type EditionStandings = { standard: FormatStandingView; expanded: FormatStandingView; glc: FormatStandingView };
export type BrowseEdition = { edition_id: string; printing_id: string; name: string; set_id: string; set_name: string; set_code: string; collector_number: string; descriptor: Record<string, unknown>; image_url: string | null; card_kind: 'pokemon' | 'trainer' | 'energy' | null; trainer_type: 'supporter' | 'item' | 'tool' | 'stadium' | null; evolves_from: string | null; regulation_mark: string | null; standing: EditionStandings; owned: number; in_deck: number | null; free: number | null };
export type BrowseSearch = { mode: 'all' | 'name' | 'set_number'; text: string; set_id: string | null; set_name: string | null; set_code: string | null; number: string | null };
export type BrowsePage = { available: boolean; catalog_revision: number; owner_revision: number; last_success: string | null; search: BrowseSearch; editions: BrowseEdition[]; next_cursor: string | null; printings: number | null; matches: number | null };
export type CatalogSet = { set_id: string; set_name: string; set_code: string; printings: number };
export type CatalogSetList = { available: boolean; catalog_revision: number; sets: CatalogSet[] };

export type BrowseKind = 'pokemon' | 'supporter' | 'item' | 'tool' | 'stadium' | 'energy';
export type BrowseFormat = 'standard' | 'expanded' | 'glc';
export type BrowseQuery = { q?: string; kind?: BrowseKind | null; format?: BrowseFormat | null; set_id?: string | null;
                            owned?: boolean; deck_id?: string | null; printing_id?: string | null;
                            identity_id?: string | null };

/** A failed browse request. ``code`` is the API's error code: CATALOG_CHANGED or INVENTORY_CHANGED (409: start again
 * from page one), FORMAT_STANDING_BUSY (503: retry), DECK_NOT_FOUND (404), INVALID_CURSOR (400), or
 * CATALOG_BROWSE_FAILED when the response carried none. */
export class CatalogBrowseError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

async function browseRequest<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: 'GET', credentials: 'same-origin', signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new CatalogBrowseError(response.status, payload?.detail?.code ?? 'CATALOG_BROWSE_FAILED');
  }
  return response.json() as Promise<T>;
}

/** One page of Card Editions (60 rows). Pass the previous page's ``next_cursor`` with the same query for the next one. */
export function browseEditions(query: BrowseQuery, cursor?: string | null, signal?: AbortSignal): Promise<BrowsePage> {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.kind) params.set('kind', query.kind);
  if (query.format) params.set('format', query.format);
  if (query.set_id) params.set('set_id', query.set_id);
  if (query.owned) params.set('owned', 'true');
  if (query.deck_id) params.set('deck_id', query.deck_id);
  if (query.printing_id) params.set('printing_id', query.printing_id);
  if (query.identity_id) params.set('identity_id', query.identity_id);
  if (cursor) params.set('cursor', cursor);
  const suffix = params.toString() ? '?' + params.toString() : '';
  return browseRequest<BrowsePage>(`/api/catalog/editions${suffix}`, signal);
}

/** Every set in the active catalog, A-Z by name, for the set picker. */
export function getCatalogSets(signal?: AbortSignal): Promise<CatalogSetList> {
  return browseRequest<CatalogSetList>('/api/catalog/sets', signal);
}
