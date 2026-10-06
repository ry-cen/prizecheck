// Generated from FastAPI OpenAPI by scripts/generate_decks_client.py. Do not edit.
export type TreeNode = { id: string; name: string; kind: string; parent_id: string | null; version: number; depth: number };
export type LocationCommandResult = { location: TreeNode; owner_revision: number };
export type CreateDeck = { name: string; idempotency_key: string };
export type DeckIndex = { decks: TreeNode[]; owner_revision: number; next_cursor: string | null };
export type IdentityCheck = { identity_id: string; name: string; quantity: string; status: string };
export type DeckChecks = { total: string; shortage: string; excess: string; size_status: string; identities: IdentityCheck[]; disclaimer?: string };
export type DeckDetail = { deck: TreeNode; checks: DeckChecks; owner_revision: number; catalog_revision: number };

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
export const getDeck = (id: string) => request<DeckDetail>(`/api/decks/${encodeURIComponent(id)}`, 'GET');
