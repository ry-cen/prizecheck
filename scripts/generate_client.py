"""Small deterministic OpenAPI-to-TypeScript generator for this initial API contract."""
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "api"))
from app.main import app  # noqa: E402

schema = app.openapi()
assert "/api/locations" in schema["paths"]
assert "/api/health" in schema["paths"]


def typescript_type(value):
    if "$ref" in value:
        return value["$ref"].split("/")[-1]
    if "anyOf" in value:
        return " | ".join(typescript_type(part) for part in value["anyOf"])
    if value.get("type") == "array":
        return f"{typescript_type(value['items'])}[]"
    if value.get("type") == "object":
        return "Record<string, unknown>"
    return {"string": "string", "integer": "number", "number": "number", "boolean": "boolean", "null": "null"}[value["type"]]


lines = ["// Generated from FastAPI OpenAPI by scripts/generate_client.py. Do not edit."]
for name in ("Location", "LocationsResponse", "HealthResponse", "CatalogStatus", "CatalogRun", "CatalogReview", "OwnerCatalogStatus", "EditionView", "PrintingView", "SearchResponse", "DetailResponse", "ReportInput", "ReportView", "ReportUpdate", "DecisionInput", "QuotaStatus", "OperationsStatus"):
    definition = schema["components"]["schemas"][name]
    fields = []
    for key, value in definition["properties"].items():
        optional = "" if key in definition.get("required", []) else "?"
        fields.append(f"{key}{optional}: {typescript_type(value)}")
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
content = "\n".join(lines) + "\n" + """export async function getOperationsStatus(): Promise<OperationsStatus> {
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
target = root / "web/src/generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated TypeScript client is stale")
else:
    target.write_text(content)
