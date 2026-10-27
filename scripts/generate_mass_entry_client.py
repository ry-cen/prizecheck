"""Generate the Mass entry client module from the API OpenAPI schema."""
import client_generator as gen

TARGET = "web/src/mass_entry_generated.ts"
NAMES = ("MassEntryLineView", "MassEntryView", "PublishedMassEntryView")
# Array elements are always parenthesized here, as the generated file has them.
STYLE = gen.TypeStyle(quote='"', parenthesize_arrays="always")

BODY = """export type MassEntryScope = NonNullable<MassEntryView["scope"]>;

%(error)s
const base = (id: string) => `/api/decks/${encodeURIComponent(id)}/exports/tcgplayer`;
// The API and this client both default to the not-owned copies, the cards to buy (app redesign #181: Buy missing); the
// deck builder's Export offers the whole Deck List as the other choice.
export async function getMassEntryExport(id: string, signal?: AbortSignal, scope: MassEntryScope = 'not_owned'): Promise<MassEntryView> {
  const response = await fetch(`${base(id)}?scope=${scope}`, { credentials: 'same-origin', signal });
%(f0)s
  return response.json() as Promise<MassEntryView>;
}
// The not-owned copies follow the Want List counting setting (#208): a download pinned to a settings revision is refused
// (409 SETTINGS_CHANGED) once the setting has changed.
export const massEntryDownloadHref = (id: string, ownerRevision: number, scope: MassEntryScope = 'not_owned', deckListRevision?: number | null, settingsRevision?: number | null) =>
  `${base(id)}.txt?owner_revision=${ownerRevision}&scope=${scope}${deckListRevision == null ? '' : `&deck_list_revision=${deckListRevision}`}${settingsRevision == null ? '' : `&settings_revision=${settingsRevision}`}`;
export const MASS_ENTRY_DOWNLOAD_NAME = 'tcgplayer-mass-entry.txt';
// A Published Deck's Mass Entry export: only the token and the snapshot version are sent, and no cookie.
const publishedBase = (token: string, version: number) => `/api/public/decks/${encodeURIComponent(token)}/versions/${version}/exports/tcgplayer`;
export async function getPublishedMassEntry(token: string, version: number, signal?: AbortSignal): Promise<PublishedMassEntryView> {
  const response = await fetch(publishedBase(token, version), { credentials: 'omit', signal });
%(f1)s
  return response.json() as Promise<PublishedMassEntryView>;
}
export const publishedMassEntryDownloadHref = (token: string, version: number) => `${publishedBase(token, version)}.txt`;
"""


def render(openapi):
    schemas = openapi["components"]["schemas"]
    body = BODY % {"error": gen.error_class('MassEntryError'),
                   "f0": gen.failure_block('MassEntryError', 'MASS_ENTRY_REQUEST_FAILED'),
                         "f1": gen.failure_block('MassEntryError', 'MASS_ENTRY_REQUEST_FAILED')}
    return gen.assemble([gen.header("generate_mass_entry_client"), *STYLE.aliases(schemas, NAMES), body])


if __name__ == "__main__":
    gen.main(__name__)
