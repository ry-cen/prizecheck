// Generated from FastAPI OpenAPI by scripts/generate_discovery_client.py. Do not edit.
export type PublicCheckSummary = { size_status: string; shortage: string; excess: string; over_limit_groups: number; unresolved_groups: number };
export type PublicDeckSummary = { url: string; title: string; total: string; published_at: string; checks: PublicCheckSummary; image_url: string | null };
export type DiscoveryPage = { decks: PublicDeckSummary[]; revision: number; next_cursor: string | null };

export class DiscoveryError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
async function request<T>(path: string, method: string, body?: object): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new DiscoveryError(response.status, payload?.detail?.code ?? 'DISCOVERY_REQUEST_FAILED');
  }
  return response.json() as Promise<T>;
}
export const discoverDecks = (q = '', cursor?: string) => {
  const params = new URLSearchParams({ q }); if (cursor) params.set('cursor', cursor);
  return request<DiscoveryPage>('/api/public/discovery?' + params, 'GET');
};
