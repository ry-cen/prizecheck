"""Generate Publication request and response types from the API OpenAPI schema."""
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "api"))
from app.main import app  # noqa: E402


def ts_type(value):
    if "enum" in value:
        return " | ".join(repr(part) for part in value["enum"])
    if "$ref" in value:
        return value["$ref"].split("/")[-1]
    if "anyOf" in value:
        return " | ".join(ts_type(part) for part in value["anyOf"])
    if value.get("type") == "array":
        return f"{ts_type(value['items'])}[]"
    if value.get("type") == "object":
        return "Record<string, unknown>"
    return {"boolean": "boolean", "string": "string", "integer": "number", "number": "number", "null": "null"}[value["type"]]


schema = app.openapi()["components"]["schemas"]
names = ("VisibilityCommand", "PublishCommand", "RevokeCommand", "PublicationStatus", "PublicationResult", "OwnedPublication", "OwnedPublications", "PublicEdition", "PublicIdentity", "PublicIdentityCheck", "PublicChecks", "PublicSnapshot")
lines = ["// Generated from FastAPI OpenAPI by scripts/generate_publications_client.py. Do not edit."]
for name in names:
    definition = schema[name]
    fields = [f"{field}{'' if field in definition.get('required', []) else '?'}: {ts_type(value)}"
              for field, value in definition["properties"].items()]
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
lines.append("""
export class PublicationError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
async function request<T>(path: string, method: string, body?: object, onResponse?: (response: Response) => void): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new PublicationError(response.status, payload?.detail?.code ?? 'PUBLICATION_REQUEST_FAILED');
  }
  onResponse?.(response);
  return response.json() as Promise<T>;
}
export const getPublication = (id: string) => request<PublicationStatus>(`/api/decks/${encodeURIComponent(id)}/publication`, 'GET');
export const publishDeck = (id: string, body: PublishCommand) => request<PublicationResult>(`/api/decks/${encodeURIComponent(id)}/publication`, 'POST', body);
export const republishDeck = (id: string, body: PublishCommand) => request<PublicationResult>(`/api/decks/${encodeURIComponent(id)}/publication`, 'PUT', body);
export const revokeDeck = (id: string, body: RevokeCommand) => request<PublicationResult>(`/api/decks/${encodeURIComponent(id)}/publication`, 'DELETE', body);
export const setPublicationVisibility = (id: string, body: VisibilityCommand) => request<PublicationResult>(`/api/decks/${encodeURIComponent(id)}/publication/visibility`, 'PATCH', body);
export const getOwnedPublications = () => request<OwnedPublications>('/api/publications', 'GET');
export const revokePublication = (token: string, body: RevokeCommand) => request<PublicationResult>(`/api/publications/${encodeURIComponent(token)}`, 'DELETE', body);
export const setPublishedDeckVisibility = (token: string, body: VisibilityCommand) => request<PublicationResult>(`/api/publications/${encodeURIComponent(token)}/visibility`, 'PATCH', body);
export async function getPublicDeckPage(token: string) {
  let robots = 'noindex, nofollow';
  const snapshot = await request<PublicSnapshot>(`/api/public/decks/${encodeURIComponent(token)}`, 'GET', undefined, response => { robots = response.headers.get('x-robots-tag') ?? robots; });
  return { snapshot, robots };
}
export const getPublicDeck = (token: string) => request<PublicSnapshot>(`/api/public/decks/${encodeURIComponent(token)}`, 'GET');
""")
content = "\n".join(lines)
target = root / "web/src/publications_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated Publication client is stale")
else:
    target.write_text(content)
