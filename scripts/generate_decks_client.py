"""Generate Deck request and response types from the API OpenAPI schema."""
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
names = ("TreeNode", "LocationCommandResult", "CreateDeck", "EditDeck", "DeckIndexEntry", "DeckIndex", "IdentityCheck", "DeckChecks", "DeckDetail", "DeckEditionQuantity", "DeckContents",
         "DeckListLine", "DeckList", "AddDeckListLine", "ChangeDeckListLine", "RemoveDeckListLine", "SetTargetFormat",
         "DeckListCommandResult",
         "ElsewhereLocation", "LineOwnership", "SurplusHolding", "CompetingDeck", "CompetitionWarning",
         "AddDeckListPrinting", "DeckListPrintingResult",
         "PickWarning", "PickSource", "PickRow", "PutAwayHolding", "PickList", "PickItem", "ConfirmPicks",
         "PickConfirmResult", "DeleteDeck", "DeleteDeckResult")
lines = ["// Generated from FastAPI OpenAPI by scripts/generate_decks_client.py. Do not edit.",
         "import type { DeckFormatChecks } from './format_checks_generated';"]
for name in names:
    definition = schema[name]
    fields = [f"{field}{'' if field in definition.get('required', []) else '?'}: {ts_type(value)}"
              for field, value in definition["properties"].items()]
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
lines.append("""
export class DeckError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
async function request<T>(path: string, method: string, body?: object): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new DeckError(response.status, payload?.detail?.code ?? 'DECK_REQUEST_FAILED');
  }
  return response.json() as Promise<T>;
}
export const getDecks = (cursor?: string) => request<DeckIndex>('/api/decks' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), 'GET');
export const createDeck = (body: CreateDeck) => request<LocationCommandResult>('/api/decks', 'POST', body);
export const editDeck = (id: string, body: EditDeck) => request<LocationCommandResult>(`/api/decks/${encodeURIComponent(id)}`, 'PATCH', body);
export async function getDeckContents(id: string, currentRevision?: () => number): Promise<DeckContents> {
  const contents = await request<DeckContents>(`/api/decks/${encodeURIComponent(id)}/contents`, 'GET');
  if (currentRevision && contents.owner_revision !== currentRevision()) {
    throw new DeckError(409, 'INVENTORY_CHANGED');
  }
  return contents;
}
export const getDeck = (id: string) => request<DeckDetail>(`/api/decks/${encodeURIComponent(id)}`, 'GET');
const deckListLines = (deckId: string) => `/api/decks/${encodeURIComponent(deckId)}/deck-list/lines`;
export const addDeckListLine = (deckId: string, body: AddDeckListLine) =>
  request<DeckListCommandResult>(deckListLines(deckId), 'POST', body);
export const changeDeckListLine = (deckId: string, editionId: string, body: ChangeDeckListLine) =>
  request<DeckListCommandResult>(`${deckListLines(deckId)}/${encodeURIComponent(editionId)}`, 'PATCH', body);
export const removeDeckListLine = (deckId: string, editionId: string, body: RemoveDeckListLine) =>
  request<DeckListCommandResult>(`${deckListLines(deckId)}/${encodeURIComponent(editionId)}`, 'DELETE', body);
// Changes the Deck List's Target Format (app redesign #178); answers the new Format's result.
export const setTargetFormat = (deckId: string, body: SetTargetFormat) =>
  request<DeckListCommandResult>(`/api/decks/${encodeURIComponent(deckId)}/deck-list/target-format`, 'PUT', body);
export const addDeckListPrinting = (deckId: string, body: AddDeckListPrinting) =>
  request<DeckListPrintingResult>(`/api/decks/${encodeURIComponent(deckId)}/deck-list/printings`, 'POST', body);
export const getPickList = (deckId: string) =>
  request<PickList>(`/api/decks/${encodeURIComponent(deckId)}/pick-list`, 'GET');
export const confirmPicks = (deckId: string, body: ConfirmPicks) =>
  request<PickConfirmResult>(`/api/decks/${encodeURIComponent(deckId)}/pick-list/confirm`, 'POST', body);
export const deleteDeck = (id: string, body: DeleteDeck) =>
  request<DeleteDeckResult>(`/api/decks/${encodeURIComponent(id)}`, 'DELETE', body);
""")
content = "\n".join(lines)
target = root / "web/src/decks_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated Deck client is stale")
else:
    target.write_text(content)
