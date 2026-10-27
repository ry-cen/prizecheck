"""Generate the Want List client module from the API OpenAPI schema (decklist import #209)."""
import client_generator as gen

TARGET = "web/src/want_list_generated.ts"
NAMES = ("WantListDeck", "CountedFromDeck", "SwapHint", "WantListLine", "WantListSection", "CombinedDeckNeed", "CombinedRow",
         "WantList")

BODY = """
%(error)s
// What every Deck still needs under the account's counting setting (decklist import #209): every Deck's section and
// the combined total, or, with a Deck id, that Deck's section and needs (404 DECK_NOT_FOUND for any other id).
export async function getWantList(deckId?: string | null, signal?: AbortSignal): Promise<WantList> {
  const response = await fetch('/api/want-list' + (deckId ? '?deck=' + encodeURIComponent(deckId) : ''),
    { credentials: 'same-origin', signal });
%(f0)s
  return response.json() as Promise<WantList>;
}
"""


def render(openapi):
    schemas = openapi["components"]["schemas"]
    body = BODY % {"error": gen.error_class('WantListError'),
                   "f0": gen.failure_block('WantListError', 'WANT_LIST_REQUEST_FAILED')}
    return gen.assemble([gen.header("generate_want_list_client"), *gen.SINGLE.aliases(schemas, NAMES), body])


if __name__ == "__main__":
    gen.main(__name__)
