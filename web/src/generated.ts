// Generated from FastAPI OpenAPI by scripts/generate_client.py. Do not edit.
export type Location = { id: string; name: string; kind: string; parent_id: string | null; version: number };
export type LocationsResponse = { locations: Location[] };
export type HealthResponse = { status: string };
export type CatalogStatus = { available: boolean; revision: number; last_success: string | null };
export type CatalogRun = { id: string; phase: string; outcome: string | null; enumerated_count: number; fetched_count: number; validated_count: number; error: string | null; started_at: string; finished_at: string | null; heartbeat_stale: boolean };
export type CatalogReview = { id: string; kind: string; source_id: string; detail: string; created_at: string };
export type OwnerCatalogStatus = { catalog: CatalogStatus; run: CatalogRun | null; pending_reviews: CatalogReview[] };
export type EditionView = { id: string; descriptor: Record<string, unknown>; active: boolean; source: string; evidence_url?: string | null };
export type PrintingView = { id: string; source: string; source_id: string | null; set_id: string; set_name: string; collector_number: string; name: string; identity_id: string; identity_name: string; basic_energy: string; tombstoned: boolean; low_image_url: string | null; high_image_url: string | null; editions: EditionView[]; evidence_url?: string | null; source_references?: string[] };
export type SearchResponse = { available: boolean; revision: number; last_success: string | null; printings: PrintingView[]; next_cursor: string | null };
export type DetailResponse = { revision: number; last_success: string; printing: PrintingView };
export type ReportInput = { kind: string; set_id?: string | null; set_name?: string | null; collector_number?: string | null; english_name?: string | null; printing_id?: string | null; descriptor?: Record<string, unknown> | null; evidence_url?: string | null; note?: string };
export type ReportView = { id: string; kind: string; status: string; set_id: string | null; set_name: string | null; collector_number: string | null; english_name: string | null; printing_id: string | null; descriptor: Record<string, unknown> | null; evidence_url: string | null; note: string; review_reason: string | null; approved_printing_id: string | null; approved_edition_id: string | null; created_at: string; updated_at: string };
export type ReportUpdate = { note: string; evidence_url?: string | null };
export type DecisionInput = { decision: string; reason: string; code?: string | null; set_id?: string | null; set_name?: string | null; collector_number?: string | null; english_name?: string | null; printing_id?: string | null; descriptor?: Record<string, unknown> | null; evidence_url?: string | null };
export type QuotaStatus = { resource: string; used: number; allowance: number; measured_at: string; warning: boolean; verified: boolean };
export type OperationsStatus = { backup_last_success: string | null; restore_last_success: string | null; backup_state: string; backup_stale: boolean; backup_failures: number; restore_failures: number; backup_alerts: number; watchdog_last_check: string | null; projection_failures: number; projection_pending: number; catalog_failures: number; catalog_pending_reviews: number; catalog_outbox_pending: number; catalog_outbox_oldest_seconds: number | null; api_requests_24h: number; api_failures_24h: number; authorization_denials_24h: number; api_mean_ms_24h: number | null; sign_in_requests_24h: number; sign_in_delivery: string; sign_in_delivered: number | null; sign_in_failed: number | null; gateway_authorization_denials: number; release_failures: number; provider_quotas: string; quotas: QuotaStatus[] };
export async function getOperationsStatus(): Promise<OperationsStatus> {
  const response = await fetch('/api/admin/operations', { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Operational status failed (${response.status})`);
  return response.json() as Promise<OperationsStatus>;
}
export async function getLocations(): Promise<LocationsResponse> {
  const response = await fetch('/api/locations', { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Locations request failed (${response.status})`);
  return response.json() as Promise<LocationsResponse>;
}
export async function getCatalogStatus(): Promise<CatalogStatus> {
  const response = await fetch('/api/catalog/status', { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Catalog status failed (${response.status})`);
  return response.json() as Promise<CatalogStatus>;
}
export async function getOwnerCatalogStatus(): Promise<OwnerCatalogStatus | null> {
  const response = await fetch('/api/admin/catalog-runs', { credentials: 'same-origin' });
  if (response.status === 403) return null;
  if (!response.ok) throw new Error(`Owner status failed (${response.status})`);
  return response.json() as Promise<OwnerCatalogStatus>;
}
export async function startCatalogRun(): Promise<OwnerCatalogStatus> {
  const response = await fetch('/api/admin/catalog-runs', { method: 'POST', credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Catalog start failed (${response.status})`);
  return response.json() as Promise<OwnerCatalogStatus>;
}
export async function searchCatalog(filters: { name?: string; set_id?: string; number?: string }, cursor?: string): Promise<SearchResponse> {
  const params = new URLSearchParams(filters);
  if (cursor) params.set('cursor', cursor);
  const response = await fetch(`/api/catalog/search?${params}`, { credentials: 'same-origin' });
  if (response.status === 409) throw new Error('CATALOG_CHANGED');
  if (!response.ok) throw new Error(`Catalog search failed (${response.status})`);
  return response.json() as Promise<SearchResponse>;
}
export async function getPrinting(id: string): Promise<DetailResponse> {
  const response = await fetch(`/api/catalog/printings/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Printing detail failed (${response.status})`);
  return response.json() as Promise<DetailResponse>;
}
async function reportRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin',
    headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { detail?: { message?: string }; error?: string };
    throw new Error(error.detail?.message || error.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}
export function getMyMissingCardReports(): Promise<ReportView[]> {
  return reportRequest('/api/missing-card-reports');
}
export function submitMissingCardReport(body: ReportInput): Promise<ReportView> {
  return reportRequest('/api/missing-card-reports', 'POST', body);
}
export function respondToMissingCardReview(id: string, body: ReportUpdate): Promise<ReportView> {
  return reportRequest(`/api/missing-card-reports/${encodeURIComponent(id)}`, 'PATCH', body);
}
export function getOwnerMissingCardReports(): Promise<ReportView[]> {
  return reportRequest('/api/admin/missing-card-reports');
}
export function beginOwnerMissingCardReport(body: ReportInput): Promise<ReportView> {
  return reportRequest('/api/admin/missing-card-reports', 'POST', body);
}
export function decideMissingCardReport(id: string, body: DecisionInput): Promise<ReportView> {
  return reportRequest(`/api/admin/missing-card-reports/${encodeURIComponent(id)}/decision`, 'POST', body);
}
