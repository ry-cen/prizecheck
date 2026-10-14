// Generated from FastAPI OpenAPI by scripts/generate_moves_client.py. Do not edit.
export type MoveItem = { edition_id: string; quantity: string; expected_version: number; source_id?: string | null };
export type MoveManifest = { id: string; source_id: string | null; expires_at: string; item_count: number };
export type MoveResult = { edition_count: number; copy_count: string; owner_revision: number; source_count: number; already_at_destination_count: string; undo_id?: string | null };

export type MoveErrorDetail = { source_id?: string; edition_id?: string; destination_id?: string };
export class MoveError extends Error {
  constructor(public status: number, public code: string, public detail: MoveErrorDetail = {}) { super(code); }
}
async function request<T>(path: string, method: string, body?: object): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const failure = payload?.detail;
    const detail: MoveErrorDetail = failure && typeof failure === 'object' && !Array.isArray(failure)
      ? { source_id: failure.source_id, edition_id: failure.edition_id, destination_id: failure.destination_id } : {};
    throw new MoveError(response.status, failure?.code ?? 'MOVE_REQUEST_FAILED', detail);
  }
  return response.json() as Promise<T>;
}
export const startMove = (source_id?: string) => request<MoveManifest>('/api/moves/manifests', 'POST', source_id ? { source_id } : {});
export const stageMove = (id: string, items: MoveItem[]) => request<MoveManifest>(`/api/moves/manifests/${encodeURIComponent(id)}/items`, 'PUT', { items });
// put_away marks the deck builder's Put away, whose Undo returns the copies to the Deck as surplus (migration 047).
export const commitMove = (id: string, destination_id: string, idempotency_key: string, put_away = false) => request<MoveResult>(`/api/moves/manifests/${encodeURIComponent(id)}/commit`, 'POST', put_away ? { destination_id, idempotency_key, put_away } : { destination_id, idempotency_key });
