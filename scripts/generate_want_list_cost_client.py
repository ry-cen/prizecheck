"""Generate the Want List cost and Buy on TCGplayer client module from the API OpenAPI schema (decklist import #210)."""
import client_generator as gen

TARGET = "web/src/want_list_cost_generated.ts"
NAMES = ("WantListLineCost", "WantListSectionCost", "WantListRowCost", "WantListCost", "WantListMassEntryView")

BODY = """
%(error)s
const scoped = (path: string, deckId?: string | null) => path + (deckId ? '?deck=' + encodeURIComponent(deckId) : '');
async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', signal });
%(failure)s
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
"""


def render(openapi):
    schemas = openapi["components"]["schemas"]
    body = BODY % {"error": gen.error_class("WantListCostError"),
                   "failure": gen.failure_block("WantListCostError", "WANT_LIST_REQUEST_FAILED")}
    return gen.assemble([gen.header("generate_want_list_cost_client"),
                         # Types other generated clients own, referenced here by name.
                         "import type { DeckCostFigures } from './prices_generated';",
                         "import type { MassEntryLineView } from './mass_entry_generated';",
                         *gen.SINGLE.aliases(schemas, NAMES), body])


if __name__ == "__main__":
    gen.main(__name__)
