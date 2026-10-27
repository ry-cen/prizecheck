"""Generate Deck request and response types from the API OpenAPI schema."""
import client_generator as gen

TARGET = "web/src/decks_generated.ts"
NAMES = ("TreeNode", "LocationCommandResult", "CreateDeck", "EditDeck", "DeckIndexCover", "DeckIndexEntry", "DeckIndex", "IdentityCheck", "DeckChecks", "LoanLabel", "DeckLoanLine", "DeckDetail", "DeckEditionQuantity", "DeckContents",
         "DeckListLine", "DeckList", "AddDeckListLine", "ChangeDeckListLine", "RemoveDeckListLine", "SetTargetFormat",
         "DeckListCommandResult", "SetDeckCover", "DeckCoverResult",
         "ElsewhereLocation", "LineOwnership", "SurplusHolding", "CompetingDeck", "CompetitionWarning",
         "AddDeckListPrinting", "DeckListPrintingResult",
         "PickWarning", "PickSource", "PickRow", "PutAwayHolding", "PickList", "PickItem", "ConfirmPicks",
         "PickConfirmResult", "DeleteDeck", "DeleteDeckResult", "DeckListChange", "ChangeDeckList",
         "ImportSource", "ImportFix", "ReviewImport", "ImportPrinting", "ImportEdition", "ImportPlace", "ImportPart",
         "ImportKept", "MissingCardPrefill", "ReviewLine",
         "IgnoredImportLine", "ImportDeckListEntry", "ImportTotals", "ImportPublication", "ImportReview", "ImportDeckLine", "ImportDeck",
         "ImportDeckResult",
         "ReplaceLine", "ImportReplace")

BODY = """
%(error)s
%(request)s
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
// Sets or clears the Deck's cover card (#291): checked against the pick the page last read, never the Deck List's revision.
export const setDeckCover = (deckId: string, body: SetDeckCover) =>
  request<DeckCoverResult>(`/api/decks/${encodeURIComponent(deckId)}/cover`, 'PUT', body);
// Sets several Deck List lines in one batch (app redesign #177): each change is a line's new total, 0 removing it.
export const changeDeckList = (deckId: string, body: ChangeDeckList) =>
  request<DeckListCommandResult>(`/api/decks/${encodeURIComponent(deckId)}/deck-list/changes`, 'POST', body);
export const addDeckListPrinting = (deckId: string, body: AddDeckListPrinting) =>
  request<DeckListPrintingResult>(`/api/decks/${encodeURIComponent(deckId)}/deck-list/printings`, 'POST', body);
export const getPickList = (deckId: string) =>
  request<PickList>(`/api/decks/${encodeURIComponent(deckId)}/pick-list`, 'GET');
export const confirmPicks = (deckId: string, body: ConfirmPicks) =>
  request<PickConfirmResult>(`/api/decks/${encodeURIComponent(deckId)}/pick-list/confirm`, 'POST', body);
export const deleteDeck = (id: string, body: DeleteDeck) =>
  request<DeleteDeckResult>(`/api/decks/${encodeURIComponent(id)}`, 'DELETE', body);
// Decklist Import (#212): read a pasted list against the catalog (read-only; post again after every fix), then create
// a Deck with the Editions the review resolved.
export const reviewImport = (body: ReviewImport) => request<ImportReview>('/api/decks/import/review', 'POST', body);
export const importDeck = (body: ImportDeck) => request<ImportDeckResult>('/api/decks/import', 'POST', body);
"""


def render(openapi):
    schemas = openapi["components"]["schemas"]
    body = BODY % {"error": gen.error_class("DeckError"),
                   "request": gen.simple_request("DeckError", "DECK_REQUEST_FAILED")}
    return gen.assemble([gen.header("generate_decks_client"),
                         "import type { DeckFormatChecks } from './format_checks_generated';",
                         *gen.SINGLE.aliases(schemas, NAMES), body])


if __name__ == "__main__":
    gen.main(__name__)
