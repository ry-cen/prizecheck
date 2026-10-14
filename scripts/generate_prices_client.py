"""Generate the Price client module from the API OpenAPI schema."""
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "api"))
from app.main import app  # noqa: E402
from app.prices import MAX_EDITIONS  # noqa: E402


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
lines = ["// Generated from FastAPI OpenAPI by scripts/generate_prices_client.py. Do not edit."]
for name in ("PriceRow", "PricesResponse", "DeckCostFigures", "DeckCost", "PublishedEditionPrice", "PublishedDeckCost"):
    definition = schema[name]
    # The route always serializes every field, so every field is present even where the model has a default.
    fields = [f"{field}: {ts_type(value)}" for field, value in definition["properties"].items()]
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
lines.append(f"""
export const MAX_PRICE_EDITIONS = {MAX_EDITIONS};

export class PriceError extends Error {{
  constructor(public status: number, public code: string) {{ super(code); }}
}}
export async function getEditionPrices(editionIds: string[], signal?: AbortSignal): Promise<PricesResponse> {{
  const response = await fetch('/api/prices/editions', {{ method: 'POST', credentials: 'same-origin', signal,
    headers: {{ 'content-type': 'application/json' }}, body: JSON.stringify({{ edition_ids: editionIds }}) }});
  if (!response.ok) {{
    const payload = await response.json().catch(() => ({{}}));
    throw new PriceError(response.status, payload?.detail?.code ?? 'PRICE_REQUEST_FAILED');
  }}
  return response.json() as Promise<PricesResponse>;
}}
// One access prices every copy of the Deck server-side; the browser never sums rows or pages.
export async function getDeckCost(deckId: string, signal?: AbortSignal): Promise<DeckCost> {{
  const response = await fetch(`/api/decks/${{encodeURIComponent(deckId)}}/cost`, {{ method: 'GET', credentials: 'same-origin', signal }});
  if (!response.ok) {{
    const payload = await response.json().catch(() => ({{}}));
    throw new PriceError(response.status, payload?.detail?.code ?? 'PRICE_REQUEST_FAILED');
  }}
  return response.json() as Promise<DeckCost>;
}}
// One anonymous access prices every frozen copy of one Published Deck snapshot version. Only the token and the version
// are sent, and no cookie: the gateway treats every /api/public/ route as anonymous anyway.
export async function getPublishedDeckCost(token: string, version: number, signal?: AbortSignal): Promise<PublishedDeckCost> {{
  const response = await fetch(`/api/public/decks/${{encodeURIComponent(token)}}/versions/${{version}}/cost`, {{ method: 'GET', credentials: 'omit', signal }});
  if (!response.ok) {{
    const payload = await response.json().catch(() => ({{}}));
    throw new PriceError(response.status, payload?.detail?.code ?? 'PRICE_REQUEST_FAILED');
  }}
  return response.json() as Promise<PublishedDeckCost>;
}}
""")
content = "\n".join(lines)
target = root / "web/src/prices_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated Price client is stale")
else:
    target.write_text(content)
