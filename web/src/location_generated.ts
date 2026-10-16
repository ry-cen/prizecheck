// Generated from FastAPI OpenAPI by scripts/generate_location_client.py. Do not edit.
export type TreeNode = { id: string; name: string; kind: string; parent_id: string | null; version: number; depth: number };
export type TreeLocation = { id: string; name: string; kind: string; parent_id: string | null; version: number; depth: number; copy_count: string; hidden: boolean; hidden_by: string | null };
export type TreeResponse = { locations: TreeLocation[]; owner_revision: number; lent_copies: string; borrowed_copies: string };
export type LocationCommandResult = { location: TreeNode; owner_revision: number };
export type CreateLocation = { name: string; parent_id?: string | null; parent_version?: number | null; conversion?: string | null; idempotency_key: string };
export type EditLocation = { name?: string | null; parent_id?: string | null; parent_version?: number | null; conversion?: string | null; version: number; idempotency_key: string };
export type DeleteLocation = { name: string; version: number; idempotency_key: string };
export type DeleteLocationResult = { deleted_id: string; owner_revision: number };
export type SetLocationHidden = { hidden: boolean; version: number; idempotency_key: string };
export type LocationHiddenResult = { location: TreeNode; hidden: boolean; hidden_by: string | null };

export class LocationError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
async function locationRequest<T>(path: string, method = 'GET', body?: object): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new LocationError(response.status, payload?.detail?.code ?? 'LOCATION_REQUEST_FAILED');
  }
  return response.json() as Promise<T>;
}
export const getLocationTree = () => locationRequest<TreeResponse>('/api/location-tree');
export const createLocation = (body: CreateLocation) => locationRequest<LocationCommandResult>('/api/location-tree', 'POST', body);
export const editLocation = (id: string, body: EditLocation) => locationRequest<LocationCommandResult>(`/api/location-tree/${id}`, 'PATCH', body);
export const deleteLocation = (id: string, body: DeleteLocation) => locationRequest<DeleteLocationResult>(`/api/location-tree/${id}`, 'DELETE', body);
export const setLocationHidden = (id: string, body: SetLocationHidden) => locationRequest<LocationHiddenResult>(`/api/location-tree/${id}/hidden`, 'PUT', body);
