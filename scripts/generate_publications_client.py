"""Generate Publication request and response types from the API OpenAPI schema."""
import client_generator as gen

TARGET = "web/src/publications_generated.ts"
NAMES = ("VisibilityCommand", "PublishCommand", "RevokeCommand", "PublicationStatus", "PublicationResult", "OwnedPublication", "OwnedPublications", "PublicEdition", "PublicIdentity", "PublicIdentityCheck", "PublicChecks", "PublicSnapshot")

BODY = """
%(error)s
%(request)s
export const getPublication = (id: string) => request<PublicationStatus>(`/api/decks/${encodeURIComponent(id)}/publication`, 'GET');
export const publishDeck = (id: string, body: PublishCommand) => request<PublicationResult>(`/api/decks/${encodeURIComponent(id)}/publication`, 'POST', body);
export const republishDeck = (id: string, body: PublishCommand) => request<PublicationResult>(`/api/decks/${encodeURIComponent(id)}/publication`, 'PUT', body);
export const revokeDeck = (id: string, body: RevokeCommand) => request<PublicationResult>(`/api/decks/${encodeURIComponent(id)}/publication`, 'DELETE', body);
export const setPublicationVisibility = (id: string, body: VisibilityCommand) => request<PublicationResult>(`/api/decks/${encodeURIComponent(id)}/publication/visibility`, 'PATCH', body);
export const getOwnedPublications = () => request<OwnedPublications>('/api/publications', 'GET');
export const revokePublication = (token: string, body: RevokeCommand) => request<PublicationResult>(`/api/publications/${encodeURIComponent(token)}`, 'DELETE', body);
export const setPublishedDeckVisibility = (token: string, body: VisibilityCommand) => request<PublicationResult>(`/api/publications/${encodeURIComponent(token)}/visibility`, 'PATCH', body);
export async function getPublicDeckPage(token: string) {
  let robots = 'noindex, nofollow';
  const snapshot = await request<PublicSnapshot>(`/api/public/decks/${encodeURIComponent(token)}`, 'GET', undefined, response => { robots = response.headers.get('x-robots-tag') ?? robots; });
  return { snapshot, robots };
}
export const getPublicDeck = (token: string) => request<PublicSnapshot>(`/api/public/decks/${encodeURIComponent(token)}`, 'GET');
"""


def render(openapi):
    schemas = openapi["components"]["schemas"]
    body = BODY % {"error": gen.error_class("PublicationError"),
                   "request": gen.simple_request("PublicationError", "PUBLICATION_REQUEST_FAILED", on_response=True)}
    return gen.assemble([gen.header("generate_publications_client"), *gen.SINGLE.aliases(schemas, NAMES), body])


if __name__ == "__main__":
    gen.main(__name__)
