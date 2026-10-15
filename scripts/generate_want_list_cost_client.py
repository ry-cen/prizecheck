"""Generate the Want List cost and Buy on TCGplayer client module from the API OpenAPI schema (decklist import #210)."""
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
lines = ["// Generated from FastAPI OpenAPI by scripts/generate_want_list_cost_client.py. Do not edit.",
         # Types other generated clients own, referenced here by name.
         "import type { DeckCostFigures } from './prices_generated';",
         "import type { MassEntryLineView } from './mass_entry_generated';"]
for name in ("WantListLineCost", "WantListSectionCost", "WantListRowCost", "WantListCost", "WantListMassEntryView"):
    definition = schema[name]
    fields = [f"{field}{'' if field in definition.get('required', []) else '?'}: {ts_type(value)}"
              for field, value in definition["properties"].items()]
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
lines.append("""
export class WantListCostError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const scoped = (path: string, deckId?: string | null) => path + (deckId ? '?deck=' + encodeURIComponent(deckId) : '');
async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new WantListCostError(response.status, payload?.detail?.code ?? 'WANT_LIST_REQUEST_FAILED');
  }
  return response.json() as Promise<T>;
}
// The Want List's cost for the same scope as GET /api/want-list (decklist import #210): a price access under ADR 0006,
// read separately so the page draws first. Show it only for the answer whose setting, revisions and digest it names.
export const getWantListCost = (deckId?: string | null, signal?: AbortSignal) =>
  read<WantListCost>(scoped('/api/want-list/cost', deckId), signal);
// Buy on TCGplayer: the Mass Entry export of the combined total, or of one Deck's needs.
export const getWantListMassEntry = (deckId?: string | null, signal?: AbortSignal) =>
  read<WantListMassEntryView>(scoped('/api/want-list/exports/tcgplayer', deckId), signal);
// The text download, pinned to the view it was prepared from (409 once the inventory, a Deck List or the setting moved).
export const wantListMassEntryDownloadHref = (view: WantListMassEntryView) =>
  `/api/want-list/exports/tcgplayer.txt?${view.deck_id ? `deck=${encodeURIComponent(view.deck_id)}&` : ''}owner_revision=${view.owner_revision}&settings_revision=${view.settings_revision}&deck_lists=${view.deck_lists_digest}`;
""")
content = "\n".join(lines)
target = root / "web/src/want_list_cost_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated Want List cost client is stale")
else:
    target.write_text(content)
