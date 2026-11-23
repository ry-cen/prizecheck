// Generated from FastAPI OpenAPI by scripts/generate_riftbound_catalog_client.py. Do not edit.
export type CatalogSet = { id: string; name: string; code: string };
export type CatalogEdition = { id: string; printing_id: string; name: string; set: CatalogSet; number: string; finish: string; art: string | null };
export type CatalogEditionPage = { editions: CatalogEdition[]; total: number; pages: number; catalog_empty: boolean };

export const RIFTBOUND_API_PREFIX = '/api/riftbound';
export type RiftboundEditionQuery = { q?: string; set?: string; page?: number };

/** A failed Riftbound Catalog request. ``status`` is the HTTP status (401/403 denied, 404 unknown Edition, 422 invalid
 * query); ``code`` is RIFTBOUND_CATALOG_REQUEST_FAILED when the response carried none. */
export class RiftboundCatalogError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

async function catalogRequest<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(RIFTBOUND_API_PREFIX + path, { method: 'GET', credentials: 'same-origin', signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new RiftboundCatalogError(response.status, payload?.detail?.code ?? 'RIFTBOUND_CATALOG_REQUEST_FAILED');
  }
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
