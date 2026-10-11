"""Generate the format check client module from the API OpenAPI schema."""
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "api"))
from app.main import app  # noqa: E402


def ts_type(value):
    if "$ref" in value:
        return value["$ref"].split("/")[-1]
    if "anyOf" in value:
        return " | ".join(ts_type(part) for part in value["anyOf"])
    if "enum" in value:
        return " | ".join(f"'{item}'" for item in value["enum"])
    if "const" in value:
        return f"'{value['const']}'"
    if value.get("type") == "array":
        return f"{ts_type(value['items'])}[]"
    return {"string": "string", "integer": "number", "number": "number", "boolean": "boolean", "null": "null"}[value["type"]]


schema = app.openapi()["components"]["schemas"]
lines = ["// Generated from FastAPI OpenAPI by scripts/generate_format_checks_client.py. Do not edit."]
for name in ("FormatIssue", "FormatCheck", "DeckFormatChecks", "PublishedFormatIssue", "PublishedFormatCheck",
             "PublishedDeckFormatChecks"):
    definition = schema[name]
    # The route always serializes every field, so every field is present even where the model has a default.
    fields = [f"{field}: {ts_type(value)}" for field, value in definition["properties"].items()]
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
lines.append("""
export class FormatCheckError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
// Advisory Standard, Expanded and Gym Leader Challenge results for a Deck's Deck List. ``format`` ('standard', 'expanded'
// or 'glc') narrows the response to one format; ``asOf`` (YYYY-MM-DD) checks as of that date instead of today.
export async function getDeckFormatChecks(deckId: string, options: { format?: string; asOf?: string } = {},
                                          signal?: AbortSignal): Promise<DeckFormatChecks> {
  const query = new URLSearchParams();
  if (options.format) query.set('format', options.format);
  if (options.asOf) query.set('as_of', options.asOf);
  const suffix = query.toString() ? '?' + query.toString() : '';
  const response = await fetch(`/api/decks/${encodeURIComponent(deckId)}/format-checks${suffix}`,
                               { method: 'GET', credentials: 'same-origin', signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new FormatCheckError(response.status, payload?.detail?.code ?? 'FORMAT_CHECK_REQUEST_FAILED');
  }
  return response.json() as Promise<DeckFormatChecks>;
}
// A Published Deck's advisory results, recomputed from current public card facts: only the token, the snapshot version
// and the same optional ``format``/``asOf`` are sent, and no cookie. An issue's ``lines`` are the frozen rows' public
// Edition references ("row:<n>" for a legacy row without one).
export async function getPublishedFormatChecks(token: string, version: number,
                                               options: { format?: string; asOf?: string } = {},
                                               signal?: AbortSignal): Promise<PublishedDeckFormatChecks> {
  const query = new URLSearchParams();
  if (options.format) query.set('format', options.format);
  if (options.asOf) query.set('as_of', options.asOf);
  const suffix = query.toString() ? '?' + query.toString() : '';
  const response = await fetch(
    `/api/public/decks/${encodeURIComponent(token)}/versions/${version}/format-checks${suffix}`,
    { method: 'GET', credentials: 'omit', signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new FormatCheckError(response.status, payload?.detail?.code ?? 'FORMAT_CHECK_REQUEST_FAILED');
  }
  return response.json() as Promise<PublishedDeckFormatChecks>;
}
""")
content = "\n".join(lines)
target = root / "web/src/format_checks_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated format check client is stale")
else:
    target.write_text(content)
