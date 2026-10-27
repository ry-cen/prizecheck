"""Generate the format check client module from the API OpenAPI schema."""
import client_generator as gen

TARGET = "web/src/format_checks_generated.ts"
NAMES = ("FormatIssue", "FormatCheck", "DeckFormatChecks", "PublishedFormatIssue", "PublishedFormatCheck",
         "PublishedDeckFormatChecks")
# The routes always serialize every field, so every field is present even where the model has a default.
STYLE = gen.TypeStyle(optional_marks=False)

BODY = """
%(error)s
// The advisory result of a Deck's Deck List in its Target Format (app redesign #178). ``format`` ('standard', 'expanded'
// or 'glc') asks for another Format instead; ``asOf`` (YYYY-MM-DD) checks as of that date instead of today.
export async function getDeckFormatChecks(deckId: string, options: { format?: string; asOf?: string } = {},
                                          signal?: AbortSignal): Promise<DeckFormatChecks> {
  const query = new URLSearchParams();
  if (options.format) query.set('format', options.format);
  if (options.asOf) query.set('as_of', options.asOf);
  const suffix = query.toString() ? '?' + query.toString() : '';
  const response = await fetch(`/api/decks/${encodeURIComponent(deckId)}/format-checks${suffix}`,
                               { method: 'GET', credentials: 'same-origin', signal });
%(f0)s
  return response.json() as Promise<DeckFormatChecks>;
}
// A Published Deck's advisory result in its Target Format (app redesign #183), recomputed from current public card
// facts: only the token, the snapshot version and an optional ``asOf`` are sent, and no cookie. An issue's ``lines`` are
// the frozen rows' public Edition references ("row:<n>" for a legacy row without one).
export async function getPublishedFormatChecks(token: string, version: number,
                                               options: { asOf?: string } = {},
                                               signal?: AbortSignal): Promise<PublishedDeckFormatChecks> {
  const query = new URLSearchParams();
  if (options.asOf) query.set('as_of', options.asOf);
  const suffix = query.toString() ? '?' + query.toString() : '';
  const response = await fetch(
    `/api/public/decks/${encodeURIComponent(token)}/versions/${version}/format-checks${suffix}`,
    { method: 'GET', credentials: 'omit', signal });
%(f1)s
  return response.json() as Promise<PublishedDeckFormatChecks>;
}
"""


def render(openapi):
    schemas = openapi["components"]["schemas"]
    body = BODY % {"error": gen.error_class('FormatCheckError'),
                   "f0": gen.failure_block('FormatCheckError', 'FORMAT_CHECK_REQUEST_FAILED'),
                         "f1": gen.failure_block('FormatCheckError', 'FORMAT_CHECK_REQUEST_FAILED')}
    return gen.assemble([gen.header("generate_format_checks_client"), *STYLE.aliases(schemas, NAMES), body])


if __name__ == "__main__":
    gen.main(__name__)
