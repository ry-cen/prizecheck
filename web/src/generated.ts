// Generated from FastAPI OpenAPI by scripts/generate_client.py. Do not edit.
export type Location = { id: string; name: string; kind: string; parent_id: string | null; version: number };
export type LocationsResponse = { locations: Location[] };
export type HealthResponse = { status: string };
export async function getLocations(): Promise<LocationsResponse> {
  const response = await fetch('/api/locations', { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Locations request failed (${response.status})`);
  return response.json() as Promise<LocationsResponse>;
}
