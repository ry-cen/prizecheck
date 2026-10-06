import { MoveError, type MoveResult } from './moves_generated';
export type UndoEntry = { id: string; action: 'move' | 'remove'; expires_at: string };
async function request<T>(path: string, method = 'GET', body?: object): Promise<T> {
 const response = await fetch(path, { method, credentials: 'same-origin', headers: body ? {'content-type':'application/json'} : undefined, body: body ? JSON.stringify(body) : undefined });
 if (!response.ok) { const error = await response.json().catch(() => ({})); throw new MoveError(response.status,error?.detail?.code ?? 'REQUEST_FAILED'); }
 return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
export const removeInventory = (manifest: string, key: string) => request<MoveResult>(`/api/moves/manifests/${encodeURIComponent(manifest)}/remove`, 'POST', {idempotency_key:key});
export const listUndo = () => request<UndoEntry[]>('/api/moves/undo');
export const applyUndo = (id: string, key: string) => request<MoveResult>(`/api/moves/undo/${encodeURIComponent(id)}`, 'POST', {idempotency_key:key});
export const dismissUndo = (id: string) => request<void>(`/api/moves/undo/${encodeURIComponent(id)}`, 'DELETE');
