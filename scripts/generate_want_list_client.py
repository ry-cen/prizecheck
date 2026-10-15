"""Generate the Want List client module from the API OpenAPI schema (decklist import #209)."""
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
    if value.get("type") == "object":
        return "Record<string, unknown>"
    return {"string": "string", "integer": "number", "number": "number", "boolean": "boolean",
            "null": "null"}[value["type"]]


schema = app.openapi()["components"]["schemas"]
lines = ["// Generated from FastAPI OpenAPI by scripts/generate_want_list_client.py. Do not edit."]
for name in ("WantListDeck", "CountedFromDeck", "SwapHint", "WantListLine", "WantListSection", "CombinedDeckNeed", "CombinedRow",
             "WantList"):
    definition = schema[name]
    fields = [f"{field}{'' if field in definition.get('required', []) else '?'}: {ts_type(value)}"
              for field, value in definition["properties"].items()]
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
lines.append("""
export class WantListError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
// What every Deck still needs under the account's counting setting (decklist import #209): every Deck's section and
// the combined total, or, with a Deck id, that Deck's section and needs (404 DECK_NOT_FOUND for any other id).
export async function getWantList(deckId?: string | null, signal?: AbortSignal): Promise<WantList> {
  const response = await fetch('/api/want-list' + (deckId ? '?deck=' + encodeURIComponent(deckId) : ''),
    { credentials: 'same-origin', signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new WantListError(response.status, payload?.detail?.code ?? 'WANT_LIST_REQUEST_FAILED');
  }
  return response.json() as Promise<WantList>;
}
""")
content = "\n".join(lines)
target = root / "web/src/want_list_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated Want List client is stale")
else:
    target.write_text(content)
