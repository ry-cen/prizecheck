"""Generate the Live export client module from the API OpenAPI schema."""
import client_generator as gen

TARGET = "web/src/live_export_generated.ts"
NAMES = ("LiveBlockerView", "LiveExportView", "PublishedLiveBlockerView", "PublishedLiveExportView")

BODY = """
%(error)s
export async function getLiveExport(deckId: string): Promise<LiveExportView> {
  const response = await fetch(`/api/decks/${encodeURIComponent(deckId)}/exports/live`, { credentials: 'same-origin' });
%(f0)s
  return response.json() as Promise<LiveExportView>;
}
export const liveExportDownloadHref = (deckId: string, ownerRevision: number, deckListRevision?: number | null) =>
  `/api/decks/${encodeURIComponent(deckId)}/exports/live.txt?owner_revision=${ownerRevision}${deckListRevision == null ? '' : `&deck_list_revision=${deckListRevision}`}`;

// A Published Deck's Live export: only the token and the snapshot version are sent, and no cookie.
export async function getPublishedLiveExport(token: string, version: number, signal?: AbortSignal): Promise<PublishedLiveExportView> {
  const response = await fetch(`/api/public/decks/${encodeURIComponent(token)}/versions/${version}/exports/live`, { credentials: 'omit', signal });
%(f1)s
  return response.json() as Promise<PublishedLiveExportView>;
}
export const publishedLiveExportDownloadHref = (token: string, version: number) =>
  `/api/public/decks/${encodeURIComponent(token)}/versions/${version}/exports/live.txt`;
"""


def render(openapi):
    schemas = openapi["components"]["schemas"]
    body = BODY % {"error": gen.error_class('LiveExportError'),
                   "f0": gen.failure_block('LiveExportError', 'LIVE_EXPORT_FAILED'),
                         "f1": gen.failure_block('LiveExportError', 'LIVE_EXPORT_FAILED')}
    return gen.assemble([gen.header("generate_live_export_client"), *gen.DOUBLE.aliases(schemas, NAMES), body])


if __name__ == "__main__":
    gen.main(__name__)
