"""Generate the Catalog browse client module (app redesign #173) from the API OpenAPI schema."""
import client_generator as gen

TARGET = "web/src/catalog_browse_generated.ts"
NAMES = ("FormatStandingView", "EditionStandings", "BrowseEdition", "BrowseSearch", "BrowsePage", "CatalogSet",
         "CatalogSetList")
# The routes always serialize every field, so every field is present even where the model has a default.
STYLE = gen.TypeStyle(optional_marks=False)
CLASS_DOC = """/** A failed browse request. ``code`` is the API's error code: CATALOG_CHANGED or INVENTORY_CHANGED (409: start again
 * from page one), FORMAT_STANDING_BUSY (503: retry), DECK_NOT_FOUND (404), INVALID_CURSOR (400), or
 * CATALOG_BROWSE_FAILED when the response carried none. */"""

BODY = """
export type BrowseKind = 'pokemon' | 'supporter' | 'item' | 'tool' | 'stadium' | 'energy';
export type BrowseFormat = 'standard' | 'expanded' | 'glc';
export type BrowseQuery = { q?: string; kind?: BrowseKind | null; format?: BrowseFormat | null; set_id?: string | null;
                            owned?: boolean; deck_id?: string | null; printing_id?: string | null;
                            identity_id?: string | null };

%(error)s

async function browseRequest<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: 'GET', credentials: 'same-origin', signal });
%(f0)s
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
"""


def render(openapi):
    assert "/api/catalog/editions" in openapi["paths"] and "/api/catalog/sets" in openapi["paths"]
    schemas = openapi["components"]["schemas"]
    body = BODY % {"error": gen.error_class('CatalogBrowseError', doc=CLASS_DOC),
                   "f0": gen.failure_block('CatalogBrowseError', 'CATALOG_BROWSE_FAILED')}
    return gen.assemble([gen.header("generate_catalog_browse_client"), *STYLE.aliases(schemas, NAMES), body])


if __name__ == "__main__":
    gen.main(__name__)
