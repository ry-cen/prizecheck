// Generated from FastAPI OpenAPI by scripts/generate_publications_client.py. Do not edit.
export type PublishCommand = { title: string; idempotency_key: string };
export type RevokeCommand = { idempotency_key: string };
export type PublicationStatus = { token: string | null; version: number | null; title: string | null; visibility: string | null; projection_pending?: boolean };
export type PublicationResult = { token: string; version: number; revoked: boolean };
export type PublicEdition = { set_id: string; set_name: string; collector_number: string; variant: Record<string, unknown>; image_url: string | null; quantity: string };
export type PublicIdentity = { name: string; quantity: string; editions: PublicEdition[] };
export type PublicIdentityCheck = { name: string; quantity: string; status: string };
export type PublicChecks = { size_status: string; shortage: string; excess: string; identities: PublicIdentityCheck[]; disclaimer?: string };
export type PublicSnapshot = { title: string; published_at: string; version: number; total: string; identities: PublicIdentity[]; checks: PublicChecks };

export class PublicationError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
async function request<T>(path: string, method: string, body?: object): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new PublicationError(response.status, payload?.detail?.code ?? 'PUBLICATION_REQUEST_FAILED');
  }
  return response.json() as Promise<T>;
}
export const getPublication = (id: string) => request<PublicationStatus>(`/api/decks/${encodeURIComponent(id)}/publication`, 'GET');
export const publishDeck = (id: string, body: PublishCommand) => request<PublicationResult>(`/api/decks/${encodeURIComponent(id)}/publication`, 'POST', body);
export const republishDeck = (id: string, body: PublishCommand) => request<PublicationResult>(`/api/decks/${encodeURIComponent(id)}/publication`, 'PUT', body);
export const revokeDeck = (id: string, body: RevokeCommand) => request<PublicationResult>(`/api/decks/${encodeURIComponent(id)}/publication`, 'DELETE', body);
export const getPublicDeck = (token: string) => request<PublicSnapshot>(`/api/public/decks/${encodeURIComponent(token)}`, 'GET');
