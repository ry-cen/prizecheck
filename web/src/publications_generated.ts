// Generated from FastAPI OpenAPI by scripts/generate_publications_client.py. Do not edit.
export type VisibilityCommand = { visibility: 'listed' | 'unlisted'; idempotency_key: string };
export type PublishCommand = { title: string; idempotency_key: string };
export type RevokeCommand = { idempotency_key: string };
export type PublicationStatus = { token: string | null; version: number | null; title: string | null; visibility: string | null; projection_pending?: boolean };
export type PublicationResult = { token: string; version: number; revoked: boolean };
export type OwnedPublication = { token: string; version: number; title: string; visibility: string; deck_id: string | null; projection_pending: boolean };
export type OwnedPublications = { publications: OwnedPublication[] };
export type PublicEdition = { set_id: string; set_name: string; collector_number: string; variant: Record<string, unknown>; image_url: string | null; quantity: string; edition_ref?: string | null; printing_ref?: string | null; printing_name?: string | null };
export type PublicIdentity = { name: string; quantity: string; editions: PublicEdition[] };
export type PublicIdentityCheck = { name: string; quantity: string; status: string };
export type PublicChecks = { size_status: string; shortage: string; excess: string; identities: PublicIdentityCheck[]; disclaimer?: string };
export type PublicSnapshot = { title: string; published_at: string; version: number; total: string; identities: PublicIdentity[]; checks: PublicChecks };

export class PublicationError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
async function request<T>(path: string, method: string, body?: object, onResponse?: (response: Response) => void): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new PublicationError(response.status, payload?.detail?.code ?? 'PUBLICATION_REQUEST_FAILED');
  }
  onResponse?.(response);
  return response.json() as Promise<T>;
}
export const getPublication = (id: string) => request<PublicationStatus>(`/api/decks/${encodeURIComponent(id)}/publication`, 'GET');
export const publishDeck = (id: string, body: PublishCommand) => request<PublicationResult>(`/api/decks/${encodeURIComponent(id)}/publication`, 'POST', body);
export const republishDeck = (id: string, body: PublishCommand) => request<PublicationResult>(`/api/decks/${encodeURIComponent(id)}/publication`, 'PUT', body);
export const revokeDeck = (id: string, body: RevokeCommand) => request<PublicationResult>(`/api/decks/${encodeURIComponent(id)}/publication`, 'DELETE', body);
export const setPublicationVisibility = (id: string, body: VisibilityCommand) => request<PublicationResult>(`/api/decks/${encodeURIComponent(id)}/publication/visibility`, 'PATCH', body);
export const getOwnedPublications = () => request<OwnedPublications>('/api/publications', 'GET');
export const revokePublication = (token: string, body: RevokeCommand) => request<PublicationResult>(`/api/publications/${encodeURIComponent(token)}`, 'DELETE', body);
export const setPublishedDeckVisibility = (token: string, body: VisibilityCommand) => request<PublicationResult>(`/api/publications/${encodeURIComponent(token)}/visibility`, 'PATCH', body);
export async function getPublicDeckPage(token: string) {
  let robots = 'noindex, nofollow';
  const snapshot = await request<PublicSnapshot>(`/api/public/decks/${encodeURIComponent(token)}`, 'GET', undefined, response => { robots = response.headers.get('x-robots-tag') ?? robots; });
  return { snapshot, robots };
}
export const getPublicDeck = (token: string) => request<PublicSnapshot>(`/api/public/decks/${encodeURIComponent(token)}`, 'GET');
