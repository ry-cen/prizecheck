// Generated from FastAPI OpenAPI by scripts/generate_moves_client.py. Do not edit.
export type MoveItem = { edition_id: string; quantity: string; expected_version: number };
export type MoveManifest = { id: string; source_id: string; expires_at: string; item_count: number };
export type MoveResult = { edition_count: number; copy_count: string; owner_revision: number };

export class MoveError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
async function request<T>(path: string, method: string, body?: object): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new MoveError(response.status, payload?.detail?.code ?? 'MOVE_REQUEST_FAILED');
  }
  return response.json() as Promise<T>;
}
export const startMove = (source_id: string) => request<MoveManifest>('/api/moves/manifests', 'POST', { source_id });
export const stageMove = (id: string, items: MoveItem[]) => request<MoveManifest>(`/api/moves/manifests/${encodeURIComponent(id)}/items`, 'PUT', { items });
export const commitMove = (id: string, destination_id: string, idempotency_key: string) => request<MoveResult>(`/api/moves/manifests/${encodeURIComponent(id)}/commit`, 'POST', { destination_id, idempotency_key });
