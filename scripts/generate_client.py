"""Small deterministic OpenAPI-to-TypeScript generator for this initial API contract."""
import client_generator as gen

TARGET = "web/src/generated.ts"
NAMES = ("Location", "LocationsResponse", "HealthResponse", "CatalogStatus", "CatalogRun", "CatalogReview", "OwnerCatalogStatus", "EditionView", "PrintingView", "SearchResponse", "DetailResponse", "ReportInput", "ReportView", "ReportUpdate", "DecisionInput", "QuotaStatus", "OperationsStatus")

# Hand-written routes: each throws a plain Error with its own message, so there is no shared error class.
BODY = """export async function getOperationsStatus(): Promise<OperationsStatus> {
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
"""


def render(openapi):
    assert "/api/locations" in openapi["paths"]
    assert "/api/health" in openapi["paths"]
    schemas = openapi["components"]["schemas"]
    return gen.assemble([gen.header("generate_client"), *gen.SINGLE.aliases(schemas, NAMES), BODY])


if __name__ == "__main__":
    gen.main(__name__)
