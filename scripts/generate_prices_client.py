"""Generate the Price client module from the API OpenAPI schema."""
import client_generator as gen

TARGET = "web/src/prices_generated.ts"
NAMES = ("PriceRow", "PricesResponse", "DeckCostFigures", "DeckCost", "PublishedEditionPrice", "PublishedDeckCost")
# The route always serializes every field, so every field is present even where the model has a default.
STYLE = gen.TypeStyle(optional_marks=False)

BODY = """
export const MAX_PRICE_EDITIONS = %(max_editions)s;

%(error)s
export async function getEditionPrices(editionIds: string[], signal?: AbortSignal): Promise<PricesResponse> {
  const response = await fetch('/api/prices/editions', { method: 'POST', credentials: 'same-origin', signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ edition_ids: editionIds }) });
%(failure)s
  return response.json() as Promise<PricesResponse>;
}
// One access prices every copy of the Deck server-side; the browser never sums rows or pages.
export async function getDeckCost(deckId: string, signal?: AbortSignal): Promise<DeckCost> {
  const response = await fetch(`/api/decks/${encodeURIComponent(deckId)}/cost`, { method: 'GET', credentials: 'same-origin', signal });
%(failure)s
  return response.json() as Promise<DeckCost>;
}
// One anonymous access prices every frozen copy of one Published Deck snapshot version. Only the token and the version
// are sent, and no cookie: the gateway treats every /api/public/ route as anonymous anyway.
export async function getPublishedDeckCost(token: string, version: number, signal?: AbortSignal): Promise<PublishedDeckCost> {
  const response = await fetch(`/api/public/decks/${encodeURIComponent(token)}/versions/${version}/cost`, { method: 'GET', credentials: 'omit', signal });
%(failure)s
  return response.json() as Promise<PublishedDeckCost>;
}
"""


def render(openapi):
    from app.prices import MAX_EDITIONS  # noqa: E402

    schemas = openapi["components"]["schemas"]
    body = BODY % {"max_editions": MAX_EDITIONS, "error": gen.error_class("PriceError"),
                   "failure": gen.failure_block("PriceError", "PRICE_REQUEST_FAILED")}
    return gen.assemble([gen.header("generate_prices_client"), *STYLE.aliases(schemas, NAMES), body])


if __name__ == "__main__":
    gen.main(__name__)
