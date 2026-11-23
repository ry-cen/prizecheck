"""Generate the Riftbound Catalog client module (#661) from the Riftbound API's OpenAPI schema."""
import client_generator as gen

TARGET = "web/src/games/riftbound/catalog_generated.ts"
NAMES = ("CatalogSet", "CatalogEdition", "CatalogEditionPage")
# The routes always serialize every field, so every field is present even where the model has a default.
STYLE = gen.TypeStyle(optional_marks=False)
CLASS_DOC = """/** A failed Riftbound Catalog request. ``status`` is the HTTP status (401/403 denied, 404 unknown Edition, 422 invalid
 * query); ``code`` is RIFTBOUND_CATALOG_REQUEST_FAILED when the response carried none. */"""

BODY = """
export const RIFTBOUND_API_PREFIX = '/api/riftbound';
export type RiftboundEditionQuery = { q?: string; set?: string; page?: number };

%(error)s

async function catalogRequest<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(RIFTBOUND_API_PREFIX + path, { method: 'GET', credentials: 'same-origin', signal });
%(f0)s
  return response.json() as Promise<T>;
}

/** Every set in the active Riftbound catalog, for the set picker. */
export function getRiftboundCatalogSets(signal?: AbortSignal): Promise<CatalogSet[]> {
  return catalogRequest<CatalogSet[]>('/catalog/sets', signal);
}

/** One page of Riftbound Editions (24 per page). */
export function listRiftboundEditions(query: RiftboundEditionQuery, signal?: AbortSignal): Promise<CatalogEditionPage> {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.set) params.set('set', query.set);
  if (query.page) params.set('page', String(query.page));
  const suffix = params.toString() ? '?' + params.toString() : '';
  return catalogRequest<CatalogEditionPage>(`/catalog/editions${suffix}`, signal);
}

/** One Riftbound Edition by id; a 404 means it is not in the active catalog. */
export function getRiftboundEdition(id: string, signal?: AbortSignal): Promise<CatalogEdition> {
  return catalogRequest<CatalogEdition>(`/catalog/editions/${encodeURIComponent(id)}`, signal);
}
"""


def load_openapi():
    return gen.load_riftbound_openapi()


def render(openapi):
    assert openapi["info"]["title"] == "PrizeCheck Riftbound API"
    for path in ("/api/catalog/sets", "/api/catalog/editions", "/api/catalog/editions/{edition_id}"):
        assert path in openapi["paths"], path
    schemas = openapi["components"]["schemas"]
    body = BODY % {"error": gen.error_class('RiftboundCatalogError', doc=CLASS_DOC),
                   "f0": gen.failure_block('RiftboundCatalogError', 'RIFTBOUND_CATALOG_REQUEST_FAILED')}
    return gen.assemble([gen.header("generate_riftbound_catalog_client"), *STYLE.aliases(schemas, NAMES), body])


if __name__ == "__main__":
    gen.main(__name__)
